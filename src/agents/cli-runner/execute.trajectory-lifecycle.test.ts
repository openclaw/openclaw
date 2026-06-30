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

import type { CliBackendConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CliOutput } from "../cli-output.js";
import { executePreparedCliRun } from "./execute.js";
import type { PreparedCliRunContext } from "./types.js";

function buildPreparedCliRunContext(): PreparedCliRunContext {
  const backend = {
    command: "agent-cli",
    args: [],
    output: "text",
    input: "stdin",
    serialize: true,
  } as CliBackendConfig;

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
    } as PreparedCliRunContext["params"],
    started: 0,
    workspaceDir: "/tmp",
    backendResolved: {
      id: "codex-cli",
      config: backend,
      bundleMcp: false,
    } as PreparedCliRunContext["backendResolved"],
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: {} as PreparedCliRunContext["reusableCliSession"],
    hadSessionFile: false,
    contextEngineConfig: {} as OpenClawConfig,
    modelId: "model",
    normalizedModel: "model",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

function recordedEventTypes(): string[] {
  return recordEventMock.mock.calls.map((call) => call[0] as string);
}

describe("executePreparedCliRun trajectory lifecycle", () => {
  beforeEach(() => {
    recordEventMock.mockReset();
    flushMock.mockReset();
    flushMock.mockImplementation(async () => {});
    prepareCliPromptImagePayloadMock.mockReset();
    prepareCliPromptImagePayloadMock.mockResolvedValue({
      prompt: "hi",
      imagePaths: [],
      cleanupImages: undefined,
    });
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

  it("emits the full lifecycle and flushes once on a successful CLI run", async () => {
    const output: CliOutput = { text: "done", sessionId: "cli-1" };
    enqueueCliRunMock.mockResolvedValueOnce(output);

    await expect(executePreparedCliRun(buildPreparedCliRunContext())).resolves.toBe(output);

    expect(recordedEventTypes()).toEqual([
      "session.started",
      "prompt.submitted",
      "model.completed",
      "session.ended",
    ]);
    const modelCompleted = recordEventMock.mock.calls.find((call) => call[0] === "model.completed");
    expect(modelCompleted?.[1]).toMatchObject({ cliSessionId: "cli-1" });
    const sessionEnded = recordEventMock.mock.calls.find((call) => call[0] === "session.ended");
    expect(sessionEnded?.[1]).toMatchObject({ status: "success" });
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  it("records a single error session.ended and flushes when the run rejects", async () => {
    const runError = new Error("cli run blew up");
    enqueueCliRunMock.mockRejectedValueOnce(runError);

    await expect(executePreparedCliRun(buildPreparedCliRunContext())).rejects.toBe(runError);

    const types = recordedEventTypes();
    expect(types).toContain("prompt.submitted");
    expect(types).not.toContain("model.completed");
    expect(types.filter((type) => type === "session.ended")).toHaveLength(1);
    const sessionEnded = recordEventMock.mock.calls.find((call) => call[0] === "session.ended");
    expect(sessionEnded?.[1]).toMatchObject({
      status: "error",
      error: expect.stringContaining("cli run blew up"),
    });
    expect(flushMock).toHaveBeenCalledTimes(1);
  });
});
