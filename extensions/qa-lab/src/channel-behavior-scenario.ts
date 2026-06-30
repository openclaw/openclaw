import type { QaTransportState } from "./qa-transport.js";
// Qa Lab plugin module defines reusable channel behavior scenario contracts.
import type {
  QaBusAttachment,
  QaBusConversation,
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusThread,
  QaBusToolCall,
} from "./runtime-api.js";

export type ChannelBehaviorScenarioChannel = {
  id: string;
  kind: QaBusConversation["kind"];
  title?: string;
};

export type ChannelBehaviorScenarioRestartHooks = {
  afterStep?: boolean;
  beforeStep?: boolean;
  reason?: string;
};

export type ChannelBehaviorScenarioThreadRequirement = {
  channelId?: string;
  createBeforeStep?: boolean;
  required?: boolean;
  title?: string;
};

export type ChannelBehaviorScenarioReplyRequirement = {
  required?: boolean;
  threadId?: string;
  toMessageId?: string;
  toStepId?: string;
};

export type ChannelBehaviorScenarioInbound = {
  attachments?: QaBusAttachment[];
  senderId?: string;
  senderName?: string;
  text: string;
  threadId?: string;
  threadTitle?: string;
  toolCalls?: QaBusToolCall[];
};

export type ChannelBehaviorScenarioReplyExpectation = {
  kind: "reply";
  conversationId?: string;
  senderId?: string;
  textIncludes?: readonly string[];
  threadId?: string;
  timeoutMs?: number;
};

export type ChannelBehaviorScenarioNoReplyExpectation = {
  kind: "no-reply";
  quietMs?: number;
};

export type ChannelBehaviorScenarioExpectation =
  | ChannelBehaviorScenarioNoReplyExpectation
  | ChannelBehaviorScenarioReplyExpectation;

export type ChannelBehaviorScenarioStepInput = {
  expect: ChannelBehaviorScenarioExpectation;
  id?: string;
  inbound?: ChannelBehaviorScenarioInbound;
  name: string;
  reply?: ChannelBehaviorScenarioReplyRequirement;
  restart?: ChannelBehaviorScenarioRestartHooks;
  thread?: ChannelBehaviorScenarioThreadRequirement;
};

export type ChannelBehaviorScenarioStep = ChannelBehaviorScenarioStepInput & {
  id: string;
};

export type ChannelBehaviorScenarioDefinitionInput = {
  channel: ChannelBehaviorScenarioChannel;
  gatewayConfigPatch?: Record<string, unknown>;
  id: string;
  steps: readonly ChannelBehaviorScenarioStepInput[];
  title?: string;
};

export type ChannelBehaviorScenarioDefinition = Omit<
  ChannelBehaviorScenarioDefinitionInput,
  "steps"
> & {
  steps: readonly ChannelBehaviorScenarioStep[];
};

export type ChannelBehaviorScenarioRequirements = {
  needsGatewayRestart: boolean;
  needsProviderMetadata: boolean;
  needsReplyTargeting: boolean;
  needsThread: boolean;
};

export type ChannelScenarioSendInboundInput = {
  channel?: ChannelBehaviorScenarioChannel;
  message: ChannelBehaviorScenarioInbound;
};

export type ChannelScenarioWaitForOutboundInput = {
  channel?: ChannelBehaviorScenarioChannel;
  expectation: ChannelBehaviorScenarioReplyExpectation;
  sinceIndex?: number;
};

export type ChannelScenarioWaitForNoOutboundInput = {
  quietMs?: number;
  sinceIndex?: number;
};

export type ChannelScenarioCreateThreadInput = {
  channel?: ChannelBehaviorScenarioChannel;
  title?: string;
};

export type ChannelScenarioSendReplyInput = {
  channel?: ChannelBehaviorScenarioChannel;
  replyToMessageId?: string;
  text: string;
  threadId?: string;
};

export type ChannelScenarioProviderMetadata = Record<string, unknown>;

export type ChannelScenarioDriver = {
  createThread: (input: ChannelScenarioCreateThreadInput) => Promise<QaBusThread>;
  getOutboundCursor?: () => number;
  observeProviderMetadata: () => Promise<ChannelScenarioProviderMetadata | null>;
  restartGateway: (hooks?: ChannelBehaviorScenarioRestartHooks) => Promise<void>;
  sendInbound: (input: ChannelScenarioSendInboundInput) => Promise<QaBusMessage>;
  sendReplyTo: (input: ChannelScenarioSendReplyInput) => Promise<QaBusMessage>;
  waitForNoOutbound: (input: ChannelScenarioWaitForNoOutboundInput) => Promise<void>;
  waitForOutbound: (input: ChannelScenarioWaitForOutboundInput) => Promise<QaBusMessage>;
};

