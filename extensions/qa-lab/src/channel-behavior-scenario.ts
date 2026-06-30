// Qa Lab plugin module defines reusable channel behavior scenario contracts.
import type {
  QaBusAttachment,
  QaBusConversation,
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
  observeProviderMetadata: () => Promise<ChannelScenarioProviderMetadata | null>;
  restartGateway: (hooks?: ChannelBehaviorScenarioRestartHooks) => Promise<void>;
  sendInbound: (input: ChannelScenarioSendInboundInput) => Promise<QaBusMessage>;
  sendReplyTo: (input: ChannelScenarioSendReplyInput) => Promise<QaBusMessage>;
  waitForNoOutbound: (input: ChannelScenarioWaitForNoOutboundInput) => Promise<void>;
  waitForOutbound: (input: ChannelScenarioWaitForOutboundInput) => Promise<QaBusMessage>;
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
