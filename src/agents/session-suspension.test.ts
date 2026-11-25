import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Verifies quota suspension records recovery state without blocking shared work.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { QuotaSuspension } from "../config/sessions/types.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { CommandLane } from "../process/lanes.js";
import type { SessionSuspensionParams } from "./session-suspension.js";

const sessionAccessorMocks = vi.hoisted(() => ({
  patchSessionEntryCore: vi.fn(),
}));

vi.mock("../config/sessions/session-accessor.js", () => sessionAccessorMocks);

const sessionKeyResolverMocks = vi.hoisted(() => ({
  resolveStoredSessionKeyForSessionId: vi.fn(async () => ({
    sessionKey: "session-key",
    storePath: "/tmp/openclaw-session-suspension-test/sessions.json",
  })),
}));

vi.mock("./command/session.js", () => sessionKeyResolverMocks);

const suspension = {
  cfg: {},
  sessionId: "session-1",
  reason: "quota_exhausted",
  failedProvider: "openai",
  failedModel: "gpt-5.6-sol",
} satisfies SessionSuspensionParams;
async function recordSuspension(ttlMs = 100, overrides: Partial<SessionSuspensionParams> = {}) {
  const { suspendSession } = await import("./session-suspension.js");
  await suspendSession({ ...suspension, ttlMs, ...overrides });
}
const recoveryMarker = { state: "suspended", failedProvider: "openai", failedModel: "gpt-5.6-sol" };
type SuspensionEntry = { quotaSuspension?: QuotaSuspension };

