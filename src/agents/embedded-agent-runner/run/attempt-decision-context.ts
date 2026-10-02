import { stripUserEnvelopeForDisplay } from "../../../auto-reply/reply/user-envelope-display.js";
import {
  readPersistedMediaFacts,
  readRuntimePromptMediaFacts,
} from "../../../media/media-facts.js";
import { normalizeInputProvenance } from "../../../sessions/input-provenance.js";
import {
  extractAssistantCommentaryText,
  extractAssistantVisibleText,
} from "../../embedded-agent-utils.js";
import { isOpenClawRuntimeContextCustomMessage } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { detectImageReferences } from "./images.js";

// Projection limits, not a tokenizer or provider admission estimate. Never cut a
// request/proposal to fit: omit only whole older exchanges, or retain tools.
const MAX_DECISION_CONTEXT_CHARS = 6_000;
const MAX_SCAN_MESSAGES = 64;
const MAX_CONTENT_BLOCKS = 64;
const MAX_EXCHANGES = 2;

type Exchange = {
  user: string;
  assistant: string;
  toolResults?: { returned: number; errors: number };
};
export type DecisionContextFacts = {
  exchangeCount: number;
  contextChars: number;
  olderContextOmitted: boolean;
  toolPayloadsOmitted: boolean;
};
export type DecisionContext =
  | {
      status: "ready";
      latestRequest: string;
      recentConversation: Exchange[];
      facts: DecisionContextFacts;
    }
  | {
      status: "skipped";
      reason:
        | "empty-request"
        | "context-too-large"
        | "missing-exchange"
        | "excluded-context"
        | "pending-tool-work";
      facts: DecisionContextFacts;
    };

function hasMedia(message: AgentMessage): boolean {
  return Boolean(
    readRuntimePromptMediaFacts(message)?.length ||
    readPersistedMediaFacts(message)?.length ||
    ("content" in message &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "image")),
  );
}

function isRuntimeCarrier(message: AgentMessage): boolean {
  return (
    isOpenClawRuntimeContextCustomMessage(message) ||
    (message.role === "user" && message.runtimeContextCarrier === true)
  );
}

function readUserText(message: Extract<AgentMessage, { role: "user" }>): string | undefined {
  const provenance = normalizeInputProvenance(
    "provenance" in message ? message.provenance : undefined,
  );
  if (
    (provenance && provenance.kind !== "external_user") ||
    ("excludeFromContext" in message && message.excludeFromContext === true) ||
    hasMedia(message)
  ) {
    return undefined;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content.length <= MAX_DECISION_CONTEXT_CHARS &&
      detectImageReferences(content).length === 0
      ? stripUserEnvelopeForDisplay(content).trim()
      : undefined;
  }
  if (content.length > MAX_CONTENT_BLOCKS || content.some((block) => block.type !== "text")) {
    return undefined;
  }
  let chars = 0;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type !== "text" || (chars += block.text.length) > MAX_DECISION_CONTEXT_CHARS) {
      return undefined;
    }
    parts.push(block.text);
  }
  const text = parts.join("\n");
  return detectImageReferences(text).length === 0
    ? stripUserEnvelopeForDisplay(text).trim()
    : undefined;
}

