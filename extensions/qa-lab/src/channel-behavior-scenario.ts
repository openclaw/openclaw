// Qa Lab plugin module defines reusable channel behavior scenario contracts.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  QaBusAttachment,
  QaBusConversation,
  QaBusMessage,
  QaBusThread,
  QaBusToolCall,
} from "./protocol.js";
import {
  matchesQaTransportOutbound,
  qaTransportChannelConversation,
  type QaTransportAdapter,
  type QaTransportChannel,
  type QaTransportInbound,
  type QaTransportReplyExpectation,
  type QaTransportRestartHooks,
} from "./qa-transport.js";

export type ChannelBehaviorScenarioChannel = QaTransportChannel;

export type ChannelBehaviorScenarioRestartHooks = QaTransportRestartHooks;

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

export type ChannelBehaviorScenarioInbound = QaTransportInbound;

export type ChannelBehaviorScenarioReplyExpectation = QaTransportReplyExpectation;

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

export type ChannelBehaviorScenarioStepResult = {
  inbound?: QaBusMessage;
  name: string;
  outbound?: QaBusMessage;
  stepId: string;
  thread?: QaBusThread;
};

export type ChannelBehaviorScenarioRunResult = {
  lastReply?: QaBusMessage;
  lastOutbound?: QaBusMessage;
  scenarioId: string;
  steps: ChannelBehaviorScenarioStepResult[];
};

type ChannelBehaviorConversationActorInput =
  | string
  | {
      id?: string;
      name?: string;
    };

type ChannelBehaviorConversationSendInput =
  | string
  | {
      attachments?: QaBusAttachment[];
      text: string;
      toolCalls?: QaBusToolCall[];
    };

type ChannelBehaviorConversationReplyExpectationInput = {
  includes?: readonly string[];
  inThread?: boolean;
  timeoutMs?: number;
};

type ChannelBehaviorConversationNoReplyExpectationInput = {
  windowMs?: number;
};

type ChannelBehaviorConversationTurnExpectationInput = {
  noReply?: ChannelBehaviorConversationNoReplyExpectationInput;
  reply?: ChannelBehaviorConversationReplyExpectationInput;
};

type ChannelBehaviorConversationThreadInput = {
  title?: string;
};

type ChannelBehaviorConversationTurnInput = {
  createThread?: ChannelBehaviorConversationThreadInput;
  expect: ChannelBehaviorConversationTurnExpectationInput;
  id?: string;
  name?: string;
  send?: ChannelBehaviorConversationSendInput;
};

