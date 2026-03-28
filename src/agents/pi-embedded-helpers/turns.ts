import type { AgentMessage } from "@mariozechner/pi-agent-core";

type AnthropicTextBlock = {
  type: "text";
  text?: string;
};

type AnthropicImageBlock = {
  type: "image";
  url?: string;
  mediaType?: string;
  data?: string;
};

type AnthropicToolUseBlock = {
  type: "toolUse";
  id?: string;
  name?: string;
  input?: unknown;
};

type AnthropicToolResultBlock = {
  type: "toolResult";
  toolUseId?: string;
  content?: unknown;
  isError?: boolean;
};

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

type UserAgentMessage = Extract<AgentMessage, { role: "user" }>;

/**
 * Strips dangling tool_use blocks from assistant messages when the immediately
 * following user message does not contain a matching tool_result block.
 * This fixes the "tool_use ids found without tool_result blocks" error from Anthropic.
 */
function stripDanglingAnthropicToolUses(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      result.push(msg);
      continue;
    }

    const msgRole = (msg as { role?: unknown }).role as string | undefined;
    if (msgRole !== "assistant") {
      result.push(msg);
      continue;
    }

    const assistantMsg = msg as {
      content?: AnthropicContentBlock[];
    };

    // Get the next message to check for tool_result blocks
    const nextMsg = messages[i + 1];
    const nextMsgRole =
      nextMsg && typeof nextMsg === "object"
        ? ((nextMsg as { role?: unknown }).role as string | undefined)
        : undefined;

    // If next message is not user, keep the assistant message as-is
    if (nextMsgRole !== "user") {
      result.push(msg);
      continue;
    }

    // Collect tool_use_ids from the next user message's tool_result blocks
    const nextUserMsg = nextMsg as {
      content?: AnthropicContentBlock[];
    };
    const validToolUseIds = new Set<string>();
    if (Array.isArray(nextUserMsg.content)) {
      for (const block of nextUserMsg.content) {
        if (block && block.type === "toolResult" && block.toolUseId) {
          validToolUseIds.add(block.toolUseId);
        }
      }
    }

    // Filter out tool_use blocks that don't have matching tool_result
    const originalContent = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
    const filteredContent = originalContent.filter((block) => {
      if (!block) {
        return false;
      }
      if (block.type !== "toolUse") {
        return true;
      }
      // Keep tool_use if its id is in the valid set
      return validToolUseIds.has(block.id || "");
    });

    // If all content would be removed, insert a minimal fallback text block
    if (originalContent.length > 0 && filteredContent.length === 0) {
      result.push({
        ...assistantMsg,
        content: [{ type: "text", text: "[tool calls omitted]" }],
      } as AgentMessage);
    } else {
      result.push({
        ...assistantMsg,
        content: filteredContent,
      } as AgentMessage);
    }
  }

  return result;
}

function validateTurnsWithConsecutiveMerge<
  TMessage extends AgentMessage,
  TRole extends "assistant" | "user",
>(params: {
  messages: TMessage[];
  role: TRole;
  merge: (
    previous: Extract<TMessage, { role: TRole }>,
    current: Extract<TMessage, { role: TRole }>,
  ) => Extract<TMessage, { role: TRole }>;
}): TMessage[] {
  const { messages, role, merge } = params;
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const result: TMessage[] = [];
  let lastRole: string | undefined;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      result.push(msg);
      continue;
    }

    const msgRole = (msg as { role?: unknown }).role as string | undefined;
    if (!msgRole) {
      result.push(msg);
      continue;
    }

    if (msgRole === lastRole && lastRole === role) {
      const lastMsg = result[result.length - 1];
      const currentMsg = msg as Extract<TMessage, { role: TRole }>;

      if (lastMsg && typeof lastMsg === "object") {
        const lastTyped = lastMsg as Extract<TMessage, { role: TRole }>;
        result[result.length - 1] = merge(lastTyped, currentMsg);
        continue;
      }
    }

    result.push(msg);
    lastRole = msgRole;
  }

  return result;
}

