import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

// Mocks for the critical seams runCliAgent loads dynamically. Each mock is
// reset between tests via vi.clearAllMocks. We avoid touching the broader CLI
// runtime — this test only exercises the hook-gate decision at the entry point.

const hasHooksMock = vi.fn<(hookName: string) => boolean>(() => false);
const runBeforeAgentReplyMock = vi.fn(async (_event: unknown, _ctx: unknown) => undefined);
const executePreparedCliRunMock = vi.fn(async (_context: unknown, _cliSessionIdToUse?: string) => ({
  text: "",
}));
const prepareCliRunContextMock = vi.fn();

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => ({
    hasHooks: hasHooksMock,
    runBeforeAgentReply: runBeforeAgentReplyMock,
  })),
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  prepareCliRunContext: prepareCliRunContextMock,
}));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

const baseRunParams = {
  sessionId: "test-session",
  sessionKey: "test-session-key",
  agentId: "main",
  sessionFile: "/tmp/test-session.jsonl",
  workspaceDir: "/tmp/test-workspace",
  prompt: "__openclaw_memory_core_short_term_promotion_dream__",
  provider: "codex-cli",
  model: "gpt-5.5",
  timeoutMs: 30_000,
  runId: "test-run-id",
} as const;

function makeStubContext(promptOverride?: string) {
  return {
    params: { ...baseRunParams, ...(promptOverride ? { prompt: promptOverride } : {}) },
    started: Date.now(),
    workspaceDir: baseRunParams.workspaceDir,
    modelId: baseRunParams.model,
    normalizedModel: baseRunParams.model,
    systemPrompt: "",
    systemPromptReport: {},
    bootstrapPromptWarningLines: [],
    authEpochVersion: 0,
    backendResolved: {},
    preparedBackend: {},
    reusableCliSession: {},
  } as unknown;
}

beforeEach(() => {
  hasHooksMock.mockReset();
  hasHooksMock.mockReturnValue(false);
  runBeforeAgentReplyMock.mockReset();
  runBeforeAgentReplyMock.mockResolvedValue(undefined);
  executePreparedCliRunMock.mockReset();
  executePreparedCliRunMock.mockResolvedValue({ text: "" });
  prepareCliRunContextMock.mockReset();
  prepareCliRunContextMock.mockImplementation(async (params: typeof baseRunParams) =>
    makeStubContext(params.prompt),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runCliAgent cron before_agent_reply seam", () => {
  it("lets before_agent_reply claim cron runs before the CLI subprocess is invoked", async () => {
    const { runCliAgent } = await import("./cli-runner.js");
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed via cli runner" },
    });

    const result = await runCliAgent({ ...baseRunParams, trigger: "cron" });

    expect(runBeforeAgentReplyMock).toHaveBeenCalledTimes(1);
    expect(runBeforeAgentReplyMock).toHaveBeenCalledWith(
      { cleanedBody: baseRunParams.prompt },
      expect.objectContaining({
        agentId: baseRunParams.agentId,
        sessionId: baseRunParams.sessionId,
        sessionKey: baseRunParams.sessionKey,
        workspaceDir: baseRunParams.workspaceDir,
        trigger: "cron",
      }),
    );
    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("dreaming claimed via cli runner");
  });

  it("returns a silent payload when a cron hook claims without a reply body", async () => {
    const { runCliAgent } = await import("./cli-runner.js");
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    runBeforeAgentReplyMock.mockResolvedValue({ handled: true });

    const result = await runCliAgent({ ...baseRunParams, trigger: "cron" });

    expect(executePreparedCliRunMock).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe(SILENT_REPLY_TOKEN);
  });

  it("does not invoke before_agent_reply for non-cron triggers", async () => {
    const { runCliAgent } = await import("./cli-runner.js");
    hasHooksMock.mockImplementation((hookName) => hookName === "before_agent_reply");
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    await runCliAgent({ ...baseRunParams, trigger: "user" });

    expect(runBeforeAgentReplyMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).toHaveBeenCalled();
  });

  it("falls through to the CLI subprocess when no before_agent_reply hook is registered", async () => {
    const { runCliAgent } = await import("./cli-runner.js");
    hasHooksMock.mockReturnValue(false);
    executePreparedCliRunMock.mockResolvedValue({ text: "real reply" });

    await runCliAgent({ ...baseRunParams, trigger: "cron" });

    expect(runBeforeAgentReplyMock).not.toHaveBeenCalled();
    expect(executePreparedCliRunMock).toHaveBeenCalled();
  });
});