export type ChannelBehaviorScenarioStepResult = {
  inbound?: QaBusMessage;
  name: string;
  outbound?: QaBusMessage;
  stepId: string;
  thread?: QaBusThread;
};

export type ChannelBehaviorScenarioRunResult = {
  lastOutbound?: QaBusMessage;
  scenarioId: string;
  steps: ChannelBehaviorScenarioStepResult[];
};

export type QaFlowChannelScenarioDriverParams = {
  createThread?: (input: { channelId: string; title?: string }) => Promise<unknown>;
  sendInboundMessage: (input: QaBusInboundMessageInput) => Promise<QaBusMessage> | QaBusMessage;
  state: QaTransportState;
  waitForNoOutbound: (
    state: QaTransportState,
    timeoutMs?: number,
    options?: { sinceIndex?: number },
  ) => Promise<void>;
  waitForOutboundMessage: (
    state: QaTransportState,
    predicate: (message: QaBusMessage) => boolean,
    timeoutMs?: number,
    options?: { sinceIndex?: number },
  ) => Promise<QaBusMessage>;
};

export function defineChannelBehaviorScenario(
  input: ChannelBehaviorScenarioDefinitionInput,
): ChannelBehaviorScenarioDefinition {
  const id = requireNonEmpty(input.id, "scenario id");
  const channel = normalizeChannel(input.channel);
  if (input.steps.length === 0) {
    throw new Error(`channel behavior scenario ${id} must define at least one step`);
  }
  const seenStepIds = new Set<string>();
  const steps = input.steps.map((step, index) => {
    const stepId = requireNonEmpty(step.id ?? `step-${index + 1}`, `step ${index + 1} id`);
    if (seenStepIds.has(stepId)) {
      throw new Error(`duplicate channel behavior step id: ${stepId}`);
    }
    seenStepIds.add(stepId);
    validateExpectation(step.expect, stepId);
    return {
      ...step,
      id: stepId,
      name: requireNonEmpty(step.name, `step ${stepId} name`),
    };
  });
  return {
    ...input,
    id,
    channel,
    steps,
  };
}

export async function runChannelBehaviorScenario(
  scenario: ChannelBehaviorScenarioDefinition,
  driver: ChannelScenarioDriver,
): Promise<ChannelBehaviorScenarioRunResult> {
  const results: ChannelBehaviorScenarioStepResult[] = [];
  let lastOutbound: QaBusMessage | undefined;

  for (const step of scenario.steps) {
    if (step.reply) {
      throw new Error(
        `channel behavior step ${step.id} declares reply targeting, but runChannelBehaviorScenario does not support reply steps yet`,
      );
    }
    if (step.restart?.beforeStep) {
      await driver.restartGateway(step.restart);
    }

    const thread =
      step.thread?.createBeforeStep === true
        ? await driver.createThread({
            channel: scenario.channel,
            title: step.thread.title,
          })
        : undefined;
    const outboundCursor = driver.getOutboundCursor?.();
    const inboundInput =
      thread && step.inbound && !step.inbound.threadId
        ? {
            ...step.inbound,
            threadId: thread.id,
            ...(thread.title ? { threadTitle: thread.title } : {}),
          }
        : step.inbound;
    const inbound = inboundInput
      ? await driver.sendInbound({
          channel: scenario.channel,
          message: inboundInput,
        })
      : undefined;

    const expectation =
      step.expect.kind === "reply" && thread && !step.expect.threadId
        ? { ...step.expect, threadId: thread.id }
        : step.expect;
    const outbound =
      expectation.kind === "reply"
        ? await driver.waitForOutbound({
            channel: scenario.channel,
            expectation,
            sinceIndex: outboundCursor,
          })
        : undefined;
    if (expectation.kind === "no-reply") {
      await driver.waitForNoOutbound({
        quietMs: expectation.quietMs,
        sinceIndex: outboundCursor,
      });
    }
    if (outbound) {
      lastOutbound = outbound;
    }

    if (step.restart?.afterStep) {
      await driver.restartGateway(step.restart);
    }

    results.push({
      stepId: step.id,
      name: step.name,
      ...(thread ? { thread } : {}),
      ...(inbound ? { inbound } : {}),
      ...(outbound ? { outbound } : {}),
    });
  }

  return {
    scenarioId: scenario.id,
    steps: results,
    ...(lastOutbound ? { lastOutbound } : {}),
  };
}

