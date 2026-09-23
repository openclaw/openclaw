import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import type { AdmittedRunContext } from "../admitted-run-context.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";

export function createHarnessAttemptParams(
  admittedRunContext: AdmittedRunContext,
  config?: OpenClawConfig,
): EmbeddedRunAttemptParams {
  return {
    admittedRunContext,
    prompt: "hello",
    sessionId: "session-1",
    runId: admittedRunContext.operationalRunInstance.runId,
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    timeoutMs: 5_000,
    provider: "codex",
    modelId: "gpt-5.4",
    model: { id: "gpt-5.4", provider: "codex" } as Model,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    thinkLevel: "low",
    config,
  } as EmbeddedRunAttemptParams;
}
