import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  prepareCliRunContextMock: vi.fn(),
  executeWithOverflowProtectionMock: vi.fn(),
}));

vi.mock("./cli-runner/prepare.js", () => ({
  prepareCliRunContext: (params: unknown) => state.prepareCliRunContextMock(params),
}));

vi.mock("./cli-runner/execute.js", () => ({
  executeWithOverflowProtection: (context: unknown, sessionId: string | undefined) =>
    state.executeWithOverflowProtectionMock(context, sessionId),
}));

import { runCliAgent } from "./cli-runner.js";

function createPreparedContext() {
  return {
    params: {
      provider: "claude-cli",
    },
    started: Date.now(),
    workspaceDir: "/tmp/workspace",
    backendResolved: {
      id: "claude-cli",
      config: { command: "claude" },
      bundleMcp: true,
    },
    preparedBackend: {
      cleanup: vi.fn(async () => {}),
      mcpConfigHash: "mcp-hash",
    },
    reusableCliSession: {
      sessionId: "cli-session-1",
    },
    modelId: "sonnet",
    normalizedModel: "sonnet",
    systemPrompt: "prompt",
    systemPromptReport: {
      source: "run",
      generatedAt: Date.now(),
      systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 0, entries: [] },
      tools: { listChars: 0, schemaChars: 0, entries: [] },
    },
    promptTools: [],
    contextWindowTokens: 200_000,
    activeProfile: "normal",
    activeContextFiles: [],
    bootstrapFiles: [],
    bootstrapPromptWarningMode: "once",
    isClaude: true,
    bootstrapMaxChars: 0,
    bootstrapTotalMaxChars: 0,
    effectiveSkillsSnapshot: {
      prompt: "<available_skills></available_skills>",
      skills: [{ name: "env-skill", primaryEnv: "ENV_KEY" }],
    },
  };
}

describe("runCliAgent skill env handling", () => {
  beforeEach(() => {
    state.prepareCliRunContextMock.mockReset();
    state.executeWithOverflowProtectionMock.mockReset();
    delete process.env.ENV_KEY;
  });

  it("applies and restores skill env overrides around CLI execution", async () => {
    const context = createPreparedContext();
    state.prepareCliRunContextMock.mockResolvedValueOnce(context);
    state.executeWithOverflowProtectionMock.mockImplementationOnce(async () => {
      expect(process.env.ENV_KEY).toBe("snap-key");
      return {
        output: { text: "ok" },
        cliSessionBinding: { sessionId: "cli-session-1" },
        compactionsThisRun: 0,
        systemPromptReport: context.systemPromptReport,
      };
    });

    await runCliAgent({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      config: {
        skills: {
          entries: {
            "env-skill": {
              apiKey: "snap-key",
            },
          },
        },
      },
      prompt: "hello",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-1",
    });

    expect(process.env.ENV_KEY).toBeUndefined();
  });

  it("skips skill env overrides when tools are disabled", async () => {
    const context = createPreparedContext();
    state.prepareCliRunContextMock.mockResolvedValueOnce(context);
    state.executeWithOverflowProtectionMock.mockImplementationOnce(async () => {
      expect(process.env.ENV_KEY).toBeUndefined();
      return {
        output: { text: "ok" },
        cliSessionBinding: { sessionId: "cli-session-1" },
        compactionsThisRun: 0,
        systemPromptReport: context.systemPromptReport,
      };
    });

    await runCliAgent({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      config: {
        skills: {
          entries: {
            "env-skill": {
              apiKey: "snap-key",
            },
          },
        },
      },
      prompt: "hello",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-1",
      disableTools: true,
    });

    expect(process.env.ENV_KEY).toBeUndefined();
  });
});
