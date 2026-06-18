// Qa Lab plugin module implements the Crabline-backed QA transport.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { createQaBusState, type QaBusState } from "./bus-state.js";
import type { QaCrablineChannelDriverSelection } from "./crabline-channel-driver.js";
import { QaSuiteInfraError } from "./errors.js";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "./live-transports/shared/credential-lease.runtime.js";
import { QaStateBackedTransportAdapter } from "./qa-transport.js";
import type {
  QaTransportActionName,
  QaTransportGatewayClient,
  QaTransportGatewayConfig,
  QaTransportReportParams,
  QaTransportState,
} from "./qa-transport.js";
import type { QaBusInboundMessageInput, QaBusMessage } from "./runtime-api.js";

const CRABLINE_TRANSPORT_ID = "crabline";
const CRABLINE_TELEGRAM_CHANNEL_ID = "telegram";
const CRABLINE_TELEGRAM_ACCOUNT_ID = "qa-crabline-sut";
const CRABLINE_TELEGRAM_PROVIDER_ID = "telegram";
const CRABLINE_TELEGRAM_FIXTURE_ID = "qa-crabline-telegram";
const CRABLINE_TELEGRAM_USER_NAME = "openclaw-qa";
const CRABLINE_TELEGRAM_OBSERVE_TIMEOUT_MS = 180_000;
const CRABLINE_TELEGRAM_OBSERVE_IDLE_MS = 1_500;

type CrablineInboundEnvelope = {
  id: string;
  provider?: string;
  raw?: unknown;
  sentAt: string;
  text: string;
  threadId?: string;
};

type CrablineManifestDefinition = {
  configVersion: number;
  fixtures: Array<{
    env?: string[];
    id: string;
    inboundMatch?: Record<string, unknown>;
    mode?: string;
    provider: string;
    retries?: number;
    tags?: string[];
    target: {
      channelId?: string;
      id: string;
      metadata?: Record<string, unknown>;
    };
    timeoutMs?: number;
  }>;
  providers: Record<string, Record<string, unknown>>;
  userName: string;
};

type CrablineProviderContext = {
  config: Record<string, unknown>;
  fixture: CrablineManifestDefinition["fixtures"][number];
  manifestPath: string;
  providerId: string;
  userName: string;
};

type CrablineSendResult = {
  accepted?: boolean;
  messageId: string;
  threadId?: string;
};

export type QaCrablineProviderAdapter = {
  [key: string]: unknown;
  cleanup?: () => Promise<void> | void;
  send: (
    params: CrablineProviderContext & {
      mode: "agent";
      nonce: string;
      text: string;
    },
  ) => Promise<CrablineSendResult>;
  waitForInbound: (
    params: CrablineProviderContext & {
      nonce: string;
      since: string;
      threadId?: string;
      timeoutMs: number;
    },
  ) => Promise<CrablineInboundEnvelope | null>;
};

type TelegramBotIdentity = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
};

type CrablineTelegramRuntime = {
  fetchCredentialLease?: typeof fetch;
  fetchTelegramBotIdentity: (token: string) => Promise<TelegramBotIdentity>;
  provider?: QaCrablineProviderAdapter;
};

type CrablineRuntimeModule = {
  createRegistry: (
    manifest: CrablineManifestDefinition,
    manifestPath: string,
  ) => {
    resolve: (providerId: string, fixtureId: string) => QaCrablineProviderAdapter;
  };
};

type CrablineTelegramCredentials = {
  driverToken: string;
  groupId: string;
  sutToken: string;
};

type CrablineTelegramStateParams = {
  driverIdentity: TelegramBotIdentity;
  fixtureContext: CrablineProviderContext;
  observeIdleMs?: number;
  observeTimeoutMs?: number;
  provider: QaCrablineProviderAdapter;
  state: QaBusState;
};

function resolveRequiredEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for --channel-driver crabline telegram.`);
  }
  return value;
}

function parseTelegramGroupId(value: string) {
  if (!/^-?\d+$/u.test(value)) {
    throw new Error("OPENCLAW_QA_TELEGRAM_GROUP_ID must be a numeric Telegram chat id.");
  }
  return value;
}

function resolveTelegramQaRuntimeEnv(env: NodeJS.ProcessEnv): CrablineTelegramCredentials {
  return {
    driverToken: resolveRequiredEnv(env, "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN"),
    groupId: parseTelegramGroupId(resolveRequiredEnv(env, "OPENCLAW_QA_TELEGRAM_GROUP_ID")),
    sutToken: resolveRequiredEnv(env, "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN"),
  };
}

function parseTelegramPayloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Telegram credential payload must include a non-empty string ${key}.`);
  }
  return value.trim();
}

