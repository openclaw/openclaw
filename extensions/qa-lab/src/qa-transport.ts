// Qa Lab plugin module implements qa transport behavior.
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { QaProviderMode } from "./model-selection.js";
import { extractQaFailureReplyText } from "./reply-failure.js";
import type {
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusOutboundMessageInput,
  QaBusReadMessageInput,
  QaBusSearchMessagesInput,
  QaBusStateSnapshot,
  QaBusWaitForInput,
} from "./runtime-api.js";

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

type QaTransportFailureCursorSpace = "all" | "outbound";

type QaTransportFailureAssertionOptions = {
  sinceIndex?: number;
  cursorSpace?: QaTransportFailureCursorSpace;
};

export type QaTransportOutboundMatch = {
  conversation?: QaBusInboundMessageInput["conversation"];
  senderId?: string;
  sinceIndex?: number;
  textIncludes?: string;
  threadId?: string;
  timeoutMs?: number;
};

export type QaTransportWaitForNoOutboundInput = {
  quietMs?: number;
  sinceIndex?: number;
};

export type QaTransportNativeCommandInput = Omit<
  QaBusInboundMessageInput,
  "nativeCommand" | "text"
> & {
  command: string;
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
  reset: () => Promise<void>;
  sendInbound: (input: QaBusInboundMessageInput) => Promise<QaBusMessage>;
  sendNativeCommand: (input: QaTransportNativeCommandInput) => Promise<void>;
  waitForNoOutbound: (input?: QaTransportWaitForNoOutboundInput) => Promise<void>;
  waitForOutbound: (input: QaTransportOutboundMatch) => Promise<QaBusMessage>;
  createGatewayConfig: (params: { baseUrl: string }) => QaTransportGatewayConfig;
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

  async reset() {
    await this.state.reset();
  }

  async sendInbound(input: QaBusInboundMessageInput) {
    return await this.state.addInboundMessage(input);
  }

  async sendNativeCommand(_input: QaTransportNativeCommandInput): Promise<void> {
    throw new Error(`${this.label} does not support native commands.`);
  }

  async waitForNoOutbound(input: QaTransportWaitForNoOutboundInput = {}) {
    const quietMs = resolveTimerTimeoutMs(input.quietMs, 1_200, 0);
    await sleep(quietMs);
    assertNoFailureReplies(this.state, {
      sinceIndex: input.sinceIndex,
      cursorSpace: "outbound",
    });
    const observed = this.outboundSince(input.sinceIndex);
    if (observed.length > 0) {
      const summary = observed.map((message) => `${message.id}:${message.text}`).join("\n");
      throw new Error(`expected no outbound messages for ${quietMs}ms, saw:\n${summary}`);
    }
  }

  async waitForOutbound(input: QaTransportOutboundMatch) {
    return await waitForQaTransportCondition(() => {
      assertNoFailureReplies(this.state, {
        sinceIndex: input.sinceIndex,
        cursorSpace: "outbound",
      });
      return this.outboundSince(input.sinceIndex).find((message) => {
        if (input.conversation && message.conversation.id !== input.conversation.id) {
          return false;
        }
        if (input.conversation && message.conversation.kind !== input.conversation.kind) {
          return false;
        }
        if (input.senderId && message.senderId !== input.senderId) {
          return false;
        }
        if (input.threadId && message.threadId !== input.threadId) {
          return false;
        }
        return !input.textIncludes || message.text.includes(input.textIncludes);
      });
    }, input.timeoutMs);
  }

  private outboundSince(sinceIndex = 0) {
    return this.state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound")
      .slice(sinceIndex);
  }
}
