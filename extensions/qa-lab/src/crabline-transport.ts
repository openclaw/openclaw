import fs from "node:fs/promises";
import path from "node:path";
import {
  createOpenClawCrablineChannelReportNotes,
  runOpenClawCrablineProviderReadiness,
  startOpenClawCrablineAdapter,
  type OpenClawCrablineChannelDriverSelection,
  type OpenClawCrablineInbound,
  type StartedOpenClawCrablineCorrelatedAdapter,
} from "@openclaw/crabline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  QaBusInboundMessageInput,
  QaBusMessage,
} from "openclaw/plugin-sdk/qa-channel-protocol";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isRecord,
  normalizeStringifiedOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { createQaBusState, type QaBusState } from "./bus-state.js";
import { startCrablineDiscordReplies } from "./crabline-discord-replies.js";
import {
  createCrablineProviderCorrelation,
  createCrablineProviderDelivery,
  createCrablineProviderInboundInput,
  resolveCrablineStateConversation,
  resolveDiscordQaId,
} from "./crabline-provider-targets.js";
import { createCrablineSlackIngress } from "./crabline-slack-ingress.js";
import { readQaJsonResponse } from "./ignored-response-body.js";
import { buildQaConversationTarget, parseQaTarget } from "./qa-bus-protocol.js";
import {
  createQaTransportStateMethods,
  sendQaTransportNativeCommand,
  type QaTransportAdapter,
  type QaTransportGatewayConfig,
  type QaTransportOutboundEvent,
  type QaTransportPolicy,
  type QaTransportState,
  waitForQaTransportAccountReady,
  waitForQaTransportOutboundSequence,
} from "./qa-transport.js";

type QaCrablineTransportState = QaTransportState & {
  slackIngress?: ReturnType<typeof createCrablineSlackIngress>;
  discordReplies?: Awaited<ReturnType<typeof startCrablineDiscordReplies>>;
  cleanup: () => Promise<void>;
  getOutboundEvents: () => Promise<readonly QaTransportOutboundEvent[]>;
  observeEvent: (event: unknown) => void;
  rememberProviderTarget: (providerTargetKey: string, target: QaCrablineTarget) => void;
  resetTransport: () => void;
};

type QaCrablineTarget = Pick<QaBusInboundMessageInput, "conversation" | "threadId">;