export function createQaFlowChannelScenarioDriver(
  params: QaFlowChannelScenarioDriverParams,
): ChannelScenarioDriver {
  return {
    async createThread(input) {
      if (!params.createThread) {
        throw new Error("channel scenario driver cannot create threads without createThread");
      }
      const channel = input.channel ?? { id: "qa-room", kind: "channel" as const };
      const payload = await params.createThread({
        channelId: channel.id,
        ...(input.title ? { title: input.title } : {}),
      });
      return readThreadPayload(payload);
    },
    getOutboundCursor() {
      return params.state
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound").length;
    },
    async observeProviderMetadata() {
      return null;
    },
    async restartGateway() {
      throw new Error("channel scenario driver restartGateway is not wired for this flow");
    },
    async sendInbound(input) {
      const channel = input.channel ?? { id: "qa-room", kind: "channel" as const };
      return await params.sendInboundMessage(buildInboundMessageInput(channel, input.message));
    },
    async sendReplyTo() {
      throw new Error("channel scenario driver sendReplyTo is not wired for this flow");
    },
    async waitForNoOutbound(input) {
      await params.waitForNoOutbound(params.state, input.quietMs, { sinceIndex: input.sinceIndex });
    },
    async waitForOutbound(input) {
      const channel = input.channel ?? { id: "qa-room", kind: "channel" as const };
      return await params.waitForOutboundMessage(
        params.state,
        (message) =>
          matchesChannelBehaviorOutbound(message, {
            channel,
            expectation: input.expectation,
          }),
        input.expectation.timeoutMs,
        { sinceIndex: input.sinceIndex },
      );
    },
  };
}

export function collectChannelBehaviorScenarioRequirements(
  scenario: ChannelBehaviorScenarioDefinition,
): ChannelBehaviorScenarioRequirements {
  return {
    needsGatewayRestart: scenario.steps.some(
      (step) => step.restart?.beforeStep === true || step.restart?.afterStep === true,
    ),
    needsProviderMetadata: scenario.steps.some(
      (step) => step.inbound?.toolCalls && step.inbound.toolCalls.length > 0,
    ),
    needsReplyTargeting: scenario.steps.some((step) => step.reply?.required === true),
    needsThread: scenario.steps.some(
      (step) =>
        step.thread?.required === true ||
        step.thread?.createBeforeStep === true ||
        Boolean(step.inbound?.threadId) ||
        Boolean(step.reply?.threadId) ||
        (step.expect.kind === "reply" && Boolean(step.expect.threadId)),
    ),
  };
}

export function channelBehaviorTarget(
  channel: ChannelBehaviorScenarioChannel,
  options: { threadId?: string } = {},
): string {
  const normalized = normalizeChannel(channel);
  const threadId = options.threadId?.trim();
  if (threadId) {
    if (normalized.kind !== "channel") {
      throw new Error("only channel scenarios can target thread replies");
    }
    return `thread:${normalized.id}/${threadId}`;
  }
  if (normalized.kind === "direct") {
    return `dm:${normalized.id}`;
  }
  return `${normalized.kind}:${normalized.id}`;
}

export function channelBehaviorConversation(
  channel: ChannelBehaviorScenarioChannel,
): QaBusConversation {
  const normalized = normalizeChannel(channel);
  return {
    id: normalized.id,
    kind: normalized.kind,
    ...(normalized.title ? { title: normalized.title } : {}),
  };
}

export function channelBehaviorInboundMessage(
  scenario: ChannelBehaviorScenarioDefinition,
  step: ChannelBehaviorScenarioStep,
): ChannelBehaviorScenarioInbound & { conversation: QaBusConversation; senderId: string } {
  if (!step.inbound) {
    throw new Error(`channel behavior step ${step.id} does not define inbound message input`);
  }
  return {
    ...step.inbound,
    conversation: channelBehaviorConversation(scenario.channel),
    senderId: step.inbound.senderId?.trim() || "qa-operator",
  };
}

export function matchesChannelBehaviorOutbound(
  message: QaBusMessage,
  params: {
    channel: ChannelBehaviorScenarioChannel;
    expectation: ChannelBehaviorScenarioReplyExpectation;
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

function buildInboundMessageInput(
  channel: ChannelBehaviorScenarioChannel,
  message: ChannelBehaviorScenarioInbound,
) {
  return {
    ...message,
    conversation: channelBehaviorConversation(channel),
    senderId: message.senderId?.trim() || "qa-operator",
  };
}

function readThreadPayload(payload: unknown): QaBusThread {
  if (!isRecord(payload) || !isRecord(payload.thread)) {
    throw new Error("channel scenario thread-create action did not return a thread");
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
    throw new Error("channel scenario thread-create action returned an invalid thread");
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

function normalizeChannel(channel: ChannelBehaviorScenarioChannel): ChannelBehaviorScenarioChannel {
  return {
    ...channel,
    id: requireNonEmpty(channel.id, "channel id"),
  };
}

function validateExpectation(expectation: ChannelBehaviorScenarioExpectation, stepId: string) {
  if (expectation.kind === "no-reply") {
    return;
  }
  if (expectation.textIncludes?.some((needle) => needle.length === 0)) {
    throw new Error(`channel behavior step ${stepId} has an empty reply text expectation`);
  }
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`channel behavior ${label} is required`);
  }
  return trimmed;
}