function mergeConsecutiveAssistantTurns(
  previous: Extract<AgentMessage, { role: "assistant" }>,
  current: Extract<AgentMessage, { role: "assistant" }>,
): Extract<AgentMessage, { role: "assistant" }> {
  const mergedContent = [
    ...(Array.isArray(previous.content) ? previous.content : []),
    ...(Array.isArray(current.content) ? current.content : []),
  ];
  return {
    ...previous,
    content: mergedContent,
    ...(current.usage && { usage: current.usage }),
    ...(current.stopReason && { stopReason: current.stopReason }),
    ...(current.errorMessage && {
      errorMessage: current.errorMessage,
    }),
  };
}

/**
 * Validates and fixes conversation turn sequences for Gemini API.
 * Gemini requires strict alternating user→assistant→tool→user pattern.
 * Merges consecutive assistant messages together.
 */
export function validateGeminiTurns(messages: AgentMessage[]): AgentMessage[] {
  return validateTurnsWithConsecutiveMerge({
    messages,
    role: "assistant",
    merge: mergeConsecutiveAssistantTurns,
  });
}

export function mergeConsecutiveUserTurns(
  previous: UserAgentMessage,
  current: UserAgentMessage,
): UserAgentMessage {
  const toBlocks = (content: unknown): AnthropicContentBlock[] => {
    if (Array.isArray(content)) {
      return content;
    }
    if (typeof content === "string" && content.length > 0) {
      return [{ type: "text", text: content }];
    }
    return [];
  };
  const mergedContent = [...toBlocks(previous.content), ...toBlocks(current.content)];

  return {
    ...current,
    // validateAnthropicTurns only merges block-form transcripts, but the
    // shared AgentMessage type still models user content as string/text/image.
    // Cast back here so the runtime-safe Anthropic block merge remains local.
    content: mergedContent as UserAgentMessage["content"],
    timestamp: current.timestamp ?? previous.timestamp,
  };
}

/**
 * Returns true when every user message in the transcript uses block-form
 * (array) `content`.  When any user message carries a plain string, the
 * transcript is considered "string-form" and consecutive-user merging must
 * be skipped — merging would convert the content to an array of Anthropic
 * content blocks that non-Anthropic providers cannot interpret.
 */
function transcriptUsesBlockFormContent(messages: AgentMessage[]): boolean {
  for (const msg of messages) {
    if (
      msg &&
      typeof msg === "object" &&
      (msg as { role?: string }).role === "user" &&
      !Array.isArray((msg as { content?: unknown }).content)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Validates and fixes conversation turn sequences for Anthropic API.
 * Anthropic requires strict alternating user→assistant pattern.
 * Merges consecutive user messages together.
 * Also strips dangling tool_use blocks that lack corresponding tool_result blocks.
 *
 * When the transcript contains string-form user content (plain strings rather
 * than Anthropic content-block arrays), consecutive-user merging is skipped to
 * avoid converting content into a format that non-Anthropic providers cannot
 * consume.  Dangling tool_use stripping still runs unconditionally.
 */
export function validateAnthropicTurns(messages: AgentMessage[]): AgentMessage[] {
  // First, strip dangling tool_use blocks from assistant messages
  const stripped = stripDanglingAnthropicToolUses(messages);

  // Only merge consecutive user turns when the transcript uses block-form
  // content.  String-form transcripts (from openai-completions providers that
  // are not strictly Anthropic-compatible) would have their content silently
  // converted to Anthropic content-block arrays, which downstream providers
  // cannot interpret.  (#55670)
  if (!transcriptUsesBlockFormContent(stripped)) {
    return stripped;
  }

  return validateTurnsWithConsecutiveMerge({
    messages: stripped,
    role: "user",
    merge: mergeConsecutiveUserTurns,
  });
}
