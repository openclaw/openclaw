import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordEventMock, flushMock, prepareCliPromptImagePayloadMock } = vi.hoisted(() => ({
  recordEventMock: vi.fn(),
  flushMock: vi.fn(async () => {}),
  prepareCliPromptImagePayloadMock: vi.fn(),
}));

vi.mock("../../trajectory/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../trajectory/runtime.js")>();
  return {
    ...actual,
    createTrajectoryRuntimeRecorder: vi.fn(() => ({
      enabled: true as const,
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
});
