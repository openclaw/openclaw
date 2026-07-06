/**
 * Uniform image sanitization for fresh tool results.
 *
 * Persisted history is sanitized on replay (replay-history.ts →
 * sanitizeSessionMessagesImages), but results produced within the current
 * turn's tool loop reach the provider without any central pass — the only
 * guard used to be whatever each tool's own execute() did, which is how
 * payload-less image husks escaped (#99370). This hook is the single
 * enforcement point: it chains last on afterToolCall, so it sees the final
 * content including extension-hook modifications, and sanitizes it exactly
 * once. Tools that sanitize at construction stay correct and cheap —
 * sanitizeToolResultImages short-circuits on already-clean content.
 */
import type { ImageSanitizationLimits } from "../../image-sanitization.js";
import type { AfterToolCallContext, Agent } from "../../runtime/index.js";
import { sanitizeToolResultImages } from "../../tool-images.js";

export function installToolResultImageSanitizerHook(params: {
  agent: Agent;
  imageSanitization?: ImageSanitizationLimits;
}): void {
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (context: AfterToolCallContext, signal?: AbortSignal) => {
    const hookResult = await previousAfterToolCall?.(context, signal);
    const content = hookResult?.content ?? context.result.content;
    const sanitized = await sanitizeToolResultImages(
      { content, details: {} },
      `tool:${context.toolCall.name}`,
      params.imageSanitization,
    );
    if (sanitized.content === content && !hookResult) {
      return undefined;
    }
    return { ...hookResult, content: sanitized.content };
  };
}
