import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as helpers from "../pi-embedded-helpers.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { runEmbeddedAttempt } from "./run/attempt.js";

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
  },
}));

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);
const mockedIsThinkingImmutabilityError = vi.mocked(helpers.isThinkingImmutabilityError);

const THINKING_IMMUTABILITY_ERROR =
  "thinking or redacted_thinking blocks in the messages cannot be modified";

describe("runEmbeddedPiAgent thinking immutability recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-resets the session file and retries when the error is detected", async () => {
    const { default: fs } = await import("node:fs/promises");
    const mockedWriteFile = vi.mocked(fs.writeFile);

    mockedIsThinkingImmutabilityError.mockReturnValue(true);
    // First attempt: immutability error. Second attempt: success after reset.
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({ promptError: new Error(THINKING_IMMUTABILITY_ERROR) }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    expect(mockedWriteFile).toHaveBeenCalledWith("/tmp/session.json", "");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.error).toBeUndefined();
  });

  it("falls back to error payload when sessionFile is empty", async () => {
    mockedIsThinkingImmutabilityError.mockReturnValue(true);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ promptError: new Error(THINKING_IMMUTABILITY_ERROR) }),
    );

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    expect(result.meta.error?.kind).toBe("thinking_immutability");
    const payload = result.payloads?.[0];
    expect(payload?.isError).toBe(true);
    expect(payload?.text).toMatch(/\/new|\/reset/i);
  });

  it("does not retry auto-reset a second time if the error persists", async () => {
    const { default: fs } = await import("node:fs/promises");
    const mockedWriteFile = vi.mocked(fs.writeFile);

    mockedIsThinkingImmutabilityError.mockReturnValue(true);
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({ promptError: new Error(THINKING_IMMUTABILITY_ERROR) }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({ promptError: new Error(THINKING_IMMUTABILITY_ERROR) }),
      );

    const result = await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    expect(result.meta.error?.kind).toBe("thinking_immutability");
  });

  it("does not trigger for unrelated prompt errors", async () => {
    mockedIsThinkingImmutabilityError.mockReturnValue(false);
    mockedRunEmbeddedAttempt.mockRejectedValueOnce(new Error("unexpected internal error"));

    await expect(
      runEmbeddedPiAgent({
        sessionId: "test-session",
        sessionKey: "test-key",
        sessionFile: "/tmp/session.json",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        timeoutMs: 30000,
        runId: "run-1",
      }),
    ).rejects.toThrow("unexpected internal error");
  });
});