export type ChannelBehaviorConversationInput = {
  from?: ChannelBehaviorConversationActorInput;
  id?: string;
  target: string | ChannelBehaviorScenarioChannel;
  turns: readonly ChannelBehaviorConversationTurnInput[];
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
  transport: QaTransportAdapter,
  options: { cfg?: OpenClawConfig } = {},
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
      await transport.restartGateway(step.restart);
    }

    const thread =
      step.thread?.createBeforeStep === true
        ? await transport.createThread({
            channel: scenario.channel,
            cfg: options.cfg,
            title: step.thread.title,
          })
        : undefined;
    const outboundCursor = transport.getOutboundCursor();
    const inboundInput =
      thread && step.inbound && !step.inbound.threadId
        ? {
            ...step.inbound,
            threadId: thread.id,
            ...(thread.title ? { threadTitle: thread.title } : {}),
          }
        : step.inbound;
    const inbound = inboundInput
      ? await transport.sendInbound({
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
        ? await transport.waitForOutbound({
            channel: scenario.channel,
            expectation,
            sinceIndex: outboundCursor,
          })
        : undefined;
    if (expectation.kind === "no-reply") {
      await transport.waitForNoOutbound({
        quietMs: expectation.quietMs,
        sinceIndex: outboundCursor,
      });
    }
    if (outbound) {
      lastOutbound = outbound;
    }

    if (step.restart?.afterStep) {
      await transport.restartGateway(step.restart);
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
    ...(lastOutbound ? { lastReply: lastOutbound } : {}),
    ...(lastOutbound ? { lastOutbound } : {}),
  };
}

export function defineChannelBehaviorScenarioFromConversation(
  input: ChannelBehaviorConversationInput,
  options: { scenarioId: string },
): ChannelBehaviorScenarioDefinitionInput {
  const scenarioId = requireNonEmpty(input.id ?? options.scenarioId, "scenario id");
  if (input.turns.length === 0) {
    throw new Error(`channel behavior conversation ${scenarioId} must define at least one turn`);
  }
  const actor = normalizeConversationActor(input.from);
  const channel = normalizeChannelBehaviorTarget(input.target);
  return {
    id: scenarioId,
    channel,
    steps: input.turns.map((turn, index) => {
      const stepId = requireNonEmpty(turn.id ?? `turn-${index + 1}`, `turn ${index + 1} id`);
      return {
        id: stepId,
        name: requireNonEmpty(turn.name ?? stepId, `turn ${stepId} name`),
        ...(turn.createThread
          ? {
              thread: {
                createBeforeStep: true,
                required: true,
                ...(turn.createThread.title ? { title: turn.createThread.title } : {}),
              },
            }
          : {}),
        ...(turn.send
          ? {
              inbound: buildConversationInbound(turn.send, actor),
            }
          : {}),
        expect: buildConversationExpectation(turn.expect, turn),
      };
    }),
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
  return qaTransportChannelConversation(normalizeChannel(channel));
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
  return matchesQaTransportOutbound(message, params);
}

function normalizeChannel(channel: ChannelBehaviorScenarioChannel): ChannelBehaviorScenarioChannel {
  return {
    ...channel,
    id: requireNonEmpty(channel.id, "channel id"),
  };
}

function normalizeChannelBehaviorTarget(
  target: string | ChannelBehaviorScenarioChannel,
): ChannelBehaviorScenarioChannel {
  if (typeof target !== "string") {
    return normalizeChannel(target);
  }
  const trimmed = requireNonEmpty(target, "target");
  if (trimmed.startsWith("dm:")) {
    return { id: requireNonEmpty(trimmed.slice("dm:".length), "target id"), kind: "direct" };
  }
  if (trimmed.startsWith("channel:")) {
    return { id: requireNonEmpty(trimmed.slice("channel:".length), "target id"), kind: "channel" };
  }
  if (trimmed.startsWith("group:")) {
    return { id: requireNonEmpty(trimmed.slice("group:".length), "target id"), kind: "group" };
  }
  return { id: trimmed, kind: "direct" };
}

function normalizeConversationActor(input?: ChannelBehaviorConversationActorInput): {
  senderId?: string;
  senderName?: string;
} {
  if (typeof input === "string") {
    return { senderId: requireNonEmpty(input, "sender id") };
  }
  if (!input) {
    return {};
  }
  return {
    ...(input.id ? { senderId: requireNonEmpty(input.id, "sender id") } : {}),
    ...(input.name ? { senderName: requireNonEmpty(input.name, "sender name") } : {}),
  };
}

function buildConversationInbound(
  send: ChannelBehaviorConversationSendInput,
  actor: ReturnType<typeof normalizeConversationActor>,
): ChannelBehaviorScenarioInbound {
  if (typeof send === "string") {
    return {
      ...actor,
      text: send,
    };
  }
  return {
    ...actor,
    text: send.text,
    ...(send.attachments ? { attachments: send.attachments } : {}),
    ...(send.toolCalls ? { toolCalls: send.toolCalls } : {}),
  };
}

function buildConversationExpectation(
  expectation: ChannelBehaviorConversationTurnExpectationInput,
  turn: ChannelBehaviorConversationTurnInput,
): ChannelBehaviorScenarioExpectation {
  if (expectation.noReply) {
    return {
      kind: "no-reply",
      ...(expectation.noReply.windowMs ? { quietMs: expectation.noReply.windowMs } : {}),
    };
  }
  if (!expectation.reply) {
    throw new Error(
      `channel behavior conversation turn ${turn.id ?? turn.name ?? "turn"} must expect reply or noReply`,
    );
  }
  if (expectation.reply.inThread && !turn.createThread) {
    throw new Error(
      `channel behavior conversation turn ${turn.id ?? turn.name ?? "turn"} expects an in-thread reply but does not create a thread`,
    );
  }
  return {
    kind: "reply",
    ...(expectation.reply.includes ? { textIncludes: expectation.reply.includes } : {}),
    ...(expectation.reply.timeoutMs ? { timeoutMs: expectation.reply.timeoutMs } : {}),
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
