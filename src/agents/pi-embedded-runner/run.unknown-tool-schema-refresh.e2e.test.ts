import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "./logger.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);

const baseParams = {
  sessionId: "test-session",
  sessionKey: "test-key",
  sessionFile: "/tmp/session.json",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30000,
  runId: "run-unknown-tool-refresh",
};

function makeSystemPromptReport(
  toolNames: string[],
): NonNullable<EmbeddedRunAttemptResult["systemPromptReport"]> {
  const entries = toolNames.map((name, index) => ({
    name,
    summaryChars: name.length + 10,
    schemaChars: 100 + index * 10,
    propertiesCount: index + 1,
  }));
  return {
    source: "run",
    generatedAt: Date.now(),
    sessionId: "test-session",
    sessionKey: "test-key",
    provider: "anthropic",
    model: "test-model",
    workspaceDir: "/tmp/workspace",
    bootstrapMaxChars: 0,
    bootstrapTotalMaxChars: 0,
    sandbox: {
      mode: "off",
      sandboxed: false,
    },
    systemPrompt: {
      chars: 0,
      projectContextChars: 0,
      nonProjectContextChars: 0,
    },
    injectedWorkspaceFiles: [],
    skills: {
      promptChars: 0,
      entries: [],
    },
    tools: {
      listChars: toolNames.join(",").length,
      schemaChars: entries.reduce((sum, entry) => sum + entry.schemaChars, 0),
      entries,
    },
  };
}

describe("runEmbeddedPiAgent unknown tool schema refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries once with tool schema refresh after unknown tool promptError", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: new Error("unknown tool: plugin_search"),
          systemPromptReport: makeSystemPromptReport(["message", "web_search"]),
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          systemPromptReport: makeSystemPromptReport(["message", "web_search", "plugin_search"]),
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0]).toMatchObject({
      refreshToolSchema: false,
    });
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      refreshToolSchema: true,
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[tool-schema-refresh] unknown-tool detected"),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("[tool-schema-refresh] source=promptError"),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("detects unknown tool from assistant error text and retries with refresh", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          lastAssistant: {
            stopReason: "error",
            errorMessage: 'tool "plugin_search" is not available',
          } as EmbeddedRunAttemptResult["lastAssistant"],
          systemPromptReport: makeSystemPromptReport(["message", "web_search"]),
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          systemPromptReport: makeSystemPromptReport(["message", "web_search", "plugin_search"]),
        }),
      );

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      refreshToolSchema: true,
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("[tool-schema-refresh] source=assistantError"),
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("does not retry from assistant unknown-tool text when promptError is non-unknown", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        promptError: new Error("transport disconnected"),
        lastAssistant: {
          stopReason: "error",
          errorMessage: 'tool "plugin_search" is not available',
        } as EmbeddedRunAttemptResult["lastAssistant"],
        systemPromptReport: makeSystemPromptReport(["message", "web_search"]),
      }),
    );

    await expect(runEmbeddedPiAgent(baseParams)).rejects.toThrow("transport disconnected");

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0]).toMatchObject({
      refreshToolSchema: false,
    });
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("[tool-schema-refresh] unknown-tool detected source=assistantError"),
    );
  });

  it("retries unknown tool failure exactly once", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: new Error("unknown tool: plugin_search"),
          systemPromptReport: makeSystemPromptReport(["message", "web_search"]),
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: new Error("unknown tool: plugin_search"),
          systemPromptReport: makeSystemPromptReport(["message", "web_search"]),
        }),
      );

    await expect(runEmbeddedPiAgent(baseParams)).rejects.toThrow("unknown tool: plugin_search");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      refreshToolSchema: true,
    });
  });
});
