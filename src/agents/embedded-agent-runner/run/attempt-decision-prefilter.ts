import { stripUserEnvelopeForDisplay } from "../../../auto-reply/reply/user-envelope-display.js";
import { createRuntimeConfigReader } from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  evaluateDecisionV2Operation,
  completeDecisionEvaluation,
} from "../../../decisions/runtime.js";
import {
  readPersistedMediaFacts,
  readRuntimePromptMediaFacts,
} from "../../../media/media-facts.js";
import { getPluginRegistryForContext } from "../../../plugins/runtime/gateway-request-scope.js";
import { normalizeInputProvenance } from "../../../sessions/input-provenance.js";
import { isDecisionAssistanceEligible } from "../../decision-assistance.js";
import { resolveDecisionModelSetting } from "../../decision-model-setting.js";
import {
  extractAssistantCommentaryText,
  extractAssistantVisibleText,
} from "../../embedded-agent-utils.js";
import { isOpenClawRuntimeContextCustomMessage } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  DECISION_TOOL_PREFILTER_RUBRIC_VERSION,
  DECISION_TOOL_PREFILTER_THRESHOLD,
  decisionToolPrefilterQuestions,
  projectDecisionToolPrefilter,
  type DecisionPrefilterResult,
} from "./attempt-decision-prefilter-policy.js";
import { detectImageReferences } from "./images.js";

// Projection limits, not a tokenizer or provider admission estimate. Never cut a
// request/proposal to fit: omit only whole older exchanges, or retain tools.
const MAX_DECISION_CONTEXT_CHARS = 6_000;
const MAX_SCAN_MESSAGES = 64;
const MAX_CONTENT_BLOCKS = 64;
const MAX_EXCHANGES = 2;

// UTF-16 code units of conversation text plus verbatim ordinary hook fields.
// The conversation projection has its own 6k bound; this combined 8k text bound
// does not count JSON field names/escaping, metadata, questions, or wire bytes.
const MAX_DECISION_TEXT_CHARS = 8_000;

type Exchange = {
  user: string;
  assistant: string;
  toolResults?: { returned: number; errors: number };
};

export type DecisionPromptBuildFields = {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
};

type EvaluateAttemptDecisionToolPrefilterParams = {
  config: OpenClawConfig;
  agentId: string;
  supportsTurnScopedToolRestrictions?: boolean;
  assertActive: () => void;
  userMessage?: string;
  messages?: readonly AgentMessage[];
  promptBuildFields?: DecisionPromptBuildFields;
  currentInputExcluded?: boolean;
  signal: AbortSignal;
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
  const rawContent = message.content;
  const content =
    typeof rawContent === "string" ? [{ type: "text" as const, text: rawContent }] : rawContent;
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

/** Ordinary unavailability preserves tools; cancellation and contract errors remain terminal. */
export async function evaluateAttemptDecisionToolPrefilter(
  params: EvaluateAttemptDecisionToolPrefilterParams,
): Promise<DecisionPrefilterResult> {
  const skip = (): DecisionPrefilterResult => ({
    shouldPruneTools: false,
    status: "skipped",
  });
  params.signal.throwIfAborted();
  params.assertActive();
  const readConfig = createRuntimeConfigReader(params.config);
  const config = readConfig();
  if (
    !params.agentId.trim() ||
    params.supportsTurnScopedToolRestrictions !== true ||
    !isDecisionAssistanceEligible(config, params.agentId)
  ) {
    return skip();
  }
  const userMessage = params.userMessage?.trim();
  // A named explicit evaluation is an action even if its supplied evidence is a greeting.
  if (!userMessage || /\bdecision_evaluate\b/i.test(userMessage)) {
    return skip();
  }
  const messages = params.messages ?? [];
  const currentInputExcluded = params.currentInputExcluded;
  const facts = {
    contextChars: 0,
    olderContextOmitted: false,
    toolPayloadsOmitted: false,
  };
  if (currentInputExcluded) {
    return skip();
  }
  if (userMessage.length > MAX_DECISION_CONTEXT_CHARS) {
    return skip();
  }
  if (detectImageReferences(userMessage).length > 0) {
    return skip();
  }
  const latestRequest = stripUserEnvelopeForDisplay(userMessage).trim();
  facts.contextChars = latestRequest.length;
  if (!latestRequest) {
    return skip();
  }
  const recentConversation: Exchange[] = [];
  const pending: AgentMessage[] = [];
  const lower = Math.max(0, messages.length - MAX_SCAN_MESSAGES);
  for (let index = messages.length - 1; index >= lower; index -= 1) {
    const message = messages[index]!;
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
    const size = (user?.length ?? 0) + assistant.length;
    if (
      unpaired ||
      excluded ||
      !assistant ||
      !terminal ||
      facts.contextChars + size > MAX_DECISION_CONTEXT_CHARS
    ) {
      if (recentConversation.length === 0) {
        return skip();
      }
      facts.olderContextOmitted = true;
      break;
    }
    const exchange: Exchange = {
      user: user!,
      assistant,
      ...(returned ? { toolResults: { returned, errors } } : {}),
    };
    recentConversation.unshift(exchange);
    facts.contextChars += size;
    facts.toolPayloadsOmitted ||= returned > 0;
    pending.length = 0;
    if (recentConversation.length === MAX_EXCHANGES) {
      facts.olderContextOmitted = index > 0;
      break;
    }
  }
  if (pending.length || (lower > 0 && recentConversation.length === 0)) {
    if (recentConversation.length === 0) {
      return skip();
    }
    facts.olderContextOmitted = true;
  }
  facts.olderContextOmitted ||= lower > 0;
  // A genuinely fresh session needs no historical referent. Existing incomplete
  // exchanges have already abstained above; do not disable first-turn filtering.
  const promptBuildFields = params.promptBuildFields;
  const promptBuildChars = promptBuildFields
    ? Object.values(promptBuildFields).reduce((total, value) => total + (value?.length ?? 0), 0)
    : 0;
  if (facts.contextChars + promptBuildChars > MAX_DECISION_TEXT_CHARS) {
    return skip();
  }
  const selection = resolveDecisionModelSetting(config, params.agentId);
  const isCurrent = () => {
    params.signal.throwIfAborted();
    params.assertActive();
    const current = readConfig();
    const currentSelection = resolveDecisionModelSetting(current, params.agentId);
    return (
      currentSelection?.provider === selection?.provider &&
      currentSelection?.model === selection?.model
    );
  };
  const evaluation = await evaluateDecisionV2Operation(
    {
      state: {
        type: "json",
        value: {
          latestRequest,
          recentConversation,
          omittedContext: {
            olderConversation: facts.olderContextOmitted,
            toolPayloads: facts.toolPayloadsOmitted,
          },
          ...(promptBuildFields ? { beforePromptBuild: promptBuildFields } : {}),
        },
      },
      questions: decisionToolPrefilterQuestions,
    },
    {
      agentId: params.agentId,
      purpose: "tool-prefilter.semantic-gate",
      priority: "optional",
      rubricVersion: DECISION_TOOL_PREFILTER_RUBRIC_VERSION,
      timeoutMs: 500,
      signal: params.signal,
    },
    getPluginRegistryForContext(),
    config,
    undefined,
    isCurrent,
    () => isDecisionAssistanceEligible(readConfig(), params.agentId),
  );
  params.signal.throwIfAborted();
  params.assertActive();
  const result = projectDecisionToolPrefilter(
    evaluation.outcome,
    DECISION_TOOL_PREFILTER_THRESHOLD,
  );
  completeDecisionEvaluation(evaluation);
  return result;
}
