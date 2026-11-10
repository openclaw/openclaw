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

export type PreparedContextOverrides = Partial<{
  sessionKey: string;
  cliSessionId: string;
  runId: string;
  lane: string;
  openClawHistoryPrompt: string;
  provider: string;
  model: string;
  executionMode: PreparedCliRunContext["params"]["executionMode"];
  allowEmptyAssistantReplyAsSilent: boolean;
}>;

export function buildPreparedContext(params: PreparedContextOverrides = {}): PreparedCliRunContext {
  const provider = params?.provider ?? "codex-cli";
  const model = params?.model ?? "gpt-5.4";
  const backend = {
    command: "codex",
    args: ["exec", "--json"],
    output: "text" as const,
    input: "arg" as const,
    modelArg: "--model",
    sessionMode: "existing" as const,
    serialize: true,
  };
  const runId = params?.runId ?? "run-2";
  return createPreparedCliContext(
    {
      provider,
      model,
      runId,
      sessionId: "s1",
      sessionKey: params?.sessionKey,
      thinkLevel: "low",
      lane: params?.lane,
      executionMode: params?.executionMode,
      allowEmptyAssistantReplyAsSilent: params?.allowEmptyAssistantReplyAsSilent,
    },
    {
      id: provider,
      config: backend,
      bundleMcp: false,
      pluginId: provider === "claude-cli" ? "anthropic" : "openai",
    },
    {
      reusableCliSession: params?.cliSessionId
        ? { mode: "reuse", sessionId: params.cliSessionId }
        : { mode: "none" },
      contextWindowInfo: {
        tokens: 150_000,
        referenceTokens: 200_000,
        source: "modelsConfig",
      },
      systemPrompt: "You are a helpful assistant.",
      ...(params?.openClawHistoryPrompt
        ? { openClawHistoryPrompt: params.openClawHistoryPrompt }
        : {}),
    },
  );
}