describe("session suspension", () => {
  beforeEach(() => {
    sessionAccessorMocks.patchSessionEntryCore.mockImplementation(async (_scope, update) =>
      update({}),
    );
  });
  afterEach(async () => {
    const { resetSessionSuspensionStateForTest } =
      await import("./session-suspension.test-support.js");
    resetSessionSuspensionStateForTest();
    resetCommandQueueStateForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
    sessionAccessorMocks.patchSessionEntryCore.mockReset();
    sessionKeyResolverMocks.resolveStoredSessionKeyForSessionId.mockClear();
  });

  it("records a bounded recovery marker without pausing the shared main lane", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const maxConcurrent = getCommandLaneSnapshot(CommandLane.Main).maxConcurrent;
    await recordSuspension(Number.MAX_SAFE_INTEGER);

    const buildPatch = sessionAccessorMocks.patchSessionEntryCore.mock.calls[0]?.[1] as (
      entry: SuspensionEntry,
    ) => SuspensionEntry;
    expect(buildPatch({}).quotaSuspension).toMatchObject({
      ...recoveryMarker,
      expectedResumeBy: 1_000 + MAX_TIMER_TIMEOUT_MS,
    });
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(maxConcurrent);
    await expect(
      enqueueCommandInLane(CommandLane.Main, async () => "unrelated-provider-ok"),
    ).resolves.toBe("unrelated-provider-ok");
  });

  it.each(["session lookup", "marker persistence"])(
    "keeps the shared lane and later suspensions runnable when %s fails",
    async (failure) => {
      let storedMarker: QuotaSuspension | undefined;
      sessionAccessorMocks.patchSessionEntryCore.mockImplementation(async (_scope, update) => {
        const entry = update({});
        storedMarker = entry.quotaSuspension;
        return entry;
      });
      if (failure === "session lookup") {
        sessionKeyResolverMocks.resolveStoredSessionKeyForSessionId.mockRejectedValueOnce(
          new Error("Session history database read was revoked"),
        );
      } else {
        sessionAccessorMocks.patchSessionEntryCore.mockRejectedValueOnce(new Error("disk busy"));
      }

      await expect(recordSuspension()).resolves.toBeUndefined();
      expect(storedMarker).toBeUndefined();
      await expect(enqueueCommandInLane(CommandLane.Main, async () => "still-runs")).resolves.toBe(
        "still-runs",
      );
      await recordSuspension();
      expect(storedMarker).toMatchObject(recoveryMarker);
    },
  );

  it("resolves the session store with the explicit agent id, never the agentDir basename", async () => {
    await recordSuspension(undefined, {
      ttlMs: undefined,
      agentId: "work",
      // Default layout: <state>/agents/<id>/agent — basename is always "agent".
      agentDir: "/state/agents/work/agent",
    });

    expect(sessionKeyResolverMocks.resolveStoredSessionKeyForSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "work" }),
    );
  });

  it("falls back to the registered agent-dir owner when no explicit agent id is given", async () => {
    const { registerResolvedAgentDir, unregisterResolvedAgentDir } =
      await import("./agent-dir-registry.js");
    const owner = { agentId: "research", agentDir: "/state/agents/research/agent" };
    registerResolvedAgentDir(owner);
    try {
      await recordSuspension(undefined, {
        ttlMs: undefined,
        agentDir: owner.agentDir,
        sessionId: "session-2",
      });
    } finally {
      unregisterResolvedAgentDir(owner);
    }

    expect(sessionKeyResolverMocks.resolveStoredSessionKeyForSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "research" }),
    );
  });

  it("serializes same-session writes until the previous committed write returns", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const committed = createDeferred();
    const releaseWrite = createDeferred();
    let storeEntry: { quotaSuspension?: QuotaSuspension } = {};
    let writeCount = 0;
    sessionAccessorMocks.patchSessionEntryCore.mockImplementation(async (_scope, update) => {
      writeCount += 1;
      const patch = update(storeEntry) as typeof storeEntry | null;
      if (patch) {
        storeEntry = { ...storeEntry, ...patch };
      }
      if (writeCount === 1) {
        committed.resolve();
        await releaseWrite.promise;
      }
      return storeEntry;
    });

    const first = recordSuspension();
    await committed.promise;
    clock.mockReturnValue(2_000);
    const second = recordSuspension(200);
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(sessionAccessorMocks.patchSessionEntryCore).toHaveBeenCalledOnce();
      expect(storeEntry.quotaSuspension?.suspendedAt).toBe(1_000);
    } finally {
      releaseWrite.resolve();
      await Promise.all([first, second]);
    }

    expect(sessionAccessorMocks.patchSessionEntryCore).toHaveBeenCalledTimes(2);
    expect(storeEntry.quotaSuspension).toMatchObject({
      suspendedAt: 2_000,
      expectedResumeBy: 2_200,
      ...recoveryMarker,
    });
  });

  it("blocks new state writes until gateway startup re-enables them", async () => {
    const {
      enableSessionSuspensionWritesForGatewayStart,
      fenceSessionSuspensionWritesForGatewayShutdown,
    } = await import("./session-suspension.js");
    fenceSessionSuspensionWritesForGatewayShutdown();
    await recordSuspension();
    expect(sessionAccessorMocks.patchSessionEntryCore).not.toHaveBeenCalled();

    enableSessionSuspensionWritesForGatewayStart();
    await recordSuspension();
    expect(sessionAccessorMocks.patchSessionEntryCore).toHaveBeenCalledOnce();
  });

  it("defers only the outer fallback candidate's marker", async () => {
    const { captureSessionSuspension, runWithDeferredSessionSuspension, suspendSession } =
      await import("./session-suspension.js");
    const onDeferred = vi.fn();

    captureSessionSuspension()(suspension);
    await runWithDeferredSessionSuspension(async () => {
      const deferred = captureSessionSuspension();
      deferred(suspension);
      captureSessionSuspension()(suspension);
    }, onDeferred);
    captureSessionSuspension()(suspension);
    await suspendSession({ ...suspension, cfg: undefined });

    expect(onDeferred).toHaveBeenCalledExactlyOnceWith(suspension);
    expect(sessionAccessorMocks.patchSessionEntryCore).toHaveBeenCalledTimes(3);
  });

  it("maps failover reasons to persisted suspension reasons", async () => {
    const { resolveSessionSuspensionReason } = await import("./session-suspension.js");

    expect(resolveSessionSuspensionReason("rate_limit")).toBe("quota_exhausted");
    expect(resolveSessionSuspensionReason("billing")).toBe("manual");
    expect(resolveSessionSuspensionReason("overloaded")).toBe("circuit_open");
    expect(resolveSessionSuspensionReason("timeout")).toBe("circuit_open");
    expect(resolveSessionSuspensionReason("auth")).toBe("circuit_open");
  });
});
