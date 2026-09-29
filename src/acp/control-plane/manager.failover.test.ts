import { describe, expect, it, vi } from "vitest";
import {
  AcpRuntimeError,
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
} from "./manager.test-helpers.js";
import type { AcpRunTurnInput, WriteManagerSessionMeta } from "./manager.types.js";

function fixture(primaryUnavailableError?: Error) {
  const primary = createRuntime();
  const fallback = createRuntime();
  const sessionKey = "agent:codex:acp:failover";
  let meta = readySessionMeta({ backend: "primary", runtimeSessionName: "primary-runtime" });
  for (const [backend, runtime] of [
    ["primary", primary],
    ["fallback", fallback],
  ] as const) {
    runtime.ensureSession.mockImplementation(async () => ({
      sessionKey,
      backend,
      runtimeSessionName: `${backend}-runtime`,
    }));
  }
  hoisted.requireAcpRuntimeBackendMock.mockImplementation((backend?: string) => {
    if (backend === "primary" && primaryUnavailableError) {
      throw primaryUnavailableError;
    }
    if (backend !== "primary" && backend !== "fallback") {
      throw new Error(`Unexpected backend ${backend}`);
    }
    return { id: backend, runtime: backend === "primary" ? primary.runtime : fallback.runtime };
  });
  hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
    sessionKey,
    storeSessionKey: sessionKey,
    acp: meta,
  }));
  hoisted.upsertAcpSessionMetaMock.mockImplementation(
    async (input: Parameters<WriteManagerSessionMeta>[0]) => {
      meta = input.mutate(meta, { acp: meta, sessionId: "failover", updatedAt: 1 }) ?? meta;
      return { sessionId: "failover", updatedAt: 1, acp: meta };
    },
  );
  const cfg = { acp: { ...baseCfg.acp, backend: "primary", fallbacks: ["fallback"] } };
  const manager = new AcpSessionManager();
  return {
    primary,
    fallback,
    readMeta: () => meta,
    turn(requestId: string, observers: Pick<AcpRunTurnInput, "onEvent" | "onLifecycle"> = {}) {
      return manager.runTurn({
        cfg,
        sessionKey,
        provenance: "system",
        mode: "prompt",
        text: requestId,
        requestId,
        ...observers,
      });
    },
  };
}

describe("AcpSessionManager backend failover", () => {
  installAcpSessionManagerTestLifecycle();

  it("closes replaced handles when failing over and returning the next turn to primary", async () => {
    const f = fixture();
    f.primary.runTurn.mockImplementationOnce(async function* () {
      yield* [];
      throw new AcpRuntimeError("ACP_TURN_FAILED", "backend unavailable");
    });
    await f.turn("fallback");
    expect(f.readMeta().backend).toBe("fallback");
    expect(f.fallback.runTurn).toHaveBeenCalledOnce();
    expect(f.primary.close).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "backend-failover" }),
    );
    f.fallback.close.mockClear();
    await f.turn("primary");
    expect(f.fallback.close).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "runtime-handle-replaced" }),
    );
    expect(f.primary.runTurn).toHaveBeenCalledTimes(2);
    expect(f.readMeta().backend).toBe("primary");
  });

  it("fails over when the primary backend is registered but unavailable", async () => {
    const f = fixture(
      new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", "primary backend unavailable"),
    );
    await f.turn("unavailable");
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("primary");
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("fallback");
    expect(f.fallback.runTurn).toHaveBeenCalledOnce();
  });

  it("does not fail over after prompt submission even when no output was emitted", async () => {
    const f = fixture();
    const startTurn = vi.fn<NonNullable<typeof f.primary.runtime.startTurn>>((input) => ({
      requestId: input.requestId,
      promptStarted: Promise.resolve(),
      events: (async function* () {})(),
      result: Promise.resolve({
        status: "failed",
        error: { code: "ACP_TURN_FAILED", message: "backend unavailable" },
      }),
      cancel: vi.fn(async () => {}),
      closeStream: vi.fn(async () => {}),
    }));
    f.primary.runtime.startTurn = startTurn;
    await expect(f.turn("submitted")).rejects.toMatchObject({
      code: "ACP_TURN_FAILED",
      message: "backend unavailable",
    });
    expect(startTurn).toHaveBeenCalledOnce();
    expect(f.fallback.runTurn).not.toHaveBeenCalled();
  });

  it("fails over only after rejected prompt readiness reaches canonical terminal cleanup", async () => {
    const f = fixture();
    const transitions: string[] = [];
    const promptStarted = Promise.reject(new Error("backend unavailable"));
    promptStarted.catch(() => {});
    f.primary.runtime.startTurn = vi.fn((input) => ({
      requestId: input.requestId,
      promptStarted,
      events: (async function* () {})(),
      result: Promise.resolve().then(() => {
        transitions.push("primary-cleaned-up");
        return {
          status: "failed" as const,
          error: { code: "ACP_TURN_FAILED", message: "backend unavailable" },
        };
      }),
      cancel: vi.fn(async () => {}),
      closeStream: vi.fn(async () => {}),
    }));
    f.fallback.runTurn.mockImplementation(async function* () {
      transitions.push("fallback-started");
      yield { type: "done" };
    });
    const lifecycleEvents: string[] = [];
    await f.turn("unsubmitted", {
      onLifecycle: (event) => {
        lifecycleEvents.push(event.type);
      },
    });
    expect(transitions).toEqual(["primary-cleaned-up", "fallback-started"]);
    expect(lifecycleEvents).toEqual(["prompt_submitted"]);
    expect(f.fallback.runTurn).toHaveBeenCalledOnce();
  });

  it("does not fail over after a backend has emitted output", async () => {
    const f = fixture();
    f.primary.runTurn.mockImplementation(async function* () {
      yield { type: "text_delta", text: "partial" };
      throw new AcpRuntimeError("ACP_TURN_FAILED", "backend unavailable");
    });
    const events: unknown[] = [];
    await expect(
      f.turn("output", {
        onEvent: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toMatchObject({ code: "ACP_TURN_FAILED" });
    expect(events).toEqual([expect.objectContaining({ type: "text_delta", text: "partial" })]);
    expect(f.fallback.runTurn).not.toHaveBeenCalled();
  });
});