/** Only consumes already-prepared, prior conversation. Current admission is separate. */
export function prepareDecisionContext(params: {
  latestRequest: string;
  messages: readonly AgentMessage[];
  currentInputExcluded?: boolean;
}): DecisionContext {
  const facts: DecisionContextFacts = {
    exchangeCount: 0,
    contextChars: 0,
    olderContextOmitted: false,
    toolPayloadsOmitted: false,
  };
  const skip = (
    reason: Extract<DecisionContext, { status: "skipped" }>["reason"],
  ): DecisionContext => ({ status: "skipped", reason, facts });
  if (params.currentInputExcluded) {
    return skip("excluded-context");
  }
  if (params.latestRequest.length > MAX_DECISION_CONTEXT_CHARS) {
    return skip("context-too-large");
  }
  if (detectImageReferences(params.latestRequest).length > 0) {
    return skip("excluded-context");
  }
  const latestRequest = stripUserEnvelopeForDisplay(params.latestRequest).trim();
  facts.contextChars = latestRequest.length;
  if (!latestRequest) {
    return skip("empty-request");
  }
  const recentConversation: Exchange[] = [];
  const pending: AgentMessage[] = [];
  const lower = Math.max(0, params.messages.length - MAX_SCAN_MESSAGES);
  for (let index = params.messages.length - 1; index >= lower; index -= 1) {
    const message = params.messages[index]!;
    if (isRuntimeCarrier(message)) {
      continue;
    }
    if (message.role !== "user") {
      pending.unshift(message);
      continue;
    }
    const user = readUserText(message);
    const pendingCalls = new Map<string, number>();
    let unmatchedResult = false;
    let returned = 0;
    let errors = 0;
    let assistant = "";
    let excluded = !user;
    let terminal = false;
    for (const reply of pending) {
      if (reply.role === "toolResult") {
        // IDs only pair host-owned returns; neither IDs, names nor payloads leave this projection.
        const waiting = pendingCalls.get(reply.toolCallId) ?? 0;
        if (waiting === 0) {
          unmatchedResult = true;
        } else if (waiting === 1) {
          pendingCalls.delete(reply.toolCallId);
        } else {
          pendingCalls.set(reply.toolCallId, waiting - 1);
        }
        returned += 1;
        errors += reply.isError ? 1 : 0;
      } else if (reply.role === "assistant") {
        const content = reply.content;
        const contentLimit =
          typeof content === "string" ? MAX_DECISION_CONTEXT_CHARS : MAX_CONTENT_BLOCKS;
        if (content.length > contentLimit) {
          excluded = true;
          continue;
        }
        // The shared text owner also accepts legacy persisted string replies.
        let chars = 0;
        for (const block of typeof content === "string" ? [] : content) {
          if (block.type === "toolCall") {
            pendingCalls.set(block.id, (pendingCalls.get(block.id) ?? 0) + 1);
          } else if (block.type === "text") {
            chars += block.text.length;
          }
        }
        if (
          chars > MAX_DECISION_CONTEXT_CHARS ||
          hasMedia(reply) ||
          reply.openclawDelivery?.mediaUrls?.length
        ) {
          excluded = true;
          continue;
        }
        // Both delivered phases can contain a proposal. Keep commentary before the
        // final answer; the delivery owners still exclude reasoning/scaffolding.
        const visible = [extractAssistantCommentaryText(reply), extractAssistantVisibleText(reply)]
          .filter(Boolean)
          .join("\n");
        if (detectImageReferences(visible).length > 0) {
          excluded = true;
          continue;
        }
        if (visible) {
          assistant = assistant ? `${assistant}\n${visible}` : visible;
        }
        terminal = reply.stopReason === "stop" && reply.endTurn !== false;
      } else {
        // No system/developer instructions, summaries, or unknown custom envelopes.
        excluded = true;
      }
    }
    const unpaired = unmatchedResult || pendingCalls.size > 0;
    const problem = unpaired
      ? "pending-tool-work"
      : excluded
        ? "excluded-context"
        : !assistant || !terminal
          ? "missing-exchange"
          : undefined;
    if (problem) {
      if (recentConversation.length === 0) {
        return skip(problem);
      }
      facts.olderContextOmitted = true;
      break;
    }
    const exchange: Exchange = {
      user: user!,
      assistant,
      ...(returned ? { toolResults: { returned, errors } } : {}),
    };
    const size = exchange.user.length + exchange.assistant.length;
    if (facts.contextChars + size > MAX_DECISION_CONTEXT_CHARS) {
      if (recentConversation.length === 0) {
        return skip("context-too-large");
      }
      facts.olderContextOmitted = true;
      break;
    }
    recentConversation.unshift(exchange);
    facts.contextChars += size;
    facts.exchangeCount = recentConversation.length;
    facts.toolPayloadsOmitted ||= returned > 0;
    pending.length = 0;
    if (recentConversation.length === MAX_EXCHANGES) {
      facts.olderContextOmitted = index > 0;
      break;
    }
  }
  if (pending.length || (lower > 0 && recentConversation.length === 0)) {
    if (recentConversation.length === 0) {
      return skip("missing-exchange");
    }
    facts.olderContextOmitted = true;
  }
  facts.olderContextOmitted ||= lower > 0;
  // A genuinely fresh session needs no historical referent. Existing incomplete
  // exchanges have already abstained above; do not disable first-turn filtering.
  return { status: "ready", latestRequest, recentConversation, facts };
}
