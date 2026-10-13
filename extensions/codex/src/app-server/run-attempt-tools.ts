import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { isSystemAgentOnlyCodexDynamicToolAllowlist } from "./dynamic-tool-profile.js";
import type { CodexDynamicToolCallResponse } from "./protocol.js";

export function toTranscriptToolResult(
  response: CodexDynamicToolCallResponse,
): Record<string, unknown> {
  const contentItems = Array.isArray(response.contentItems) ? response.contentItems : [];
  const result: Record<string, unknown> = {
    ...response,
    content: contentItems.map(toTranscriptToolResultContentItem),
  };
  delete result.contentItems;
  delete result.success;
  return result;
}

function toTranscriptToolResultContentItem(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== "object") {
    return { type: "text", text: "" };
  }
  const record = item as Record<string, unknown>;
  if (record.type === "inputText") {
    return { type: "text", text: typeof record.text === "string" ? record.text : "" };
  }
  if (record.type === "inputImage" && typeof record.imageUrl === "string") {
    return { type: "image", url: record.imageUrl };
  }
  const rawType = typeof record.type === "string" ? record.type.replace(/\s+/g, " ").trim() : "";
  const label = rawType ? truncateUtf16Safe(rawType, 80) : "unknown";
  const suffix = rawType.length > 80 ? "..." : "";
  return { type: "text", text: `[Unsupported Codex dynamic tool output: ${label}${suffix}]` };
}

export function resolveCodexDynamicToolDirectNames(
  params: EmbeddedRunAttemptParams,
  registeredTools: readonly { name: string }[],
  hostSystemAgentActive = false,
): string[] {
  // Tools with catalogMode=direct-only use the model-only namespace. This list
  // remains for control tools that intentionally live at the dynamic-tool root.
  return [
    // OpenClaw is the run's only tool and must stay callable when Codex tool
    // search is unavailable. Exact toolsAllow is the public harness contract.
    ...(hostSystemAgentActive && isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow)
      ? ["openclaw"]
      : []),
    // Registration owns persistent layout; a turn may narrow execution without
    // moving this tool into a namespace and changing the thread fingerprint.
    ...(registeredTools.some((tool) => tool.name === "message") ? ["message"] : []),
  ];
}