function qaTargetForInput(input: QaBusInboundMessageInput): QaCrablineTarget {
  return {
    conversation: { ...input.conversation },
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
}

function normalizeCrablineSignalGatewayConfig(config: OpenClawConfig): OpenClawConfig {
  const signal = config.channels?.signal as unknown;
  if (!isRecord(signal)) {
    return config;
  }
  const httpUrl = readStringValue(signal.httpUrl);
  if (!httpUrl) {
    return config;
  }

  // Crabline still emits the retired Signal transport fields. Keep that dependency detail at
  // this adapter boundary so the Gateway receives only the account-owned canonical shape.
  const canonicalSignal = { ...signal };
  delete canonicalSignal.apiMode;
  delete canonicalSignal.autoStart;
  delete canonicalSignal.httpUrl;
  return {
    ...config,
    channels: {
      ...config.channels,
      signal: {
        ...canonicalSignal,
        transport: {
          kind: "external-native",
          url: httpUrl,
        },
      },
    },
  } as OpenClawConfig;
}

const TELEGRAM_LIFECYCLE_METHOD_RE = /\/(sendMessage|editMessageText|deleteMessage)$/u;

function readTelegramLifecycleEvent(params: {
  cursor: number;
  event: unknown;
  messageByProviderId: Map<string, QaBusMessage>;
  pendingByChat: Map<string, QaBusMessage[]>;
}): QaTransportOutboundEvent | null {
  if (!isRecord(params.event) || params.event.type !== "api") {
    return null;
  }
  // Rejected API calls are recorded too; they must not consume pending IDs or cursors.
  if (params.event.accepted !== true) {
    return null;
  }
  const pathValue = readStringValue(params.event.path);
  const method = pathValue ? TELEGRAM_LIFECYCLE_METHOD_RE.exec(pathValue)?.[1] : undefined;
  if (!method || !isRecord(params.event.body)) {
    return null;
  }
  const chatId = normalizeStringifiedOptionalString(params.event.body.chat_id);
  if (!chatId) {
    return null;
  }
  const providerMessageId = normalizeStringifiedOptionalString(params.event.body.message_id);
  const providerKey = providerMessageId ? `${chatId}:${providerMessageId}` : null;
  let previous = providerKey ? params.messageByProviderId.get(providerKey) : undefined;
  if (!previous && providerKey && providerMessageId) {
    const pending = params.pendingByChat.get(chatId) ?? [];
    if (pending.length === 1) {
      const pendingMessage = pending[0];
      if (!pendingMessage) {
        return null;
      }
      previous = pendingMessage;
      pendingMessage.id = providerMessageId;
      params.messageByProviderId.set(providerKey, pendingMessage);
      params.pendingByChat.delete(chatId);
    }
  }
  const text = readStringValue(params.event.body.text) ?? previous?.text ?? "";
  if (!text && method !== "deleteMessage") {
    return null;
  }
  const threadId =
    normalizeStringifiedOptionalString(params.event.body.message_thread_id) ?? previous?.threadId;
  const message: QaBusMessage = {
    id: providerMessageId ?? previous?.id ?? `crabline-${params.cursor}`,
    accountId: "default",
    direction: "outbound",
    conversation: {
      id: chatId,
      kind: chatId.startsWith("-") ? "group" : "direct",
    },
    senderId: "openclaw",
    senderName: "OpenClaw QA",
    text,
    timestamp: Date.now(),
    ...(threadId ? { threadId } : {}),
    ...(method === "deleteMessage" ? { deleted: true } : {}),
    ...(method === "editMessageText" ? { editedAt: Date.now() } : {}),
    reactions: [],
  };
  if (method === "sendMessage") {
    const pending = params.pendingByChat.get(chatId) ?? [];
    pending.push(message);
    params.pendingByChat.set(chatId, pending);
  } else if (providerKey) {
    params.messageByProviderId.set(providerKey, message);
  }
  return {
    cursor: params.cursor,
    kind: method === "sendMessage" ? "sent" : method === "editMessageText" ? "edited" : "deleted",
    message,
  };
}

async function postCrablineInbound(params: {
  adapter: StartedOpenClawCrablineCorrelatedAdapter;
  providerInbound: OpenClawCrablineInbound;
  signal?: AbortSignal;
}) {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.adapter.manifest.endpoints.adminInboundUrl,
    init: {
      body: JSON.stringify(params.providerInbound.providerBody),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": params.adapter.manifest.adminToken,
      },
      method: "POST",
    },
    policy: { allowPrivateNetwork: true },
    ...(params.signal ? { signal: params.signal, timeoutMs: 15_000 } : {}),
    auditContext: `qa-lab-crabline-${params.adapter.channel}-inbound`,
  });
  const label = `Crabline ${params.adapter.channel} inbound injection failed`;
  const result = await readQaJsonResponse<unknown>(response, release, label);
  let providerMessageId: string | undefined;
  if (params.adapter.channel === "matrix" && isRecord(result) && isRecord(result.event)) {
    providerMessageId = readStringValue(result.event.event_id);
  } else if (params.adapter.channel === "slack" && isRecord(result) && isRecord(result.message)) {
    providerMessageId = readStringValue(result.message.ts);
  } else if (params.adapter.channel === "discord" && isRecord(result) && isRecord(result.message)) {
    providerMessageId = readStringValue(result.message.id);
  } else if (
    params.adapter.channel === "telegram" &&
    isRecord(result) &&
    isRecord(result.update) &&
    isRecord(result.update.message)
  ) {
    providerMessageId = normalizeStringifiedOptionalString(result.update.message.message_id);
  }
  return { providerMessageId, response: result };
}

