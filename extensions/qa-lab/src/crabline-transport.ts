// Qa Lab plugin module implements Crabline local-provider transport behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  OPENCLAW_CRABLINE_MANIFEST_PATH,
  startOpenClawCrablineAdapter,
  type OpenClawCrablineChannelDriverSelection,
  type OpenClawCrablineInbound,
  type StartedOpenClawCrablineAdapter,
} from "@openclaw/crabline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isRecord,
  normalizeStringifiedOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { createQaBusState, type QaBusState } from "./bus-state.js";
import { QaSuiteInfraError } from "./errors.js";
import {
  QaStateBackedTransportAdapter,
  waitForQaTransportOutboundSequence,
} from "./qa-transport.js";
import type {
  QaTransportActionName,
  QaTransportGatewayClient,
  QaTransportGatewayConfig,
  QaTransportNativeCommandInput,
  QaTransportOutboundEvent,
  QaTransportOutboundSequenceMatch,
  QaTransportReportParams,
  QaTransportState,
} from "./qa-transport.js";
import type {
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusOutboundMessageInput,
  QaBusSearchMessagesInput,
  QaBusWaitForInput,
} from "./runtime-api.js";

const CRABLINE_TRANSPORT_ID = "crabline";
const RECORDER_SYNC_INTERVAL_MS = 50;

type QaCrablineTransportState = QaTransportState & {
  cleanup: () => Promise<void>;
  getOutboundEvents: () => Promise<readonly QaTransportOutboundEvent[]>;
  rememberProviderTarget: (providerTargetKey: string, qaTarget: string) => void;
};

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
      previous = pending[0];
      previous.id = providerMessageId;
      params.messageByProviderId.set(providerKey, previous);
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

async function waitForCrablineReady(params: {
  accountId: string;
  channel: string;
  gateway: QaTransportGatewayClient;
  timeoutMs?: number;
  pollIntervalMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const pollIntervalMs = params.pollIntervalMs ?? 500;
  const startedAt = Date.now();
  let lastAccountStatus = `no ${params.channel} accounts reported`;
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
      const accounts = payload.channelAccounts?.[params.channel] ?? [];
      const account = accounts.find((entry) => entry.accountId === params.accountId) ?? accounts[0];
      lastProbeError = null;
      lastAccountStatus = account
        ? JSON.stringify({
            accountId: account.accountId ?? null,
            running: account.running ?? null,
            restartPending: account.restartPending ?? null,
          })
        : `no ${params.channel} accounts reported`;
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
      `timed out after ${timeoutMs}ms waiting for ${params.channel} ready`,
      `last status: ${lastAccountStatus}`,
      ...(lastProbeError ? [`last probe error: ${lastProbeError}`] : []),
    ].join("; "),
  );
}

async function postCrablineInbound(params: {
  adapter: StartedOpenClawCrablineAdapter;
  providerInbound: OpenClawCrablineInbound;
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
    auditContext: `qa-lab-crabline-${params.adapter.channel}-inbound`,
  });
  try {
    if (!response.ok) {
      throw new Error(
        `Crabline ${params.adapter.channel} inbound injection failed with HTTP ${response.status}.`,
      );
    }
  } finally {
    await release();
  }
}

function createCrablineState(params: {
  adapter: StartedOpenClawCrablineAdapter;
  state: QaBusState;
}): QaCrablineTransportState {
  const baseState = params.state;
  const targetByProviderTarget = new Map<string, string>();
  const telegramMessageByProviderId = new Map<string, QaBusMessage>();
  const pendingTelegramMessagesByChat = new Map<string, QaBusMessage[]>();
  const outboundEvents: QaTransportOutboundEvent[] = [];
  let recorderLineCursor = 0;
  let syncPromise: Promise<void> | null = null;

  const syncRecorder = async () => {
    if (syncPromise) {
      return await syncPromise;
    }
    syncPromise = (async () => {
      const text = await fs
        .readFile(params.adapter.manifest.recorderPath, "utf8")
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return "";
          }
          throw error;
        });
      const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
      for (const line of lines.slice(recorderLineCursor)) {
        const parsed = JSON.parse(line) as unknown;
        if (params.adapter.channel === "telegram") {
          const lifecycle = readTelegramLifecycleEvent({
            cursor: outboundEvents.length + 1,
            event: parsed,
            messageByProviderId: telegramMessageByProviderId,
            pendingByChat: pendingTelegramMessagesByChat,
          });
          if (lifecycle) {
            outboundEvents.push(lifecycle);
          }
        }
        const outbound = params.adapter.createOutboundFromRecorderEvent({
          event: parsed,
          targetByProviderTarget,
        }) as QaBusOutboundMessageInput | null;
        if (outbound) {
          baseState.addOutboundMessage(outbound);
        }
      }
      recorderLineCursor = lines.length;
    })();
    try {
      await syncPromise;
    } finally {
      syncPromise = null;
    }
  };

  const interval = setInterval(() => {
    void syncRecorder().catch(() => undefined);
  }, RECORDER_SYNC_INTERVAL_MS);
  interval.unref?.();

  return {
    async reset() {
      await syncRecorder();
      baseState.reset();
      targetByProviderTarget.clear();
      telegramMessageByProviderId.clear();
      pendingTelegramMessagesByChat.clear();
      outboundEvents.length = 0;
      recorderLineCursor = await fs
        .readFile(params.adapter.manifest.recorderPath, "utf8")
        .then((text) => text.split(/\r?\n/u).filter((line) => line.trim().length > 0).length)
        .catch(() => 0);
    },
    getSnapshot: baseState.getSnapshot.bind(baseState),
    async getOutboundEvents() {
      await syncRecorder();
      return outboundEvents;
    },
    async addInboundMessage(input: QaBusInboundMessageInput) {
      const providerInbound = params.adapter.createInbound({ input });
      targetByProviderTarget.set(providerInbound.providerTargetKey, providerInbound.qaTarget);
      const message = baseState.addInboundMessage({
        ...input,
        conversation: providerInbound.stateConversation,
        ...(providerInbound.threadId ? { threadId: providerInbound.threadId } : {}),
      });
      await postCrablineInbound({
        adapter: params.adapter,
        providerInbound,
      });
      return message;
    },
    rememberProviderTarget(providerTargetKey, qaTarget) {
      targetByProviderTarget.set(providerTargetKey, qaTarget);
    },
    addOutboundMessage: baseState.addOutboundMessage.bind(baseState),
    readMessage: baseState.readMessage.bind(baseState),
    async searchMessages(input: QaBusSearchMessagesInput) {
      await syncRecorder();
      return baseState.searchMessages(input);
    },
    async waitFor(input: QaBusWaitForInput) {
      await syncRecorder();
      return await baseState.waitFor(input);
    },
    async cleanup() {
      clearInterval(interval);
      await syncRecorder();
      await params.adapter.close();
    },
  };
}

