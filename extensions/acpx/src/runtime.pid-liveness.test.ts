import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntime } from "../runtime-api.js";
import { AcpxRuntime } from "./runtime.js";

// =============================================================================
// Catalog #13 RED test — `canReuseStablePersistentSession` PID-liveness check
// =============================================================================
//
// Today, `canReuseStablePersistentSession` (extensions/acpx/src/runtime.ts:666-692)
// verifies metadata invariants only: mode, cwd, agentCommand, acpSessionId. It
// does NOT call `process.kill(pid, 0)` or otherwise verify the persisted
// session's subprocess is alive.
//
// Once the catalog #2 fix lands and warm-restore drives
// `ensureSession({ resumeSessionId })` for `closed: false` records whose
// persisted PID is from a dead pre-restart subprocess, this path will
// silently attempt to "reuse" a session whose process no longer exists.
// `runWithLaunchLease` will be called with `enabled: false` (skipping the
// lease save) and the delegate will be asked to attach to nothing.
//
// EXPECTED RED today:
//   - The persisted record has pid=99999999 (definitely-dead PID).
//   - resumeSessionId matches the record's acpSessionId.
//   - Other metadata (cwd, agentCommand) matches.
//   - Predicate returns true → reuse → leaseStore.save NOT called.
//   - Test asserts leaseStore.save WAS called once → fails today.
//
// FIXED (GREEN) shape:
//   - Predicate detects the dead PID via `process.kill(pid, 0)` (or equivalent),
//     returns false → triggers fresh launch → leaseStore.save called once.
//
// Sharpness: a fix that adds liveness checking but on the WRONG branch (e.g.,
// only inside the resumeSessionId-match check, not in the cwd/command branch)
// would still pass the dead-PID arm here because the test exercises a record
// that matches all metadata invariants. Conversely, a fix that returns false
// for ALL records (including alive-PID) would fail the control test.
// =============================================================================

const ACPX_WRAPPER_COMMAND = `node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"`;
const SESSION_KEY = "agent:codex:acp:binding:test";
const ACP_SESSION_ID = "session-1";
// PID well above any plausible Linux PID (kernel.pid_max default 4194304;
// max is 2^22-ish). 99999999 reliably triggers ESRCH from process.kill(pid, 0).
const DEAD_PID = 99_999_999;

type TestSessionStore = {
  load(sessionId: string): Promise<Record<string, unknown> | undefined>;
  save(record: Record<string, unknown>): Promise<void>;
};

function makeLeaseStore() {
  const leases = new Map<string, Record<string, unknown>>();
  return {
    leases,
    store: {
      load: vi.fn(async (leaseId: string) => leases.get(leaseId) as never),
      listOpen: vi.fn(async () => Array.from(leases.values()) as never),
      save: vi.fn(async (lease: Record<string, unknown>) => {
        leases.set(String(lease.leaseId), lease);
      }),
      markState: vi.fn(async (leaseId: string, state: string) => {
        const lease = leases.get(leaseId);
        if (lease) {
          lease.state = state;
        }
      }),
    },
  };
}

function makePersistedRecord(pid: number) {
  return {
    name: SESSION_KEY,
    acpxRecordId: "record-1",
    acpSessionId: ACP_SESSION_ID,
    agentCommand: ACPX_WRAPPER_COMMAND,
    cwd: "/tmp",
    closed: false,
    pid,
  };
}

function makeFixture(persistedPid: number) {
  const baseStore: TestSessionStore = {
    load: vi.fn(async () => makePersistedRecord(persistedPid)),
    save: vi.fn(async () => {}),
  };
  const leaseStore = makeLeaseStore();
  const runtime = new AcpxRuntime({
    cwd: "/tmp",
    sessionStore: baseStore,
    agentRegistry: {
      resolve: (agentName: string) => (agentName === "codex" ? ACPX_WRAPPER_COMMAND : agentName),
      list: () => ["codex"],
    },
    permissionMode: "approve-reads",
    openclawGatewayInstanceId: "gateway-test",
    openclawProcessLeaseStore: leaseStore.store,
    openclawWrapperRoot: "/tmp/openclaw/acpx",
  });
  const delegate = (
    runtime as unknown as {
      delegate: { ensureSession: AcpRuntime["ensureSession"] };
    }
  ).delegate;
  vi.spyOn(delegate, "ensureSession").mockImplementation(async (input) => ({
    sessionKey: input.sessionKey,
    backend: "acpx",
    runtimeSessionName: input.sessionKey,
  }));
  return { runtime, baseStore, leaseStore };
}

describe("AcpxRuntime canReuseStablePersistentSession — PID liveness (catalog #13)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("RED today: persisted record with a dead PID should NOT be reused on resume", async () => {
    // The persisted record matches all metadata invariants AND has a dead PID.
    // Today the predicate returns true (no liveness check) → reuse → no lease.
    // After the fix, the predicate detects the dead PID → fresh launch → one
    // lease save.
    const { runtime, leaseStore } = makeFixture(DEAD_PID);

    // Sanity: confirm the chosen PID really is dead, so a future regression
    // that picks a coincidentally-live PID surfaces as a setup failure rather
    // than a misleading test pass.
    expect(() => process.kill(DEAD_PID, 0)).toThrow();

    await runtime.ensureSession({
      sessionKey: SESSION_KEY,
      agent: "codex",
      mode: "persistent",
      resumeSessionId: ACP_SESSION_ID,
    });

    // The discriminating signal: when reuse is rejected, runWithLaunchLease
    // saves a fresh lease before the delegate spawns. When reuse is accepted,
    // it does not. Today we get 0 calls — fix flips this to 1.
    expect(
      leaseStore.store.save,
      "canReuseStablePersistentSession returned true for a dead-PID record; " +
        "expected predicate to detect the dead subprocess and trigger a fresh " +
        "launch (one leaseStore.save). See catalog #13 — predicate currently " +
        "verifies metadata invariants only, no process.kill(pid, 0) check.",
    ).toHaveBeenCalledTimes(1);
  });

  it("control: persisted record with an alive PID is reused on resume (no fresh launch)", async () => {
    // Use this very test process's PID — guaranteed alive while the test runs.
    // Proves the test infrastructure exercises the reuse path correctly today
    // and pins the alive-PID branch so a fix that over-rejects (returns false
    // for everything) gets caught.
    const { runtime, leaseStore } = makeFixture(process.pid);

    await runtime.ensureSession({
      sessionKey: SESSION_KEY,
      agent: "codex",
      mode: "persistent",
      resumeSessionId: ACP_SESSION_ID,
    });

    expect(
      leaseStore.store.save,
      "alive-PID record should be reused; observed a fresh-launch lease save. " +
        "A fix to the predicate must keep the alive-PID reuse path working.",
    ).not.toHaveBeenCalled();
  });
});
