import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { captureCliRunStartTime, type PreparedCliRunContext } from "./types.js";

export function createPreparedCliContext(
  params: Partial<Omit<PreparedCliRunContext["params"], "admittedRunContext">> & {
    provider: string;
    model: string;
    runId: string;
  },
  backendResolved: PreparedCliRunContext["backendResolved"],
  overrides: Partial<Omit<PreparedCliRunContext, "params" | "backendResolved">> = {},
): PreparedCliRunContext {
  return {
    params: {
      admittedRunContext: createTestAdmittedRunContext(params.runId),
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      timeoutMs: 1_000,
      ...params,
    },
    ...captureCliRunStartTime(),
    workspaceDir: "/tmp",
    backendResolved,
    executionTarget: { kind: "process" },
    preparedBackend: { backend: backendResolved.config, env: {} },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: params.model,
    normalizedModel: params.model,
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPlugin: { args: [] },
    authEpochVersion: 2,
    ...overrides,
  };
}