function parseTelegramCredentialPayload(payload: unknown): CrablineTelegramCredentials {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Telegram credential payload must be an object.");
  }
  const record = payload as Record<string, unknown>;
  return {
    driverToken: parseTelegramPayloadString(record, "driverToken"),
    groupId: parseTelegramGroupId(parseTelegramPayloadString(record, "groupId")),
    sutToken: parseTelegramPayloadString(record, "sutToken"),
  };
}

async function callTelegramApi<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: `https://api.telegram.org/bot${token}/${method}`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : "{}",
    },
    timeoutMs: 15_000,
    policy: { hostnameAllowlist: ["api.telegram.org"] },
  });
  try {
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!response.ok || payload.ok !== true || payload.result === undefined) {
      throw new Error(
        `Telegram ${method} failed (${response.status}): ${payload.description ?? response.statusText}`,
      );
    }
    return payload.result;
  } finally {
    await release();
  }
}

async function fetchTelegramBotIdentity(token: string) {
  return await callTelegramApi<TelegramBotIdentity>(token, "getMe");
}

async function loadCrablineRuntime(): Promise<CrablineRuntimeModule> {
  // Keep this non-static so production builds do not bundle Crabline; QA host
  // runs resolve the devDependency at runtime only when this driver is selected.
  const packageName = ["crab", "line"].join("");
  return (await import(packageName)) as CrablineRuntimeModule;
}

function createTelegramManifest(params: {
  driverToken: string;
  groupId: string;
  outputDir: string;
}) {
  const recorderPath = path.join(
    params.outputDir,
    "artifacts",
    "crabline",
    "telegram-recorder.jsonl",
  );
  return {
    manifest: {
      configVersion: 1,
      fixtures: [
        {
          env: [],
          id: CRABLINE_TELEGRAM_FIXTURE_ID,
          inboundMatch: {
            author: "assistant",
            nonce: "ignore",
            strategy: "contains",
          },
          mode: "agent",
          provider: CRABLINE_TELEGRAM_PROVIDER_ID,
          retries: 0,
          tags: [],
          target: {
            channelId: params.groupId,
            id: params.groupId,
            metadata: {},
          },
          timeoutMs: CRABLINE_TELEGRAM_OBSERVE_TIMEOUT_MS,
        },
      ],
      providers: {
        [CRABLINE_TELEGRAM_PROVIDER_ID]: {
          adapter: "telegram",
          capabilities: ["probe", "send", "roundtrip", "agent"],
          env: [],
          platform: "telegram",
          status: "active",
          telegram: {
            botToken: params.driverToken,
            mode: "polling",
            recorder: {
              path: recorderPath,
            },
            webhook: {
              host: "127.0.0.1",
              path: "/telegram/webhook",
              port: 0,
            },
          },
        },
      },
      userName: CRABLINE_TELEGRAM_USER_NAME,
    } satisfies CrablineManifestDefinition,
    manifestPath: path.join(params.outputDir, "crabline-runtime.json"),
  };
}

function createFixtureContext(params: {
  manifest: CrablineManifestDefinition;
  manifestPath: string;
}): CrablineProviderContext {
  const fixture = params.manifest.fixtures.find(
    (entry) => entry.id === CRABLINE_TELEGRAM_FIXTURE_ID,
  );
  const config = params.manifest.providers[CRABLINE_TELEGRAM_PROVIDER_ID];
  if (!fixture || !config) {
    throw new Error("Crabline Telegram manifest is missing its runtime fixture/provider.");
  }
  return {
    config,
    fixture,
    manifestPath: params.manifestPath,
    providerId: CRABLINE_TELEGRAM_PROVIDER_ID,
    userName: params.manifest.userName,
  };
}

