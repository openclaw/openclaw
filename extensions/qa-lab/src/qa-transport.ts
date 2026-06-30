// Qa Lab plugin module implements qa transport behavior.
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { extractToolPayload } from "openclaw/plugin-sdk/tool-payload";
import type { QaProviderMode } from "./model-selection.js";
import type {
  QaBusAttachment,
  QaBusConversation,
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusOutboundMessageInput,
  QaBusReadMessageInput,
  QaBusSearchMessagesInput,
  QaBusStateSnapshot,
  QaBusThread,
  QaBusToolCall,
  QaBusWaitForInput,
} from "./protocol.js";
import { extractQaFailureReplyText } from "./reply-failure.js";

export type QaTransportGatewayClient = {
  call: (
    method: string,
    params?: unknown,
    options?: {
      timeoutMs?: number;
    },
  ) => Promise<unknown>;
};

export type QaTransportActionName = "delete" | "edit" | "react" | "thread-create";

export type QaTransportReportParams = {
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
  isolatedWorkers?: boolean;
};

export type QaTransportGatewayConfig = Pick<OpenClawConfig, "channels" | "messages">;

export type QaTransportState = {
  reset: () => void | Promise<void>;
  getSnapshot: () => QaBusStateSnapshot;
  addInboundMessage: (input: QaBusInboundMessageInput) => QaBusMessage | Promise<QaBusMessage>;
  addOutboundMessage: (input: QaBusOutboundMessageInput) => QaBusMessage | Promise<QaBusMessage>;
  readMessage: (
    input: QaBusReadMessageInput,
  ) => QaBusMessage | null | undefined | Promise<QaBusMessage | null | undefined>;
  searchMessages: (input: QaBusSearchMessagesInput) => QaBusMessage[] | Promise<QaBusMessage[]>;
  waitFor: (input: QaBusWaitForInput) => Promise<unknown>;
};

export type QaTransportChannel = {
  id: string;
  kind: QaBusConversation["kind"];
  title?: string;
};

export type QaTransportRestartHooks = {
  afterStep?: boolean;
  beforeStep?: boolean;
  reason?: string;
};

export type QaTransportInbound = {
  attachments?: QaBusAttachment[];
  senderId?: string;
  senderName?: string;
  text: string;
  threadId?: string;
  threadTitle?: string;
  toolCalls?: QaBusToolCall[];
};

export type QaTransportReplyExpectation = {
  kind: "reply";
  conversationId?: string;
  senderId?: string;
  textIncludes?: readonly string[];
  threadId?: string;
  timeoutMs?: number;
};

export type QaTransportCreateThreadInput = {
  cfg?: OpenClawConfig;
  channel?: QaTransportChannel;
  title?: string;
};

export type QaTransportSendInboundInput = {
  channel?: QaTransportChannel;
  message: QaTransportInbound;
};

export type QaTransportWaitForOutboundInput = {
  channel?: QaTransportChannel;
  expectation: QaTransportReplyExpectation;
  sinceIndex?: number;
};

export type QaTransportWaitForNoOutboundInput = {
  quietMs?: number;
  sinceIndex?: number;
};

export type QaTransportSendReplyInput = {
  channel?: QaTransportChannel;
  replyToMessageId?: string;
  text: string;
  threadId?: string;
};

export type QaTransportProviderMetadata = Record<string, unknown>;

type QaTransportFailureCursorSpace = "all" | "outbound";

type QaTransportFailureAssertionOptions = {
  sinceIndex?: number;
  cursorSpace?: QaTransportFailureCursorSpace;
};

