import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  recordEventMock,
  flushMock,
  prepareCliPromptImagePayloadMock,
  prepareClaudeCliSkillsPluginMock,
  enqueueCliRunMock,
} = vi.hoisted(() => ({
  recordEventMock: vi.fn(),
  flushMock: vi.fn(async () => {}),
  prepareCliPromptImagePayloadMock: vi.fn(),
  prepareClaudeCliSkillsPluginMock: vi.fn(),
  enqueueCliRunMock: vi.fn(),
}));

vi.mock("../../trajectory/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../trajectory/runtime.js")>();
  return {
    ...actual,
    createTrajectoryRuntimeRecorder: vi.fn(() => ({
      enabled: true,
      filePath: "/tmp/fake-trajectory.jsonl",
      recordEvent: recordEventMock,
      flush: flushMock,
    })),
  };
});

vi.mock("./helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers.js")>();
  return {
    ...actual,
    prepareCliPromptImagePayload: prepareCliPromptImagePayloadMock,
    enqueueCliRun: enqueueCliRunMock,
  };
});

vi.mock("./claude-skills-plugin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./claude-skills-plugin.js")>();
  return {
    ...actual,
    prepareClaudeCliSkillsPlugin: prepareClaudeCliSkillsPluginMock,
  };
});

import { executePreparedCliRun } from "./execute.js";
import type { PreparedCliRunContext } from "./types.js";

function buildPreparedCliRunContext(): PreparedCliRunContext {
  const backend = {
    command: "agent-cli",
    args: [],
    output: "text" as const,
    input: "stdin" as const,
    serialize: true,
  };

  return {
    params: {
      sessionId: "session-trajectory",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "model",
      timeoutMs: 1_000,
      runId: "run-trajectory",
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "codex-cli",
      config: backend,
      bundleMcp: false,
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: {},
    modelId: "model",
    normalizedModel: "model",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

describe("executePreparedCliRun trajectory lifecycle", () => {
  beforeEach(() => {
    recordEventMock.mockReset();
    flushMock.mockReset();
    flushMock.mockImplementation(async () => {});
    prepareCliPromptImagePayloadMock.mockReset();
    prepareClaudeCliSkillsPluginMock.mockReset();
    prepareClaudeCliSkillsPluginMock.mockImplementation(async () => ({
      args: [],
      env: {},
      cleanup: async () => {},
    }));
    enqueueCliRunMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("records session.ended and flushes when a prep step throws after session.started", async () => {
    const prepError = new Error("image prep blew up");
    prepareCliPromptImagePayloadMock.mockRejectedValueOnce(prepError);

    await expect(executePreparedCliRun(buildPreparedCliRunContext())).rejects.toBe(prepError);

    const eventTypes = recordEventMock.mock.calls.map((call) => call[0]);
    expect(eventTypes).toContain("session.started");
    expect(eventTypes).toContain("session.ended");
    expect(eventTypes).not.toContain("model.completed");

    const sessionEndedCall = recordEventMock.mock.calls.find((call) => call[0] === "session.ended");
    expect(sessionEndedCall?.[1]).toMatchObject({
      status: "error",
      error: expect.stringContaining("image prep blew up"),
    });

    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  it("records a single session.ended event even when the prep failure happens before prompt.submitted", async () => {
    const prepError = new Error("early failure");
    prepareCliPromptImagePayloadMock.mockRejectedValueOnce(prepError);

    await expect(executePreparedCliRun(buildPreparedCliRunContext())).rejects.toBe(prepError);

    const sessionEndedCount = recordEventMock.mock.calls.filter(
      (call) => call[0] === "session.ended",
    ).length;
    expect(sessionEndedCount).toBe(1);
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  it("flushes trajectory even when claudeSkillsPlugin.cleanup() rejects in the finally block", async () => {
    // Reproduces the P2 finding from PR #81039: when a cleanup awaited earlier
    // in `finally` rejects, the trajectory recorder flush must still run
    // — otherwise queued session.ended events for the run get lost on disk.
    prepareCliPromptImagePayloadMock.mockImplementationOnce(async () => ({
      prompt: "hi",
      imagePaths: [],
      cleanupImages: async () => {},
    }));
    const cleanupError = new Error("skills cleanup blew up");
    prepareClaudeCliSkillsPluginMock.mockImplementationOnce(async () => ({
      args: [],
      env: {},
      cleanup: async () => {
        throw cleanupError;
      },
    }));
    // Make the run fail after the skills plugin is allocated so we exit
    // through the `catch`+`finally` path that has to invoke flush.
    const runError = new Error("simulated run failure");
    enqueueCliRunMock.mockImplementationOnce(async () => {
      throw runError;
    });

    await expect(executePreparedCliRun(buildPreparedCliRunContext())).rejects.toBe(runError);

    // The fix: flush is the LAST awaited step in `finally`, and each prior
    // cleanup is wrapped in its own try/catch so a rejection cannot
    // short-circuit the finally.
    expect(flushMock).toHaveBeenCalledTimes(1);

    const sessionEndedCall = recordEventMock.mock.calls.find((call) => call[0] === "session.ended");
    expect(sessionEndedCall?.[1]).toMatchObject({
      status: "error",
      error: expect.stringContaining("simulated run failure"),
    });
  });

  it("surfaces cleanup rejections via cliBackendLog.warn instead of silently swallowing", async () => {
    // Addresses clawsweeper P2 finding on ffefc389c8: the per-cleanup
    // try/catch wrappers were swallowing cleanup errors before the
    // trajectory flush, so a successful CLI run could return success even
    // when prompt/plugin cleanup failed. The wrappers must surface the
    // rejection via cliBackendLog.warn so operators see the failure in
    // CI/log capture — the flush itself still has to run.
    const cliBackendLog = await import("./log.js").then((mod) => mod.cliBackendLog);
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => {});

    try {
      prepareCliPromptImagePayloadMock.mockImplementationOnce(async () => ({
        prompt: "hi",
        imagePaths: [],
        cleanupImages: async () => {
          throw new Error("image cleanup blew up");
        },
      }));
      prepareClaudeCliSkillsPluginMock.mockImplementationOnce(async () => ({
        args: [],
        env: {},
        cleanup: async () => {
          throw new Error("skills cleanup blew up");
        },
      }));
      const runError = new Error("simulated run failure");
      enqueueCliRunMock.mockImplementationOnce(async () => {
        throw runError;
      });

      await expect(executePreparedCliRun(buildPreparedCliRunContext())).rejects.toBe(runError);

      expect(flushMock).toHaveBeenCalledTimes(1);
      const warnMessages = warnSpy.mock.calls.map((call) => call[0]);
      expect(
        warnMessages.some((msg) => msg.includes("claudeSkillsPlugin.cleanup() rejected")),
      ).toBe(true);
      expect(warnMessages.some((msg) => msg.includes("cleanupImages() rejected"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
