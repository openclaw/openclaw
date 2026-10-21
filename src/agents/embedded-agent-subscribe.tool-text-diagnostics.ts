import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { markdownToIR } from "../../packages/markdown-core/src/ir.js";
import { detectToolCallShapedText } from "../../packages/tool-call-repair/src/index.js";
import type { AssistantMessage } from "../llm/types.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { isToolCallBlockType } from "../shared/tool-block-contract.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { normalizeToolPolicyName } from "./tool-policy.js";

type AssistantTranscriptRoleHeaderDetection = {
  kind: "angle_role_header" | "role_timestamp_bracket" | "timestamp_role_colon";
  role: "assistant" | "developer" | "system" | "user";
};

/** Detect transcript-role headers in assistant Markdown through the canonical parser. */
function detectAssistantTranscriptRoleHeaderText(
  text: string,
): AssistantTranscriptRoleHeaderDetection | null {
  // Parsed headers need a bracket or angle delimiter, written literally or as an entity.
  if (!text.includes("[") && !text.includes("<") && !text.includes("&")) {
    return null;
  }
  const annotation = markdownToIR(text, {
    assistantTranscriptRoleHeaders: true,
    enableSpoilers: true,
    linkify: false,
    tableMode: "off",
  }).annotations?.[0];
  if (!annotation || annotation.type !== "assistant_transcript_role") {
    return null;
  }
  return { kind: annotation.kind, role: annotation.role };
}

function isRegisteredToolName(
  toolName: string | undefined,
  registeredToolNames: ReadonlySet<string> | undefined,
): boolean | undefined {
  if (!toolName || !registeredToolNames) {
    return undefined;
  }
  const normalized = normalizeToolPolicyName(toolName);
  for (const registeredToolName of registeredToolNames) {
    if (normalizeToolPolicyName(registeredToolName) === normalized) {
      return true;
    }
  }
  return false;
}

/** Log safe metadata for suspicious assistant-authored text shapes. */
export function warnIfAssistantEmittedSuspiciousText(
  ctx: EmbeddedAgentSubscribeContext,
  assistantMessage: AssistantMessage,
) {
  // Detect text pretending to call a tool only when no real invocation was emitted.
  const structuredToolInvocation = assistantMessage.content.some((block) =>
    isToolCallBlockType(block.type),
  );
  const text =
    extractTextFromChatContent(assistantMessage.content, {
      joinWith: "\n",
      normalizeText: (chunk) => chunk.trim(),
    }) ?? "";
  const toolDetection = structuredToolInvocation ? null : detectToolCallShapedText(text);
  if (toolDetection) {
    const provider = normalizeOptionalString((assistantMessage as { provider?: unknown }).provider);
    const model = normalizeOptionalString((assistantMessage as { model?: unknown }).model);
    const registeredTool = isRegisteredToolName(toolDetection.toolName, ctx.builtinToolNames);
    const sessionId = normalizeOptionalString((ctx.params.session as { id?: unknown }).id);
    ctx.log.warn(
      "Assistant reply looks like a tool call, but no structured tool invocation was emitted; treating it as text.",
      {
        runId: ctx.params.runId,
        ...(sessionId ? { sessionId } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        pattern: toolDetection.kind,
        ...(toolDetection.toolName ? { toolName: toolDetection.toolName } : {}),
        ...(registeredTool !== undefined ? { registeredTool } : {}),
      },
    );
  }
  const roleDetection = detectAssistantTranscriptRoleHeaderText(text);
  if (!roleDetection) {
    return;
  }
  const provider = normalizeOptionalString((assistantMessage as { provider?: unknown }).provider);
  const model = normalizeOptionalString((assistantMessage as { model?: unknown }).model);
  const sessionId = normalizeOptionalString((ctx.params.session as { id?: unknown }).id);
  ctx.log.warn(
    "Assistant reply contains transcript-role-looking text; treating it as inert assistant text.",
    {
      runId: ctx.params.runId,
      ...(sessionId ? { sessionId } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      pattern: roleDetection.kind,
      role: roleDetection.role,
    },
  );
}