class QaCrablineTransport extends QaStateBackedTransportAdapter {
  readonly #adapter: StartedOpenClawCrablineAdapter;
  readonly #selection: OpenClawCrablineChannelDriverSelection;
  readonly #state: QaCrablineTransportState;

  constructor(params: {
    adapter: StartedOpenClawCrablineAdapter;
    selection: OpenClawCrablineChannelDriverSelection;
    state: QaCrablineTransportState;
  }) {
    super({
      id: CRABLINE_TRANSPORT_ID,
      label: `crabline local ${params.selection.channel}`,
      accountId: params.adapter.accountId,
      requiredPluginIds: params.adapter.requiredPluginIds,
      state: params.state,
    });
    this.#adapter = params.adapter;
    this.#selection = params.selection;
    this.#state = params.state;
  }

  createGatewayConfig = (params: { baseUrl: string }): QaTransportGatewayConfig =>
    this.#adapter.createGatewayConfig(params) as QaTransportGatewayConfig;

  waitReady = (params: {
    gateway: QaTransportGatewayClient;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) =>
    waitForCrablineReady({
      ...params,
      accountId: this.#adapter.accountId,
      channel: this.#adapter.channel,
    });

  buildAgentDelivery = ({ target }: { target: string }) => {
    const delivery = this.#adapter.createAgentDelivery({ target });
    this.#state.rememberProviderTarget(delivery.to ?? delivery.replyTo, target);
    return delivery;
  };

  createRuntimeEnvPatch = () => this.#adapter.createChannelDriverSmokeEnv({});

  override async sendNativeCommand(input: QaTransportNativeCommandInput): Promise<void> {
    if (this.#selection.channel !== "telegram") {
      throw new Error(
        `Crabline ${this.#selection.channel} does not support native command injection.`,
      );
    }
    const { command, ...message } = input;
    await this.sendInbound({
      ...message,
      text: `/${command}`,
      nativeCommand: { name: command },
    });
  }

  override async waitForOutboundSequence(input: QaTransportOutboundSequenceMatch) {
    return await waitForQaTransportOutboundSequence({
      input,
      readEvents: () => this.#state.getOutboundEvents(),
    });
  }

  handleAction = async (_params: {
    action: QaTransportActionName;
    args: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => {
    throw new Error(`Crabline local-provider transport does not support ${_params.action} yet.`);
  };

  createReportNotes = (_params: QaTransportReportParams) => [
    `Runs OpenClaw's ${this.#selection.channel} channel plugin against a Crabline local provider server.`,
    "No live channel service or external credential lease is required.",
  ];

  async cleanup() {
    await this.#state.cleanup();
  }
}

export async function createQaCrablineTransportAdapter(params: {
  outputDir: string;
  selection: OpenClawCrablineChannelDriverSelection;
  state?: QaBusState;
}) {
  const recorderPath = path.join(
    params.outputDir,
    "artifacts",
    "crabline",
    `${params.selection.channel}-fake-provider.jsonl`,
  );
  await fs.mkdir(path.dirname(recorderPath), { recursive: true });
  const adapter = await startOpenClawCrablineAdapter({
    channel: params.selection.channel,
    openclawConfig: {},
    recorderPath,
  });
  await fs.writeFile(
    path.join(params.outputDir, OPENCLAW_CRABLINE_MANIFEST_PATH),
    `${JSON.stringify(adapter.manifest, null, 2)}\n`,
    "utf8",
  );

  return new QaCrablineTransport({
    adapter,
    selection: params.selection,
    state: createCrablineState({
      adapter,
      state: params.state ?? createQaBusState(),
    }),
  });
}
