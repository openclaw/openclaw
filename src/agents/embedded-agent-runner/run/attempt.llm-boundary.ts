import { stripInboundMetadata } from "../../../auto-reply/reply/strip-inbound-meta.js";
import { stripHistoricalRuntimeContextCustomMessages } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { stripToolResultDetails } from "../../session-transcript-repair.js";
import { normalizeAssistantReplayContent } from "../replay-history.js";
import type { RuntimeContextCustomMessage } from "./runtime-context-prompt.js";

export function normalizeMessagesForLlmBoundary(messages: AgentMessage[]): AgentMessage[] {
  const normalized = stripUnsafeBlockedRunMetadata(
    stripToolResultDetails(normalizeAssistantReplayContent(messages)),
  );
  const withoutHistoricalInboundMetadata =
    stripHistoricalInboundMetadataFromUserMessages(normalized);
  return stripHistoricalRuntimeContextCustomMessages(withoutHistoricalInboundMetadata);
}

export function normalizeMessagesForCurrentPromptBoundary(params: {
  messages: AgentMessage[];
  prompt: string;
}): AgentMessage[] {
  const promptMessage = {
    role: "user" as const,
    content: [{ type: "text" as const, text: params.prompt }],
    timestamp: Date.now(),
  };
  return normalizeMessagesForLlmBoundary([...params.messages, promptMessage]).slice(0, -1);
}

export function installRuntimeContextMessageForPrompt(params: {
  session: {
    messages: AgentMessage[];
    agent: {
      state: { messages: AgentMessage[] };
      continue?: () => Promise<void>;
    };
  };
  message?: RuntimeContextCustomMessage;
}): () => void {
  const { message, session } = params;
  if (!message) {
    return () => undefined;
  }
  const installBeforePrompt = () => {
    if (!session.messages.includes(message)) {
      session.agent.state.messages = appendRuntimeContextMessageForPrompt({
        message,
        messages: session.messages,
      });
    }
  };
  const installBeforeRetry = () => {
    if (!session.messages.includes(message)) {
      session.agent.state.messages = insertRuntimeContextMessageForPrompt({
        message,
        messages: session.messages,
      });
    }
  };
  installBeforePrompt();
  const agent = session.agent;
  const originalContinue = Reflect.get(agent, "continue", agent) as unknown;
  if (typeof originalContinue === "function") {
    const continueWithAgent = originalContinue.bind(agent) as () => Promise<void>;
    agent.continue = function continueWithRuntimeContext(this: typeof agent): Promise<void> {
      // Pi overflow recovery can rebuild state from the persisted branch before retrying.
      installBeforeRetry();
      return continueWithAgent();
    };
  }
  return () => {
    if (typeof originalContinue === "function") {
      agent.continue = originalContinue as typeof agent.continue;
    }
    session.agent.state.messages = session.messages.filter((candidate) => candidate !== message);
  };
}

function appendRuntimeContextMessageForPrompt(params: {
  message: RuntimeContextCustomMessage;
  messages: AgentMessage[];
}): AgentMessage[] {
  if (params.messages.includes(params.message)) {
    return params.messages;
  }
  return [...params.messages, params.message];
}

export function insertRuntimeContextMessageForPrompt(params: {
  message: RuntimeContextCustomMessage;
  messages: AgentMessage[];
}): AgentMessage[] {
  if (params.messages.includes(params.message)) {
    return params.messages;
  }
  const activeUserMessageIndex = findActiveUserMessageIndex(params.messages);
  if (activeUserMessageIndex === -1) {
    return [...params.messages, params.message];
  }
  return [
    ...params.messages.slice(0, activeUserMessageIndex),
    params.message,
    ...params.messages.slice(activeUserMessageIndex),
  ];
}

function stripHistoricalInboundMetadataFromUserMessages(messages: AgentMessage[]): AgentMessage[] {
  const activeUserMessageIndex = findActiveUserMessageIndex(messages);
  let changed = false;
  const nextMessages = messages.map((message, index) => {
    if (message.role !== "user" || index === activeUserMessageIndex) {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      const stripped = stripInboundMetadata(content);
      if (stripped === content) {
        return message;
      }
      changed = true;
      return { ...message, content: stripped } as AgentMessage;
    }
    if (!Array.isArray(content)) {
      return message;
    }
    let contentChanged = false;
    const nextContent = content.map((block) => {
      if (!block || typeof block !== "object") {
        return block;
      }
      const textBlock = block as { type?: unknown; text?: unknown };
      if (textBlock.type !== "text" || typeof textBlock.text !== "string") {
        return block;
      }
      const stripped = stripInboundMetadata(textBlock.text);
      if (stripped === textBlock.text) {
        return block;
      }
      contentChanged = true;
      return Object.assign({}, block, { text: stripped });
    });
    if (!contentChanged) {
      return message;
    }
    changed = true;
    return { ...message, content: nextContent } as AgentMessage;
  });
  return changed ? nextMessages : messages;
}

function stripUnsafeBlockedRunMetadata(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const nextMessages = messages.map((message) => {
    const openclaw = (message as { __openclaw?: unknown }).__openclaw;
    if (!openclaw || typeof openclaw !== "object") {
      return message;
    }
    const beforeAgentRunBlocked = (openclaw as { beforeAgentRunBlocked?: unknown })
      .beforeAgentRunBlocked;
    if (!beforeAgentRunBlocked || typeof beforeAgentRunBlocked !== "object") {
      return message;
    }
    const blocked = beforeAgentRunBlocked as Record<string, unknown>;
    const safeBlocked: Record<string, unknown> = {};
    if (typeof blocked.blockedBy === "string") {
      safeBlocked.blockedBy = blocked.blockedBy;
    }
    if (typeof blocked.blockedAt === "number") {
      safeBlocked.blockedAt = blocked.blockedAt;
    }
    const nextOpenClaw = {
      ...(openclaw as Record<string, unknown>),
      beforeAgentRunBlocked: safeBlocked,
    };
    changed = true;
    return {
      ...(message as unknown as Record<string, unknown>),
      __openclaw: nextOpenClaw,
    } as unknown as AgentMessage;
  });
  return changed ? nextMessages : messages;
}

function findActiveUserMessageIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      return index;
    }
    if (message.role === "assistant" && !isToolCallAssistantMessage(message)) {
      return -1;
    }
  }
  return -1;
}

function isToolCallAssistantMessage(message: AgentMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const type = (block as { type?: unknown }).type;
    return type === "toolCall" || type === "toolUse" || type === "functionCall";
  });
}
