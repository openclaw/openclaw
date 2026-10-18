import type {
  AcpRuntimeEvent,
  AcpRuntimeTurn,
  AcpRuntimeTurnResult,
} from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import {
  extractStatesFromUpserts,
  installAcpSessionManagerTestLifecycle,
  managerFixture,
  mockMutableSession,
  mockParentedAcpSessionEntries,
  readySessionMeta,
  resolvedIdentity,
  runtimeTurn as turn,
} from "./manager.test-helpers.js";

const runtimeExit = { code: "ACP_TURN_FAILED", message: "acpx exited with code 1" };

describe("AcpSessionManager turn results", () => {
  installAcpSessionManagerTestLifecycle();

  function setupRuntime(meta = readySessionMeta(), sessionKey = "agent:codex:acp:session-1") {
    const f = managerFixture(sessionKey, meta);
    const run = (overrides: Partial<Parameters<typeof f.manager.runTurn>[0]> = {}) =>
      f.run({
        text: "Do work",
        requestId: "turn-result",
        ...overrides,
      });
    const start = (result: (requestId: string) => Partial<AcpRuntimeTurn> = () => ({})) => {
      const startTurn = vi.fn<NonNullable<typeof f.runtimeState.runtime.startTurn>>((input) =>
        turn(input.requestId, result(input.requestId)),
      );
      f.runtimeState.runtime.startTurn = startTurn;
      return startTurn;
    };
    return { ...f.runtimeState, sessionKey, run, start };
  }

  function parentSession(sessionKey: string) {
    mockParentedAcpSessionEntries({
      childSessionKey: sessionKey,
      parentSessionKey: "agent:main:main",
    });
  }

  function setupPersistentRuntime() {
    const sessionKey = "agent:claude:acp:binding:discord:default:retry-no-session";
    const meta = {
      currentMeta: readySessionMeta({
        agent: "claude",
        runtimeSessionName: sessionKey,
        identity: resolvedIdentity({ acpxSessionId: "acpx-sid-stale" }),
      }),
    };
    const state = setupRuntime(meta.currentMeta, sessionKey);
    mockMutableSession(sessionKey, meta);
    state.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
      backendSessionId: input.resumeSessionId ? "acpx-sid-stale" : "acpx-sid-fresh",
    }));
    state.getStatus.mockResolvedValue({
      summary: "status=alive",
      backendSessionId: "acpx-sid-fresh",
      details: { status: "alive" },
    });
    return { state, meta, sessionKey };
  }

  it("rejects expired admission before submitting to the runtime", async () => {
    const state = setupRuntime();
    const startTurn = state.start();
    const onBeforePrompt = vi.fn(() => {
      throw new Error("gateway admission deadline elapsed");
    });
    await expect(state.run({ onBeforePrompt })).rejects.toThrow(
      "gateway admission deadline elapsed",
    );
    expect(onBeforePrompt).toHaveBeenCalledOnce();
    expect(startTurn).not.toHaveBeenCalled();
    expect(state.runTurn).not.toHaveBeenCalled();
  });

  it("notifies submission after readiness and finishes work despite an observer failure", async () => {
    const state = setupRuntime();
    const transitions: string[] = [];
    const result = createDeferred<AcpRuntimeTurnResult>();
    const startTurn = state.start(() => {
      transitions.push("turn-created");
      return {
        promptStarted: Promise.resolve().then(() => {
          transitions.push("prompt-started");
        }),
        result: result.promise,
      };
    });
    await expect(
      state.run({
        onBeforePrompt: () => {
          transitions.push("admission-accepted");
        },
        onLifecycle: () => {
          transitions.push("observer-failed");
          queueMicrotask(() => {
            transitions.push("turn-cleaned-up");
            result.resolve({ status: "completed" });
          });
          throw new Error("lifecycle observer unavailable");
        },
      }),
    ).resolves.toBeUndefined();
    expect(transitions).toEqual([
      "admission-accepted",
      "turn-created",
      "prompt-started",
      "observer-failed",
      "turn-cleaned-up",
    ]);
    expect(startTurn).toHaveBeenCalledOnce();
    expect(state.ensureSession).toHaveBeenCalledOnce();
  });

  it.each(["pending", "rejected"] as const)(
    "retries only after canonical cleanup with %s readiness, without publishing abandoned submission",
    async (readiness) => {
      const state = setupRuntime();
      const promptStarted = createDeferred();
      const result = createDeferred<AcpRuntimeTurnResult>();
      const created = createDeferred();
      const closing = createDeferred();
      const onLifecycle = vi.fn();
      let attempt = 0;
      const startTurn = state.start(() => {
        if (attempt++ > 0) {
          return { promptStarted: Promise.resolve() };
        }
        created.resolve();
        return {
          promptStarted: promptStarted.promise,
          result: result.promise,
          closeStream: vi.fn(async () => {
            closing.resolve();
          }),
        };
      });
      const operation = state.run({ onLifecycle });
      const failure = { status: "failed" as const, error: runtimeExit };
      try {
        await created.promise;
        if (readiness === "rejected") {
          promptStarted.reject(new Error(failure.error.message));
          await closing.promise;
        }
        expect(startTurn).toHaveBeenCalledOnce();
        expect(onLifecycle).not.toHaveBeenCalled();
        result.resolve(failure);
        await operation;
        expect(startTurn).toHaveBeenCalledTimes(2);
        expect(state.ensureSession).toHaveBeenCalledTimes(2);
        expect(onLifecycle).toHaveBeenCalledOnce();
        promptStarted.resolve();
        await Promise.resolve();
        expect(onLifecycle).toHaveBeenCalledOnce();
      } finally {
        promptStarted.resolve();
        result.resolve(failure);
        await operation.catch(() => {});
      }
    },
  );

  it("does not replay a submitted parented prompt after an early runtime exit", async () => {
    await withStateDirEnv("openclaw-acp-manager-", async () => {
      const state = setupRuntime();
      parentSession(state.sessionKey);
      const startTurn = state.start(() => ({
        promptStarted: Promise.resolve(),
        result: Promise.resolve({ status: "failed", error: runtimeExit }),
      }));
      await expect(state.run()).rejects.toMatchObject({
        code: "ACP_TURN_FAILED",
        message: "acpx exited with code 1",
      });
      expect(state.ensureSession).toHaveBeenCalledOnce();
      expect(startTurn).toHaveBeenCalledOnce();
    });
  });

  it.each(["completed", "cancelled"] as const)(
    "drains parented output before publishing the %s terminal result",
    async (status) => {
      await withStateDirEnv("openclaw-acp-manager-", async () => {
        const state = setupRuntime();
        parentSession(state.sessionKey);
        const closed = createDeferred();
        let streamClosed = false;
        const closeStream = vi.fn(async () => {
          streamClosed = true;
          closed.resolve();
        });
        const result: AcpRuntimeTurnResult =
          status === "completed" ? { status, stopReason: "end_turn" } : { status };
        const output = { type: "text_delta", stream: "output", text: "partial output" } as const;
        state.start(() => ({
          events: (async function* () {
            await Promise.resolve();
            if (streamClosed) {
              return;
            }
            yield output;
            if (status === "completed") {
              await closed.promise;
            }
          })(),
          result: Promise.resolve(result),
          closeStream,
        }));
        const events: AcpRuntimeEvent[] = [];
        await state.run({
          onEvent: (event) => {
            events.push(event);
          },
        });
        expect(state.runTurn).not.toHaveBeenCalled();
        expect(closeStream).toHaveBeenCalledWith({ reason: `turn-result-${status}` });
        expect(events).toEqual([
          { type: "text_delta", stream: "output", text: "partial output" },
          { type: "done", ...result },
        ]);
        const states = extractStatesFromUpserts();
        expect(states).toEqual(expect.arrayContaining(["running", "idle"]));
        expect(states).not.toContain("error");
      });
    },
  );

  it.each([
    ["incomplete stream", "ACP turn ended without a terminal done event."],
    ["generic Internal error without resume-required detail", "Internal error"],
  ])("does not retry or discard a persistent session after %s", async (kind, message) => {
    const { state } = setupPersistentRuntime();
    state.runTurn.mockImplementation(async function* () {
      if (kind !== "incomplete stream") {
        yield { type: "error", code: "ACP_TURN_FAILED", message };
      }
    });
    await expect(state.run()).rejects.toMatchObject({ code: "ACP_TURN_FAILED", message });
    if (kind === "incomplete stream") {
      const states = extractStatesFromUpserts();
      expect(states).toContain("running");
      expect(states.at(-1)).toBe("error");
    }
    expect(state.prepareFreshSession).not.toHaveBeenCalled();
    expect(state.ensureSession).toHaveBeenCalledOnce();
    if (kind !== "incomplete stream") {
      expect(state.runTurn).toHaveBeenCalledOnce();
    }
  });

  it("marks the session errored when runtime initialization fails before turn start", async () => {
    const state = setupRuntime(readySessionMeta({ state: "running" }));
    state.ensureSession.mockRejectedValue(new Error("acpx exited with code 1"));
    await expect(state.run()).rejects.toMatchObject({
      code: "ACP_SESSION_INIT_FAILED",
      message: "acpx exited with code 1",
    });
    const states = extractStatesFromUpserts();
    expect(states).not.toContain("running");
    expect(states.at(-1)).toBe("error");
  });

  it.each(["event", "cause"] as const)(
    "discards stale persistent identity for a structured resume-required %s with generic wording",
    async (source) => {
      const { state, meta, sessionKey } = setupPersistentRuntime();
      state.runTurn.mockImplementationOnce(async function* () {
        const message =
          "Persistent ACP session acpx-sid-stale could not be resumed: Internal error";
        const detailCode = "SESSION_RESUME_REQUIRED";
        if (source === "cause") {
          throw Object.assign(new Error(message), { detailCode });
        }
        yield { type: "error" as const, code: "NO_SESSION", detailCode, message };
      });
      await expect(state.run()).resolves.toBeUndefined();
      const persistedHandle = {
        sessionKey,
        agentId: "claude",
        backend: "acpx",
        runtimeSessionName: `${sessionKey}:persistent:runtime`,
        cwd: undefined,
        acpxRecordId: undefined,
      };
      expect(state.prepareFreshSession.mock.calls).toEqual([
        [
          {
            sessionKey,
            agentId: "claude",
            persistedHandle: { ...persistedHandle, backendSessionId: "acpx-sid-stale" },
          },
        ],
        [{ sessionKey, agentId: "claude", persistedHandle }],
      ]);
      expect(state.ensureSession).toHaveBeenCalledTimes(2);
      expect(state.ensureSession.mock.calls[0]?.[0]).toMatchObject({
        sessionKey,
        agentId: "claude",
        resumeSessionId: "acpx-sid-stale",
      });
      expect(state.ensureSession.mock.calls[1]?.[0].resumeSessionId).toBeUndefined();
      expect(state.ensureSession.mock.calls[1]?.[0].agentId).toBe("claude");
      expect(meta.currentMeta.identity).toMatchObject({
        acpxSessionId: "acpx-sid-fresh",
        state: "resolved",
      });
      const states = extractStatesFromUpserts();
      expect(states).toEqual(expect.arrayContaining(["running", "idle"]));
      expect(states).not.toContain("error");
    },
  );
});