async function createCrablineState(params: {
  adapter: StartedOpenClawCrablineCorrelatedAdapter;
  state: QaBusState;
}): Promise<QaCrablineTransportState> {
  const baseState = params.state;
  const slackIngress =
    params.adapter.manifest.provider === "slack"
      ? createCrablineSlackIngress(params.adapter.manifest.signingSecret)
      : undefined;
  const targetByProviderTarget = new Map<string, QaCrablineTarget>();
  const telegramMessageByProviderId = new Map<string, QaBusMessage>();
  const pendingTelegramMessagesByChat = new Map<string, QaBusMessage[]>();
  const outboundEvents: QaTransportOutboundEvent[] = [];
  const discordTargets = new Map<string, QaCrablineTarget>();
  const discordReplies = await startCrablineDiscordReplies({ ...params, targets: discordTargets });
  const resetTransport = () => {
    targetByProviderTarget.clear();
    telegramMessageByProviderId.clear();
    pendingTelegramMessagesByChat.clear();
    outboundEvents.length = 0;
    discordTargets.clear();
    discordReplies?.reset();
  };

  return {
    ...(slackIngress ? { slackIngress } : {}),
    ...(discordReplies ? { discordReplies } : {}),
    reset() {
      resetTransport();
      baseState.reset();
    },
    resetTransport,
    getSnapshot: baseState.getSnapshot.bind(baseState),
    async getOutboundEvents() {
      return outboundEvents;
    },
    observeEvent(event) {
      if (params.adapter.channel === "telegram") {
        const lifecycle = readTelegramLifecycleEvent({
          cursor: outboundEvents.length + 1,
          event,
          messageByProviderId: telegramMessageByProviderId,
          pendingByChat: pendingTelegramMessagesByChat,
        });
        if (lifecycle) {
          outboundEvents.push(lifecycle);
        }
      }
      const normalizedEvent =
        params.adapter.channel === "telegram" &&
        isRecord(event) &&
        isRecord(event.body) &&
        normalizeStringifiedOptionalString(event.body.chat_id)
          ? {
              ...event,
              body: {
                ...event.body,
                chat_id: normalizeStringifiedOptionalString(event.body.chat_id),
              },
            }
          : event;
      const observation = params.adapter.createOutboundObservation({ event: normalizedEvent });
      if (!observation) {
        return;
      }
      const target = observation.providerTargetKeys
        .map((key) => targetByProviderTarget.get(key))
        .find((candidate) => candidate !== undefined);
      const destination = target
        ? {
            to: buildQaConversationTarget({
              chatType: target.conversation.kind,
              conversationId: target.conversation.id,
            }),
            threadId: target.threadId,
          }
        : observation.fallbackTarget
          ? { to: observation.fallbackTarget }
          : undefined;
      if (destination) {
        const replyToId =
          params.adapter.channel === "discord" &&
          isRecord(event) &&
          isRecord(event.body) &&
          isRecord(event.body.message_reference)
            ? readStringValue(event.body.message_reference.message_id)
            : undefined;
        if (params.adapter.channel === "discord" && isRecord(event)) {
          const channelId = readStringValue(event.path)?.match(
            /^\/api\/v10\/channels\/(\d+)\/messages$/u,
          )?.[1];
          if (channelId) {
            const parsed = parseQaTarget(destination.to);
            discordTargets.set(
              channelId,
              target ?? {
                conversation: { id: parsed.conversationId, kind: parsed.chatType },
                ...(parsed.threadId ? { threadId: parsed.threadId } : {}),
              },
            );
          }
        }
        baseState.addOutboundMessage({
          accountId: observation.accountId,
          senderId: observation.senderId,
          senderName: observation.senderName,
          text: observation.text,
          ...(replyToId ? { replyToId } : {}),
          ...destination,
        });
      }
    },
    async addInboundMessage(input: QaBusInboundMessageInput) {
      const providerInbound = params.adapter.createInbound({
        input: createCrablineProviderInboundInput(params.adapter, input),
      });
      const receive = async (signal?: AbortSignal) => {
        const ingress = await postCrablineInbound({
          adapter: params.adapter,
          providerInbound,
          signal,
        });
        // Install the confirmed provider route before a webhook can produce an immediate reply.
        targetByProviderTarget.set(
          params.adapter.resolveInboundProviderTargetKey({
            inbound: providerInbound,
            response: ingress.response,
          }),
          qaTargetForInput(input),
        );
        return ingress;
      };
      const ingress = slackIngress
        ? await slackIngress.forward(async (signal) => {
            const value = await receive(signal);
            return { event: isRecord(value.response) ? value.response.event : undefined, value };
          })
        : await receive();
      return baseState.addInboundMessage(
        {
          ...input,
          conversation: resolveCrablineStateConversation({
            adapter: params.adapter,
            input,
            providerInbound,
          }),
        },
        ingress.providerMessageId,
      );
    },
    rememberProviderTarget(providerTargetKey, target) {
      targetByProviderTarget.set(providerTargetKey, target);
    },
    addOutboundMessage: baseState.addOutboundMessage.bind(baseState),
    readMessage: baseState.readMessage.bind(baseState),
    searchMessages: baseState.searchMessages.bind(baseState),
    waitFor: baseState.waitFor.bind(baseState),
    async cleanup() {
      await slackIngress?.cleanup();
      await discordReplies?.cleanup();
      await params.adapter.close();
    },
  };
}