async function waitForTelegramReady(params: {
  accountId: string;
  gateway: QaTransportGatewayClient;
  timeoutMs?: number;
  pollIntervalMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const pollIntervalMs = params.pollIntervalMs ?? 500;
  const startedAt = Date.now();
  let lastAccountStatus = "no telegram accounts reported";
  let lastProbeError: string | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = (await params.gateway.call(
        "channels.status",
        { probe: false, timeoutMs: 2_000 },
        { timeoutMs: 5_000 },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            running?: boolean;
            restartPending?: boolean;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.[CRABLINE_TELEGRAM_CHANNEL_ID] ?? [];
      const account = accounts.find((entry) => entry.accountId === params.accountId) ?? accounts[0];
      lastProbeError = null;
      lastAccountStatus = account
        ? JSON.stringify({
            accountId: account.accountId ?? null,
            running: account.running ?? null,
            restartPending: account.restartPending ?? null,
          })
        : "no telegram accounts reported";
      if (account?.running && account.restartPending !== true) {
        return;
      }
    } catch (error) {
      lastProbeError = formatErrorMessage(error);
    }
    await sleep(pollIntervalMs);
  }

  throw new QaSuiteInfraError(
    "transport_ready_timeout",
    [
      `timed out after ${timeoutMs}ms waiting for telegram ready`,
      `last status: ${lastAccountStatus}`,
      ...(lastProbeError ? [`last probe error: ${lastProbeError}`] : []),
    ].join("; "),
  );
}

function targetForConversation(message: QaBusMessage) {
  return `${message.conversation.kind === "direct" ? "dm" : "channel"}:${message.conversation.id}`;
}

function shouldIgnoreObservedMessage(params: {
  accepted: CrablineSendResult;
  driverIdentity: TelegramBotIdentity;
  event: CrablineInboundEnvelope;
  sentText: string;
}) {
  if (params.event.id === params.accepted.messageId) {
    return true;
  }
  if (params.event.text === params.sentText) {
    return true;
  }
  const raw = params.event.raw as
    | {
        author?: { id?: unknown };
        from?: { id?: unknown };
      }
    | undefined;
  const rawAuthorId = raw?.author?.id ?? raw?.from?.id;
  if (
    typeof rawAuthorId !== "string" &&
    typeof rawAuthorId !== "number" &&
    typeof rawAuthorId !== "bigint"
  ) {
    return false;
  }
  return String(rawAuthorId) === String(params.driverIdentity.id);
}

function textForTelegramSend(input: QaBusInboundMessageInput) {
  if (input.conversation.kind !== "direct") {
    return input.text;
  }
  return /(^|\s)@openclaw\b/iu.test(input.text) ? input.text : `@openclaw ${input.text}`;
}

function addObservedOutbound(params: {
  baseState: QaBusState;
  event: CrablineInboundEnvelope;
  inbound: QaBusMessage;
}) {
  params.baseState.addOutboundMessage({
    accountId: params.inbound.accountId,
    to: targetForConversation(params.inbound),
    text: params.event.text,
    senderId: "openclaw",
    senderName: "OpenClaw QA",
    timestamp: Number.isFinite(Date.parse(params.event.sentAt))
      ? Date.parse(params.event.sentAt)
      : Date.now(),
    replyToId: params.inbound.id,
  });
}

function createCrablineTelegramState(params: CrablineTelegramStateParams): QaTransportState & {
  cleanup: () => Promise<void>;
} {
  const baseState = params.state;
  const seenObservedIds = new Set<string>();
  const pendingObservations = new Set<Promise<void>>();
  let closed = false;

  const observeReplies = async (input: {
    accepted: CrablineSendResult;
    inbound: QaBusMessage;
    sentText: string;
    since: string;
  }) => {
    const timeoutMs = params.observeTimeoutMs ?? CRABLINE_TELEGRAM_OBSERVE_TIMEOUT_MS;
    const idleMs = params.observeIdleMs ?? CRABLINE_TELEGRAM_OBSERVE_IDLE_MS;
    const deadline = Date.now() + timeoutMs;
    let sawReply = false;
    let lastReplyAt = 0;
    let since = input.since;

    while (Date.now() < deadline) {
      if (closed) {
        return;
      }
      if (sawReply && Date.now() - lastReplyAt >= idleMs) {
        return;
      }
      const remainingMs = Math.max(1, deadline - Date.now());
      const event = await params.provider.waitForInbound({
        ...params.fixtureContext,
        nonce: input.inbound.id,
        since,
        threadId: input.accepted.threadId,
        timeoutMs: Math.min(500, remainingMs),
      });
      if (!event) {
        continue;
      }
      const sentAtMs = Date.parse(event.sentAt);
      if (Number.isFinite(sentAtMs)) {
        since = new Date(sentAtMs + 1).toISOString();
      }
      if (seenObservedIds.has(event.id)) {
        continue;
      }
      seenObservedIds.add(event.id);
      if (
        shouldIgnoreObservedMessage({
          accepted: input.accepted,
          driverIdentity: params.driverIdentity,
          event,
          sentText: input.sentText,
        })
      ) {
        continue;
      }
      addObservedOutbound({
        baseState,
        event,
        inbound: input.inbound,
      });
      sawReply = true;
      lastReplyAt = Date.now();
    }
  };

  const trackObservation = (observation: Promise<void>) => {
    pendingObservations.add(observation);
    observation
      .catch(() => {})
      .finally(() => {
        pendingObservations.delete(observation);
      });
  };

  return {
    reset() {
      seenObservedIds.clear();
      return baseState.reset();
    },
    getSnapshot: baseState.getSnapshot.bind(baseState),
    async addInboundMessage(input) {
      const inbound = baseState.addInboundMessage(input);
      const sentText = textForTelegramSend(input);
      const since = new Date().toISOString();
      const accepted = await params.provider.send({
        ...params.fixtureContext,
        mode: "agent",
        nonce: inbound.id,
        text: sentText,
      });
      trackObservation(
        observeReplies({
          accepted,
          inbound,
          sentText,
          since,
        }),
      );
      return inbound;
    },
    addOutboundMessage: baseState.addOutboundMessage.bind(baseState),
    readMessage: baseState.readMessage.bind(baseState),
    searchMessages: baseState.searchMessages.bind(baseState),
    waitFor: baseState.waitFor.bind(baseState),
    async cleanup() {
      closed = true;
      await Promise.allSettled(pendingObservations);
      await params.provider.cleanup?.();
    },
  };
}

function createCrablineTelegramGatewayConfig(params: {
  driverIdentity: TelegramBotIdentity;
  groupId: string;
  sutToken: string;
}): QaTransportGatewayConfig {
  return {
    channels: {
      [CRABLINE_TELEGRAM_CHANNEL_ID]: {
        enabled: true,
        defaultAccount: CRABLINE_TELEGRAM_ACCOUNT_ID,
        accounts: {
          [CRABLINE_TELEGRAM_ACCOUNT_ID]: {
            enabled: true,
            botToken: params.sutToken,
            dmPolicy: "disabled",
            mentionPatterns: ["\\b@?openclaw\\b"],
            replyToMode: "first",
            groups: {
              [params.groupId]: {
                groupPolicy: "allowlist",
                allowFrom: [String(params.driverIdentity.id)],
                requireMention: true,
              },
            },
          },
        },
      },
    } as NonNullable<OpenClawConfig["channels"]>,
    messages: {
      groupChat: {
        mentionPatterns: ["\\b@?openclaw\\b"],
        visibleReplies: "automatic",
      },
    },
  };
}

class QaCrablineTelegramTransport extends QaStateBackedTransportAdapter {
  readonly #cleanupCredentialLease: () => Promise<void>;
  readonly #driverIdentity: TelegramBotIdentity;
  readonly #groupId: string;
  readonly #sutToken: string;
  readonly #state: QaTransportState & { cleanup: () => Promise<void> };

  constructor(params: {
    cleanupCredentialLease: () => Promise<void>;
    driverIdentity: TelegramBotIdentity;
    groupId: string;
    state: QaTransportState & { cleanup: () => Promise<void> };
    sutToken: string;
  }) {
    super({
      id: CRABLINE_TRANSPORT_ID,
      label: "crabline + telegram",
      accountId: CRABLINE_TELEGRAM_ACCOUNT_ID,
      requiredPluginIds: [CRABLINE_TELEGRAM_CHANNEL_ID],
      state: params.state,
    });
    this.#cleanupCredentialLease = params.cleanupCredentialLease;
    this.#driverIdentity = params.driverIdentity;
    this.#groupId = params.groupId;
    this.#state = params.state;
    this.#sutToken = params.sutToken;
  }

  createGatewayConfig = (_params: { baseUrl: string }) =>
    createCrablineTelegramGatewayConfig({
      driverIdentity: this.#driverIdentity,
      groupId: this.#groupId,
      sutToken: this.#sutToken,
    });

  waitReady = (params: {
    gateway: QaTransportGatewayClient;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) =>
    waitForTelegramReady({
      ...params,
      accountId: CRABLINE_TELEGRAM_ACCOUNT_ID,
    });

  buildAgentDelivery = () => ({
    channel: CRABLINE_TELEGRAM_CHANNEL_ID,
    replyChannel: CRABLINE_TELEGRAM_CHANNEL_ID,
    replyTo: `telegram:${this.#groupId}`,
  });

  handleAction = async (_params: {
    action: QaTransportActionName;
    args: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => {
    throw new Error("Crabline Telegram transport does not yet expose generic message actions.");
  };

  createReportNotes = (params: QaTransportReportParams) => [
    `Runs against Crabline's Telegram Chat SDK adapter plus a real OpenClaw Telegram gateway account using the ${params.providerMode} provider.`,
    "Driver-side sends and observations go through openclaw/crabline; SUT replies go through the OpenClaw Telegram channel plugin.",
    "Direct QA conversations are represented through the configured Telegram QA group because Telegram bots cannot DM each other.",
  ];

  async cleanup() {
    const results = await Promise.allSettled([
      this.#state.cleanup(),
      this.#cleanupCredentialLease(),
    ]);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) {
      throw rejected.reason;
    }
  }
}

export async function createQaCrablineTransportAdapter(params: {
  env?: NodeJS.ProcessEnv;
  observeIdleMs?: number;
  observeTimeoutMs?: number;
  outputDir: string;
  runtime?: CrablineTelegramRuntime;
  selection: QaCrablineChannelDriverSelection;
  state?: QaBusState;
}) {
  if (params.selection.channel !== CRABLINE_TELEGRAM_CHANNEL_ID) {
    throw new Error(
      `Crabline channel ${params.selection.channel} is not supported by QA Lab transport execution yet.`,
    );
  }

  const env = params.env ?? process.env;
  const credentialLease = await acquireQaCredentialLease({
    env,
    fetchImpl: params.runtime?.fetchCredentialLease,
    kind: "telegram",
    parsePayload: parseTelegramCredentialPayload,
    resolveEnvPayload: () => resolveTelegramQaRuntimeEnv(env),
  });
  const credentialHeartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
  const cleanupCredentialLease = async () => {
    const heartbeatFailure = credentialHeartbeat.getFailure();
    await credentialHeartbeat.stop();
    await credentialLease.release();
    if (heartbeatFailure) {
      throw heartbeatFailure;
    }
  };

  try {
    const { driverToken, groupId, sutToken } = credentialLease.payload;
    const fetchIdentity = params.runtime?.fetchTelegramBotIdentity ?? fetchTelegramBotIdentity;
    const driverIdentity = await fetchIdentity(driverToken);
    if (!driverIdentity.is_bot) {
      throw new Error("OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN did not resolve to a Telegram bot.");
    }

    await fs.mkdir(path.join(params.outputDir, "artifacts", "crabline"), {
      recursive: true,
    });
    const { manifest, manifestPath } = createTelegramManifest({
      driverToken,
      groupId,
      outputDir: params.outputDir,
    });
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const provider =
      params.runtime?.provider ??
      (await loadCrablineRuntime())
        .createRegistry(manifest, manifestPath)
        .resolve(CRABLINE_TELEGRAM_PROVIDER_ID, CRABLINE_TELEGRAM_FIXTURE_ID);
    const fixtureContext = createFixtureContext({
      manifest,
      manifestPath,
    });

    return new QaCrablineTelegramTransport({
      cleanupCredentialLease,
      driverIdentity,
      groupId,
      state: createCrablineTelegramState({
        driverIdentity,
        fixtureContext,
        observeIdleMs: params.observeIdleMs,
        observeTimeoutMs: params.observeTimeoutMs,
        provider,
        state: params.state ?? createQaBusState(),
      }),
      sutToken,
    });
  } catch (error) {
    try {
      await cleanupCredentialLease();
    } catch (cleanupError) {
      throw new Error(
        `Crabline Telegram transport setup failed and credential cleanup failed: ${formatErrorMessage(error)}; cleanup failed: ${formatErrorMessage(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}
