import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntimeTurn } from "../runtime-api.js";
import { makeRuntime, type TestSessionStore } from "./runtime.test-support.js";

function makeEmptySessionStore(): TestSessionStore {
  return {
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => {}),
  };
}

function makeTurn(
  input: { requestId: string },
  overrides: Partial<AcpRuntimeTurn> = {},
): AcpRuntimeTurn {
  return {
    requestId: input.requestId,
    promptStarted: Promise.resolve(),
    events: (async function* () {})(),
    result: Promise.resolve({ status: "completed" }),
    cancel: vi.fn(async () => {}),
    closeStream: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("AcpxRuntime session resume", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    new Error("connection reset while resuming session"),
    Object.assign(new Error("Server overloaded; retry later."), { code: -32001 }),
    Object.assign(new Error("Resource not found: workspace file"), { code: -32002 }),
    new Error('Session "another-session" not found'),
    new Error("no rollout found for thread id another-session"),
    new Error("Session not found"),
    new Error("Unknown session"),
    Object.assign(new Error("Resource not found: session"), { code: -32002 }),
    Object.assign(new Error("Internal error"), {
      code: -32603,
      data: { message: 'Session "another-session" not found' },
    }),
    new Error("Resume failed", { cause: new Error("thread not found: another-session") }),
    Object.assign(new Error("Resource not found: claude-session-retryable"), {
      code: -32002,
      data: { uri: "another-session" },
    }),
    Object.assign(new Error("Server overloaded; retry later."), {
      code: -32001,
      data: { message: 'Session "claude-session-retryable" not found' },
    }),
    Object.assign(new Error("Resume failed"), {
      diagnostics: { message: 'Session "claude-session-retryable" not found' },
    }),
    new Error("no rollout found for thread id claude-session-retryable-extra"),
    new Error("Session not found: claude-session-retryable-extra"),
    new Error("Unknown session: CLAUDE-SESSION-RETRYABLE"),
  ])(
    "preserves ambiguous, unrelated, and transient ensure-time resume failures %#",
    async (resumeError) => {
      const baseStore: TestSessionStore = {
        load: vi.fn(async () => undefined),
        save: vi.fn(async () => {}),
      };
      const { runtime, delegate } = makeRuntime(baseStore);
      vi.spyOn(delegate, "ensureSession").mockRejectedValue(resumeError);

      await expect(
        runtime.ensureSession({
          sessionKey: "agent:claude:acp:transient-resume-failure",
          agent: "claude",
          mode: "oneshot",
          resumeSessionId: "claude-session-retryable",
        }),
      ).rejects.toBe(resumeError);
    },
  );

  it.each([
    [{ sessionCapabilities: { resume: {} } }, true],
    [{ loadSession: true }, true],
    [{ sessionCapabilities: { resume: null } }, false],
  ] as const)("reports ACP session resume capability %#", async (agentCapabilities, expected) => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({ agentCapabilities })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:claude:acp:test",
      backend: "acpx",
      runtimeSessionName: "claude",
    });

    const result = await runtime.ensureSession({
      sessionKey: "agent:claude:acp:test",
      agent: "claude",
      mode: "oneshot",
    });

    expect(result.sessionResumeSupported).toBe(expected);
  });

  it("keeps an ensured session usable when resume capability lookup fails", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => {
        throw new Error("session store read failed");
      }),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:claude:acp:test",
      backend: "acpx",
      runtimeSessionName: "claude",
    });

    await expect(
      runtime.ensureSession({
        sessionKey: "agent:claude:acp:test",
        agent: "claude",
        mode: "oneshot",
      }),
    ).resolves.toMatchObject({
      sessionKey: "agent:claude:acp:test",
      backend: "acpx",
      runtimeSessionName: "claude",
    });
  });

  it("keeps resumed one-shot turns on the resumed backend session", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      })),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    const ensure = vi.spyOn(delegate, "ensureSession").mockResolvedValue({
      sessionKey: "agent:claude:acp:test",
      backend: "acpx",
      runtimeSessionName: "claude",
    });

    await runtime.ensureSession({
      sessionKey: "agent:claude:acp:test",
      agent: "claude",
      mode: "oneshot",
      resumeSessionId: "claude-session-1",
    });

    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "persistent",
        resumeSessionId: "claude-session-1",
      }),
    );
  });

  it.each([
    ['Session "resume-target" not found', true, "resume-target"],
    ["no rollout found for thread id resume-target", true, "resume-target"],
    ["Resource not found: resume-target", true, "resume-target"],
    ["Resource not found: resume-target", false, "another-target"],
    ["Resource not found", false, "resume-target"],
    ["Resource not found: another-target", false, "resume-target"],
    ['Session "another-target" not found', false, "resume-target"],
    ["Session not found", false, "resume-target"],
    ["Resource not found: workspace file", false, "resume-target"],
    ["session/load timed out", false, "resume-target"],
    ["authentication required", false, "resume-target"],
    ["connection reset", false, "resume-target"],
  ] as const)(
    "requires correlated missing-target evidence during reconnect: %s",
    async (reason, missing, outerId) => {
      const { runtime, delegate } = makeRuntime(makeEmptySessionStore());
      vi.spyOn(delegate, "ensureSession").mockResolvedValue({
        sessionKey: "agent:main:acp:resumed-one-shot",
        backend: "acpx",
        runtimeSessionName: "agent:main:acp:resumed-one-shot",
        backendSessionId: "resume-target",
      });
      const handle = await runtime.ensureSession({
        sessionKey: "agent:main:acp:resumed-one-shot",
        agentId: "main",
        agent: "claude",
        mode: "oneshot",
        resumeSessionId: "resume-target",
      });
      const error = {
        code: "ACP_TURN_FAILED",
        detailCode: "SESSION_RESUME_REQUIRED",
        message: `Persistent ACP session ${outerId} could not be resumed: ${reason}`,
        retryable: true,
      };
      vi.spyOn(delegate, "startTurn").mockReturnValue(
        makeTurn(
          { requestId: "reconnect" },
          {
            events: (async function* () {
              yield { type: "error" as const, ...error };
            })(),
            result: Promise.resolve({ status: "failed", error }),
          },
        ),
      );
      const turn = runtime.startTurn({
        handle,
        text: "follow-up",
        mode: "prompt",
        requestId: "reconnect",
      });
      const expected = missing
        ? { ...error, detailCode: "SESSION_RESUME_TARGET_NOT_FOUND", retryable: false }
        : error;
      const events = [];
      for await (const event of turn.events) {
        events.push(event);
      }
      expect(events).toEqual([{ type: "error", ...expected }]);
      expect(await turn.result).toEqual({ status: "failed", error: expected });
    },
  );

  it.each([
    new Error("no rollout found for thread id codex-session-missing"),
    new Error("thread not found: codex-session-missing"),
    new Error("Session codex-session-missing not found"),
    new Error("Unknown session: codex-session-missing"),
    Object.assign(new Error("Resource not found: codex-session-missing"), {
      name: "RequestError",
      code: -32002,
      data: { uri: "codex-session-missing" },
    }),
    Object.assign(new Error("Internal error"), {
      name: "RequestError",
      code: -32603,
      data: "Failed to start session: Session not found: codex-session-missing",
    }),
    Object.assign(new Error("Invalid params"), {
      code: -32602,
      data: { message: 'Session "codex-session-missing" not found' },
    }),
    Object.assign(new Error("Resource not found"), {
      code: -32002,
      data: { uri: "codex-session-missing" },
    }),
    Object.assign(new Error("Resource not found: codex-session-missing"), { code: -32002 }),
    new Error("Resume failed", {
      cause: Object.assign(new Error("Resource not found"), {
        code: -32002,
        data: { uri: "codex-session-missing" },
      }),
    }),
  ])("classifies missing ensure-time resume targets %#", async (resumeError) => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {}),
    };
    const { runtime, delegate } = makeRuntime(baseStore);
    vi.spyOn(delegate, "ensureSession").mockRejectedValue(resumeError);

    await expect(
      runtime.ensureSession({
        sessionKey: "agent:codex:acp:missing-resume-target",
        agent: "codex",
        mode: "oneshot",
        resumeSessionId: "codex-session-missing",
      }),
    ).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      detailCode: "SESSION_RESUME_TARGET_NOT_FOUND",
      cause: resumeError,
    });
  });
});