function createQaCrablineTransport(params: {
  adapter: StartedOpenClawCrablineCorrelatedAdapter;
  readiness: Awaited<ReturnType<typeof runOpenClawCrablineProviderReadiness>>;
  transportPolicy?: QaTransportPolicy;
  selection: OpenClawCrablineChannelDriverSelection;
  state: QaCrablineTransportState;
}) {
  const { adapter, readiness, selection, transportPolicy, state } = params;
  const stateMethods = createQaTransportStateMethods({ state, accountId: adapter.accountId });
  const hooks: Pick<
    QaTransportAdapter,
    | "prepareFlow"
    | "cleanup"
    | "sendNativeCommand"
    | "waitForOutboundSequence"
    | "waitForCompletedReply"
  > = {};
  let releaseDiscordQaApiBase: (() => void) | undefined;
  if (params.state.slackIngress) {
    hooks.prepareFlow = params.state.slackIngress.prepareFlow;
    hooks.cleanup = params.state.slackIngress.cleanup;
  }
  if (state.discordReplies && params.adapter.manifest.provider === "discord") {
    const { apiBaseUrl, waitForCompletedReply } = state.discordReplies;
    hooks.waitForCompletedReply = waitForCompletedReply;
    const manifest = params.adapter.manifest;
    let prepared:
      | Promise<
          ReturnType<
            typeof import("./live-transports/discord/scenario-environment.js").createDiscordQaScenarioEnvironment
          >
        >
      | undefined;
    const prepareEnvironment = () => {
      prepared ??= (async () => {
        const scenarioRuntime = await import("./live-transports/discord/discord-live.runtime.js");
        releaseDiscordQaApiBase = scenarioRuntime.registerDiscordQaApiBase({
          apiBaseUrl,
          tokens: [manifest.botToken, manifest.driverBotToken],
        });
        const [sutIdentity, driverIdentity] = await Promise.all([
          scenarioRuntime.getCurrentDiscordUser(manifest.botToken),
          scenarioRuntime.getCurrentDiscordUser(manifest.driverBotToken),
        ]);
        const { createDiscordQaScenarioEnvironment } =
          await import("./live-transports/discord/scenario-environment.js");
        return createDiscordQaScenarioEnvironment({
          accountId: params.adapter.accountId,
          driverIdentity,
          runtimeEnv: {
            channelId: manifest.fixture.channelId,
            driverBotToken: manifest.driverBotToken,
            guildId: manifest.fixture.guildId,
            sutApplicationId: manifest.applicationId,
            sutBotToken: manifest.botToken,
            voiceChannelId: manifest.fixture.voiceChannelId,
          },
          sutIdentity,
        });
      })();
      return prepared;
    };
    hooks.prepareFlow = async (input) => (await prepareEnvironment()).prepareFlow(input);
  }
  if (params.selection.channel === "telegram") {
    hooks.sendNativeCommand = (input) => sendQaTransportNativeCommand(stateMethods, input);
    hooks.waitForOutboundSequence = async (input) =>
      await waitForQaTransportOutboundSequence({
        accountId: adapter.accountId,
        input,
        readEvents: () => state.getOutboundEvents(),
      });
  }
  return {
    ...stateMethods,
    ...hooks,
    id: "crabline",
    label: `crabline local ${selection.channel}`,
    accountId: adapter.accountId,
    requiredPluginIds: adapter.requiredPluginIds,
    supportedActions: [],
    resetTransport: state.resetTransport,

    createGatewayConfig: (input: { baseUrl: string }): QaTransportGatewayConfig => {
      const rawConfig = adapter.createGatewayConfig(input) as OpenClawConfig;
      const config =
        selection.channel === "signal"
          ? normalizeCrablineSignalGatewayConfig(rawConfig)
          : rawConfig;
      if (selection.channel === "discord") {
        const discord = config.channels?.discord;
        const senderAllowlist = transportPolicy?.senderAllowlist?.map(resolveDiscordQaId);
        const dmAllowlist = senderAllowlist ?? discord?.allowFrom ?? ["*"];
        const wildcardGuild = discord?.guilds?.["*"];
        const wildcardChannel = wildcardGuild?.channels?.["*"];
        return {
          ...config,
          channels: {
            ...config.channels,
            discord: {
              ...discord,
              ...(transportPolicy?.topLevelReplies ? { replyToMode: "off" as const } : {}),
              allowFrom: [...dmAllowlist],
              ...(dmAllowlist.includes("*") ? {} : { dmPolicy: "allowlist" as const }),
              ...(senderAllowlist ? { groupPolicy: "allowlist" as const } : {}),
              guilds: {
                ...discord?.guilds,
                "*": {
                  ...wildcardGuild,
                  ...(senderAllowlist ? { users: [...senderAllowlist] } : {}),
                  channels: {
                    ...wildcardGuild?.channels,
                    "*": {
                      ...wildcardChannel,
                      ...(transportPolicy?.requireGroupMention ? { requireMention: true } : {}),
                    },
                  },
                },
              },
            },
          },
        } satisfies QaTransportGatewayConfig;
      }
      if (selection.channel !== "telegram") {
        return config as QaTransportGatewayConfig;
      }
      const senderAllowlist = transportPolicy?.senderAllowlist?.map(
        (senderId) => adapter.createAgentDelivery({ target: `dm:${senderId}` }).providerTargetKey,
      );
      if (
        !transportPolicy?.requireGroupMention &&
        !senderAllowlist &&
        !transportPolicy?.topLevelReplies
      ) {
        return config as QaTransportGatewayConfig;
      }
      return {
        ...config,
        channels: {
          ...config.channels,
          telegram: {
            ...config.channels?.telegram,
            ...(transportPolicy?.topLevelReplies ? { replyToMode: "off" as const } : {}),
            ...(senderAllowlist
              ? {
                  allowFrom: [...senderAllowlist],
                  groupAllowFrom: [...senderAllowlist],
                  groupPolicy: "allowlist" as const,
                }
              : {}),
            groups: {
              ...config.channels?.telegram?.groups,
              "*": {
                ...config.channels?.telegram?.groups?.["*"],
                ...(transportPolicy?.requireGroupMention ? { requireMention: true } : {}),
              },
            },
          },
        },
      } as QaTransportGatewayConfig;
    },

    waitReady: (input: Parameters<QaTransportAdapter["waitReady"]>[0]) =>
      waitForQaTransportAccountReady({
        ...input,
        accountId: adapter.accountId,
        channel: adapter.channel,
      }),

    buildAgentDelivery: ({ target, threadId }: { target: string; threadId?: string }) => {
      const parsed = parseQaTarget(target);
      if (parsed.threadId && threadId && parsed.threadId !== threadId) {
        throw new Error("Crabline delivery received conflicting thread targets");
      }
      const logicalTarget = {
        conversation: { id: parsed.conversationId, kind: parsed.chatType },
        threadId: threadId ?? parsed.threadId,
      };
      // Provider-native targets must retain their own classification (for example,
      // Telegram negative group ids and Slack C/G conversation ids). Matrix and
      // Mattermost also require OpenClaw to forward threads separately at the
      // Gateway request boundary instead of passing them into Crabline delivery setup.
      const providerThreadId =
        selection.channel === "matrix" || selection.channel === "mattermost"
          ? undefined
          : logicalTarget.threadId;
      const { delivery, providerTargetKey } = createCrablineProviderDelivery(
        adapter,
        target,
        providerThreadId,
      );
      let deliveryThreadId = logicalTarget.threadId;
      if (providerThreadId === undefined && logicalTarget.threadId) {
        const providerCorrelation = createCrablineProviderCorrelation(adapter, logicalTarget);
        state.rememberProviderTarget(providerTargetKey, {
          conversation: logicalTarget.conversation,
        });
        state.rememberProviderTarget(providerCorrelation.providerTargetKey, logicalTarget);
        if (selection.channel === "mattermost") {
          if (!providerCorrelation.threadId) {
            throw new Error("Crabline Mattermost correlation did not resolve a native thread root");
          }
          deliveryThreadId = providerCorrelation.threadId;
        }
      } else {
        state.rememberProviderTarget(providerTargetKey, logicalTarget);
      }
      return {
        ...delivery,
        ...(deliveryThreadId
          ? {
              threadId:
                selection.channel === "discord"
                  ? resolveDiscordQaId(deliveryThreadId)
                  : deliveryThreadId,
            }
          : {}),
      };
    },

    createRuntimeEnvPatch: () =>
      state.discordReplies
        ? {
            DISCORD_API_URL: state.discordReplies.apiBaseUrl,
          }
        : adapter.createProviderReadinessEnv({}),

    handleAction: async (_params: Parameters<QaTransportAdapter["handleAction"]>[0]) => {
      throw new Error(`Crabline channel-driver transport does not support ${_params.action} yet.`);
    },

    createReportNotes: (_params) => [
      `Runs OpenClaw's ${selection.channel} channel plugin against a Crabline local provider server.`,
      "No live channel service or external credential lease is required.",
    ],

    captureArtifacts: async ({ outputDir }: { outputDir: string }) => {
      await adapter.probe();
      return {
        artifacts: [
          {
            kind: "channel-capability-matrix" as const,
            path: readiness.capabilityMatrixPath,
          },
          {
            kind: "channel-driver-smoke" as const,
            path: readiness.providerReadinessArtifactPath,
          },
        ],
        reportNotes: [
          ...createOpenClawCrablineChannelReportNotes(selection),
          "Provider readiness records the strict startup check before Gateway traffic; the same provider instance passed its final health check.",
          `Full unmodified runtime transcript: ${path.relative(outputDir, adapter.manifest.recorderPath)}.`,
        ],
      };
    },

    async cleanupAfterGatewayStop() {
      releaseDiscordQaApiBase?.();
      await state.cleanup();
    },
  } satisfies QaTransportAdapter & { resetTransport: () => void };
}

