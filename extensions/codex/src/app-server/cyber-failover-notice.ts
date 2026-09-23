/**
 * Composer notices for automatic Daybreak escalation.
 *
 * Shares the `provider_policy` notice contract the event projector already emits
 * for cyber review, block, and reroute, so the Control UI keeps one card and one
 * lifecycle for every cyber outcome.
 */
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitCodexAppServerEvent } from "./run-attempt-lifecycle.js";

export type CodexCyberNoticeState = "escalated" | "unavailable";

export async function emitCodexCyberNotice(
  params: EmbeddedRunAttemptParamsV2,
  notice: { state: CodexCyberNoticeState; model?: string; fallbackModel: string },
): Promise<void> {
  await emitCodexAppServerEvent(params, {
    stream: "notice",
    data: {
      phase: "provider_policy",
      category: "cyber",
      state: notice.state,
      provider: "openai",
      ...(notice.model ? { model: notice.model } : {}),
      fallbackModel: notice.fallbackModel,
    },
  });
}