export type QaTransportCapabilities = {
  sendInboundMessage: QaTransportState["addInboundMessage"];
  injectOutboundMessage: QaTransportState["addOutboundMessage"];
  waitForOutboundMessage: (input: QaBusWaitForInput) => Promise<unknown>;
  getNormalizedMessageState: () => QaBusStateSnapshot;
  resetNormalizedMessageState: () => Promise<void>;
  readNormalizedMessage: QaTransportState["readMessage"];
  executeGenericAction: (params: {
    action: QaTransportActionName;
    args: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Promise<unknown>;
  waitForReady: (params: {
    gateway: QaTransportGatewayClient;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) => Promise<void>;
  waitForCondition: <T>(
    check: () => T | Promise<T | null | undefined> | null | undefined,
    timeoutMs?: number,
    intervalMs?: number,
  ) => Promise<T>;
  assertNoFailureReplies: (options?: QaTransportFailureAssertionOptions) => void;
};

export async function waitForQaTransportCondition<T>(
  check: () => T | Promise<T | null | undefined> | null | undefined,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const pollIntervalMs = resolveTimerTimeoutMs(intervalMs, 100, 0);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value !== null && value !== undefined) {
      return value;
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

export function findFailureOutboundMessage(
  state: QaTransportState,
  options?: QaTransportFailureAssertionOptions,
) {
  const cursorSpace = options?.cursorSpace ?? "outbound";
  const observedMessages =
    cursorSpace === "all"
      ? state.getSnapshot().messages.slice(options?.sinceIndex ?? 0)
      : state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .slice(options?.sinceIndex ?? 0);
  return observedMessages.find(
    (message) =>
      message.direction === "outbound" && Boolean(extractQaFailureReplyText(message.text)),
  );
}

function assertNoFailureReplies(
  state: QaTransportState,
  options?: QaTransportFailureAssertionOptions,
) {
  const failureMessage = findFailureOutboundMessage(state, options);
  if (failureMessage) {
    throw new Error(extractQaFailureReplyText(failureMessage.text) ?? failureMessage.text);
  }
}

export function createFailureAwareTransportWaitForCondition(state: QaTransportState) {
  return async function waitForTransportCondition<T>(
    check: () => T | Promise<T | null | undefined> | null | undefined,
    timeoutMs = 15_000,
    intervalMs = 100,
  ): Promise<T> {
    const sinceIndex = state.getSnapshot().messages.length;
    return await waitForQaTransportCondition(
      async () => {
        assertNoFailureReplies(state, {
          sinceIndex,
          cursorSpace: "all",
        });
        const value = await check();
        assertNoFailureReplies(state, {
          sinceIndex,
          cursorSpace: "all",
        });
        return value;
      },
      timeoutMs,
      intervalMs,
    );
  };
}

export type QaTransportAdapter = {
  id: string;
  label: string;
  accountId: string;
  requiredPluginIds: readonly string[];
  supportedActions: readonly QaTransportActionName[];
  state: QaTransportState;
  capabilities: QaTransportCapabilities;
  createThread: (input: QaTransportCreateThreadInput) => Promise<QaBusThread>;
  createGatewayConfig: (params: { baseUrl: string }) => QaTransportGatewayConfig;
  getOutboundCursor: () => number;
  waitReady: (params: {
    gateway: QaTransportGatewayClient;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) => Promise<void>;
  buildAgentDelivery: (params: { target: string }) => {
    channel: string;
    to?: string;
    replyChannel: string;
    replyTo: string;
  };
  createRuntimeEnvPatch?: () => NodeJS.ProcessEnv;
  handleAction: (params: {
    action: QaTransportActionName;
    args: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Promise<unknown>;
  observeProviderMetadata: () => Promise<QaTransportProviderMetadata | null>;
  restartGateway: (hooks?: QaTransportRestartHooks) => Promise<void>;
  sendInbound: (input: QaTransportSendInboundInput) => Promise<QaBusMessage>;
  sendReplyTo: (input: QaTransportSendReplyInput) => Promise<QaBusMessage>;
  waitForNoOutbound: (input: QaTransportWaitForNoOutboundInput) => Promise<void>;
  waitForOutbound: (input: QaTransportWaitForOutboundInput) => Promise<QaBusMessage>;
  createReportNotes: (params: QaTransportReportParams) => string[];
  cleanup?: () => Promise<void>;
};

export abstract class QaStateBackedTransportAdapter implements QaTransportAdapter {
  readonly id: string;
  readonly label: string;
  readonly accountId: string;
  readonly requiredPluginIds: readonly string[];
  readonly supportedActions: readonly QaTransportActionName[];
  readonly state: QaTransportState;
  readonly capabilities: QaTransportCapabilities;

  protected constructor(params: {
    id: string;
    label: string;
    accountId: string;
    requiredPluginIds: readonly string[];
    supportedActions?: readonly QaTransportActionName[];
    state: QaTransportState;
  }) {
    this.id = params.id;
    this.label = params.label;
    this.accountId = params.accountId;
    this.requiredPluginIds = params.requiredPluginIds;
    this.supportedActions = params.supportedActions ?? [];
    this.state = params.state;
    this.capabilities = {
      sendInboundMessage: this.state.addInboundMessage.bind(this.state),
      injectOutboundMessage: this.state.addOutboundMessage.bind(this.state),
      waitForOutboundMessage: this.state.waitFor.bind(this.state),
      getNormalizedMessageState: this.state.getSnapshot.bind(this.state),
      resetNormalizedMessageState: async () => {
        await this.state.reset();
      },
      readNormalizedMessage: this.state.readMessage.bind(this.state),
      executeGenericAction: (paramsValue) => this.handleAction(paramsValue),
      waitForReady: (paramsLocal) => this.waitReady(paramsLocal),
      waitForCondition: createFailureAwareTransportWaitForCondition(this.state),
      assertNoFailureReplies: (options) => {
        assertNoFailureReplies(this.state, options);
      },
    };
  }

  abstract createGatewayConfig: (params: { baseUrl: string }) => QaTransportGatewayConfig;
  abstract waitReady: (params: {
    gateway: QaTransportGatewayClient;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) => Promise<void>;
  abstract buildAgentDelivery: (params: { target: string }) => {
    channel: string;
    to?: string;
    replyChannel: string;
    replyTo: string;
  };
  abstract handleAction: (params: {
    action: QaTransportActionName;
    args: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => Promise<unknown>;
  abstract createReportNotes: (params: QaTransportReportParams) => string[];

  async createThread(input: QaTransportCreateThreadInput): Promise<QaBusThread> {
    if (!this.supportedActions.includes("thread-create")) {
      throw new Error(`${this.label} transport does not support thread-create`);
    }
    if (!input.cfg) {
      throw new Error(`${this.label} transport cannot create threads without gateway config`);
    }
    const channel = input.channel ?? { id: "qa-room", kind: "channel" as const };
    const result = await this.handleAction({
      action: "thread-create",
      args: {
        channelId: channel.id,
        ...(input.title ? { title: input.title } : {}),
      },
      cfg: input.cfg,
      accountId: this.accountId,
    });
    const payload = extractToolPayload(result as Parameters<typeof extractToolPayload>[0]);
    return readQaTransportThreadPayload(payload);
  }

  getOutboundCursor() {
    return this.state.getSnapshot().messages.filter((message) => message.direction === "outbound")
      .length;
  }

  async observeProviderMetadata(): Promise<QaTransportProviderMetadata | null> {
    return null;
  }

  async restartGateway(_hooks?: QaTransportRestartHooks): Promise<void> {
    throw new Error(`${this.label} transport does not support scenario gateway restart`);
  }

  async sendInbound(input: QaTransportSendInboundInput): Promise<QaBusMessage> {
    const channel = input.channel ?? { id: "qa-room", kind: "channel" as const };
    return await this.state.addInboundMessage(
      buildQaTransportInboundMessageInput(channel, input.message),
    );
  }

  async sendReplyTo(_input: QaTransportSendReplyInput): Promise<QaBusMessage> {
    throw new Error(`${this.label} transport does not support scenario reply targeting`);
  }

  async waitForNoOutbound(input: QaTransportWaitForNoOutboundInput): Promise<void> {
    const quietMs = resolveTimerTimeoutMs(input.quietMs, 1_200, 0);
    await sleep(quietMs);
    assertNoFailureReplies(this.state, {
      sinceIndex: input.sinceIndex,
      cursorSpace: "outbound",
    });
    const observedMessages = this.state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound")
      .slice(input.sinceIndex ?? 0);
    if (observedMessages.length > 0) {
      const summary = observedMessages.map((message) => `${message.id}:${message.text}`).join("\n");
      throw new Error(`expected no outbound messages for ${quietMs}ms, saw:\n${summary}`);
    }
  }

  async waitForOutbound(input: QaTransportWaitForOutboundInput): Promise<QaBusMessage> {
    const channel = input.channel ?? { id: "qa-room", kind: "channel" as const };
    const timeoutMs = input.expectation.timeoutMs ?? 15_000;
    return await waitForQaTransportCondition(
      () => {
        assertNoFailureReplies(this.state, {
          sinceIndex: input.sinceIndex,
          cursorSpace: "outbound",
        });
        return this.state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .slice(input.sinceIndex ?? 0)
          .find((message) =>
            matchesQaTransportOutbound(message, {
              channel,
              expectation: input.expectation,
            }),
          );
      },
      timeoutMs,
      100,
    );
  }
}

export function qaTransportChannelConversation(channel: QaTransportChannel): QaBusConversation {
  return {
    id: channel.id,
    kind: channel.kind,
    ...(channel.title ? { title: channel.title } : {}),
  };
}

export function buildQaTransportInboundMessageInput(
  channel: QaTransportChannel,
  message: QaTransportInbound,
): QaBusInboundMessageInput {
  return {
    ...message,
    conversation: qaTransportChannelConversation(channel),
    senderId: message.senderId?.trim() || "qa-operator",
  };
}

export function matchesQaTransportOutbound(
  message: QaBusMessage,
  params: {
    channel: QaTransportChannel;
    expectation: QaTransportReplyExpectation;
  },
): boolean {
  const conversationId = params.expectation.conversationId ?? params.channel.id;
  if (message.direction !== "outbound") {
    return false;
  }
  if (message.conversation.id !== conversationId) {
    return false;
  }
  if (message.conversation.kind !== params.channel.kind) {
    return false;
  }
  if (params.expectation.senderId && message.senderId !== params.expectation.senderId) {
    return false;
  }
  if (params.expectation.threadId && message.threadId !== params.expectation.threadId) {
    return false;
  }
  return (params.expectation.textIncludes ?? []).every((needle) => message.text.includes(needle));
}

function readQaTransportThreadPayload(payload: unknown): QaBusThread {
  if (!isRecord(payload) || !isRecord(payload.thread)) {
    throw new Error("qa transport thread-create action did not return a thread");
  }
  const thread = payload.thread;
  if (
    typeof thread.id !== "string" ||
    typeof thread.accountId !== "string" ||
    typeof thread.conversationId !== "string" ||
    typeof thread.title !== "string" ||
    typeof thread.createdAt !== "number" ||
    typeof thread.createdBy !== "string"
  ) {
    throw new Error("qa transport thread-create action returned an invalid thread");
  }
  return {
    id: thread.id,
    accountId: thread.accountId,
    conversationId: thread.conversationId,
    title: thread.title,
    createdAt: thread.createdAt,
    createdBy: thread.createdBy,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