export async function createQaCrablineTransportAdapter(params: {
  outputDir: string;
  transportPolicy?: QaTransportPolicy;
  selection: OpenClawCrablineChannelDriverSelection;
  state?: QaBusState;
}) {
  const requiresGroupPolicy =
    params.transportPolicy?.requireGroupMention === true ||
    params.transportPolicy?.senderAllowlist !== undefined;
  if (
    params.selection.channel !== "telegram" &&
    params.selection.channel !== "discord" &&
    requiresGroupPolicy
  ) {
    throw new Error(
      `Crabline ${params.selection.channel} does not support the requested group transport policy; use the Crabline Telegram or Discord bridge, or a live channel adapter`,
    );
  }
  const recorderPath = path.join(
    params.outputDir,
    "artifacts",
    "crabline",
    `${params.selection.channel}-provider-server.jsonl`,
  );
  await fs.mkdir(path.dirname(recorderPath), { recursive: true });
  let observeEvent = (_event: unknown) => {};
  const adapter = await startOpenClawCrablineAdapter({
    channel: params.selection.channel,
    onEvent: (event) => observeEvent(event),
    openclawConfig: {},
    recorderPath,
  });
  // Readiness owns the startup probe; runtime transcripts may contain provider-specific API records.
  try {
    const readiness = await runOpenClawCrablineProviderReadiness({
      adapter,
      outputDir: params.outputDir,
      selection: params.selection,
    });
    const state = await createCrablineState({
      adapter,
      state: params.state ?? createQaBusState(),
    });
    observeEvent = state.observeEvent;
    return createQaCrablineTransport({
      adapter,
      readiness,
      transportPolicy: params.transportPolicy,
      selection: params.selection,
      state,
    });
  } catch (error) {
    try {
      await adapter.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Crabline startup and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

export async function createQaCrablineTransportDefinition(
  params: Parameters<typeof createQaCrablineTransportAdapter>[0],
) {
  const transport = await createQaCrablineTransportAdapter(params);
  const {
    state: _state,
    reset: _reset,
    waitForCondition: _waitForCondition,
    waitForNoOutbound: _waitForNoOutbound,
    waitForOutbound: _waitForOutbound,
    ...definition
  } = transport;
  return definition;
}
