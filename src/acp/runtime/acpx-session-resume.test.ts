import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { AcpRuntime } from "./types.js";

// Phase 1.3 / Task 7 / Gap 3 — red-light TDD spec for ACP session resume across
// gateway restarts.
//
// Symptom (from docs/plans/2026-05-08-acp-native-session-investigation.md):
//   After a gateway restart, the persisted ACP session record on disk still
//   shows `closed: false` and a stale subprocess PID. Copilot CLI advertises
//   `loadSession: true` capability, and its `events.jsonl` retains the full
//   conversation, but openclaw never proactively re-attaches: it neither
//   walks persisted sessions on gateway start nor calls `session/load` to
//   rehydrate them. Follow-up messages then fail with
//   `ACP_SESSION_INIT_FAILED: ACP metadata is missing` (or otherwise lose the
//   prior conversation history when openclaw silently spawns a fresh PID).
//
// What this test specifies:
//   On gateway start (the closest existing call site is
//   `AcpSessionManager.reconcilePendingSessionIdentities`), the manager MUST
//   walk persisted ACP sessions whose process is dead and re-attach them by
//   calling `runtime.ensureSession({ resumeSessionId: <persisted id> })` so
//   the underlying ACP server is asked to `session/load` (the wire-level
//   equivalent advertised by `loadSession: true`).
//
// Why this is expected to fail RED today:
//   `reconcilePendingSessionIdentities` (manager.core.ts:234) explicitly
//   filters OUT any session whose identity is already `resolved` —
//   exactly the case the plan describes. There is no other gateway-start
//   hook that re-establishes live runtime handles. The test therefore reads
//   red because no current code path calls `runtime.ensureSession` from a
//   startup scan for a `closed: false` resolved-identity session.
//
// Test seam:
//   The manager talks to the runtime via the registered backend. We mock
//   `listAcpSessionEntries` (the persisted-store walker), `readAcpSessionEntry`
//   (the lazy lookup used by `runTurn` after the warm restore), and the
//   runtime backend registry, and then drive the existing startup scan.
//
// What we are NOT doing:
//   - We do not modify any production source.
//   - We do not invent a new public seam ("warmRestoreActiveSessions") just
//     to make the test pass; the test asserts behavior on the existing
//     scan because the gap IS that the existing scan does not cover this
//     case.
//   - We do not assert on `prepareFreshSession` paths because the desired
//     recovery is RESUME, not reset.

const hoisted = vi.hoisted(() => {
  return {
    listAcpSessionEntriesMock: vi.fn(),
    readAcpSessionEntryMock: vi.fn(),
    upsertAcpSessionMetaMock: vi.fn(),
    requireAcpRuntimeBackendMock: vi.fn(),
    getAcpRuntimeBackendMock: vi.fn(),
  };
});

vi.mock("./session-meta.js", () => ({
  listAcpSessionEntries: (params: unknown) => hoisted.listAcpSessionEntriesMock(params),
  readAcpSessionEntry: (params: unknown) => hoisted.readAcpSessionEntryMock(params),
  upsertAcpSessionMeta: (params: unknown) => hoisted.upsertAcpSessionMetaMock(params),
}));

vi.mock("./registry.js", () => ({
  getAcpRuntimeBackend: (backendId?: string) => hoisted.getAcpRuntimeBackendMock(backendId),
  requireAcpRuntimeBackend: (backendId?: string) => hoisted.requireAcpRuntimeBackendMock(backendId),
}));

const { AcpSessionManager, __testing } = await import("../control-plane/manager.js");

const baseCfg = {
  acp: {
    enabled: true,
    backend: "acpx",
    dispatch: { enabled: true },
  },
} as const satisfies OpenClawConfig;

type RuntimeRecorder = {
  runtime: AcpRuntime;
  ensureSession: ReturnType<typeof vi.fn>;
  runTurn: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  prepareFreshSession: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function createRecordingRuntime(): RuntimeRecorder {
  const ensureSession = vi.fn(
    async (input: {
      sessionKey: string;
      agent: string;
      mode: "persistent" | "oneshot";
      resumeSessionId?: string;
    }) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
      // Echo the resumeSessionId on the handle so callers can verify the
      // plumbing without needing wire-level loadSession instrumentation.
      ...(input.resumeSessionId ? { backendSessionId: input.resumeSessionId } : {}),
    }),
  );
  const runTurn = vi.fn(async function* () {
    yield { type: "done" as const };
  });
  const getStatus = vi.fn(async () => ({ summary: "alive" }));
  const prepareFreshSession = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  return {
    runtime: {
      ensureSession,
      runTurn,
      getStatus,
      prepareFreshSession,
      cancel,
      close,
    },
    ensureSession,
    runTurn,
    getStatus,
    prepareFreshSession,
    cancel,
    close,
  };
}

function makeResolvedIdleSessionMeta(overrides: Partial<SessionAcpMeta> = {}): SessionAcpMeta {
  // Mirrors the on-disk shape after a gateway crash: the session was
  // healthy (state=idle, identity=resolved with a real acpxSessionId / agent
  // session id), but the linked subprocess is gone after the restart. The
  // `closed: false` invariant lives on the SessionEntry one level up, but
  // for this test the SessionAcpMeta state="idle" is the readiness signal
  // the manager reads.
  return {
    backend: "acpx",
    agent: "copilot",
    runtimeSessionName: "agent:copilot:acp:resumable",
    mode: "persistent",
    state: "idle",
    lastActivityAt: Date.now() - 60_000,
    identity: {
      state: "resolved",
      source: "status",
      acpxSessionId: "acpx-sid-resumable-1",
      agentSessionId: "copilot-sid-resumable-1",
      lastUpdatedAt: Date.now() - 60_000,
    },
    ...overrides,
  };
}

describe("ACP gateway-start session resume (Gap 3)", () => {
  beforeEach(() => {
    __testing.resetAcpSessionManagerForTests();
    hoisted.listAcpSessionEntriesMock.mockReset().mockResolvedValue([]);
    hoisted.readAcpSessionEntryMock.mockReset();
    hoisted.upsertAcpSessionMetaMock.mockReset().mockResolvedValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockReset();
    hoisted.getAcpRuntimeBackendMock.mockReset().mockImplementation((backendId?: string) => {
      try {
        return hoisted.requireAcpRuntimeBackendMock(backendId);
      } catch {
        return null;
      }
    });
  });

  afterEach(() => {
    __testing.resetAcpSessionManagerForTests();
  });

  it("re-attaches `closed: false` ACP sessions on gateway start by calling ensureSession with the persisted resumeSessionId", async () => {
    // ARRANGE — one persisted session whose identity is already `resolved`
    // (the real-world post-crash shape; the prior subprocess is gone but
    // the identity record on disk still carries a known agent_session_id
    // that the underlying ACP server can rehydrate via session/load).
    const sessionKey = "agent:copilot:acp:resumable";
    const persistedMeta = makeResolvedIdleSessionMeta();
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/fake/store.json",
        sessionKey,
        storeSessionKey: sessionKey,
        acp: persistedMeta,
        entry: {
          updatedAt: persistedMeta.lastActivityAt,
          acp: persistedMeta,
        },
      },
    ]);
    // Lazy-resume path also reads the same record by key when the manager
    // resolves the session in-flight.
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: persistedMeta,
    });

    const runtimeRecorder = createRecordingRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeRecorder.runtime,
    });

    const manager = new AcpSessionManager();

    // ACT — drive the only existing gateway-start scan over persisted ACP
    // sessions. Today this method is `reconcilePendingSessionIdentities`;
    // a future warm-restore implementation may replace or extend it, but
    // the spec is location-agnostic: SOME startup hook must re-attach
    // resolved-identity sessions whose subprocess is dead.
    await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    // ASSERT — the manager MUST have asked the runtime to re-attach this
    // session by passing the persisted session id, so that the runtime
    // can in turn issue an ACP `session/load` (the wire-level capability
    // copilot advertises as `loadSession: true`).
    //
    // FAILURE MODE TODAY:
    //   `reconcilePendingSessionIdentities` filters out resolved-identity
    //   sessions (manager.core.ts:256-261), so `ensureSession` is never
    //   called from the startup scan. The expected call count is 1; the
    //   actual call count is 0. The test therefore reads RED for the
    //   right reason: the warm-restore code path does not exist.
    expect(runtimeRecorder.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        agent: "copilot",
        mode: "persistent",
        // Either acpxSessionId or agentSessionId is acceptable; the
        // manager prefers agentSessionId when present (see
        // resolveRuntimeResumeSessionId in session-identity.ts).
        resumeSessionId: expect.stringMatching(/^(copilot-sid-resumable-1|acpx-sid-resumable-1)$/),
      }),
    );
    expect(runtimeRecorder.ensureSession).toHaveBeenCalledTimes(1);
  });

  it("passes the persisted conversation identity through to ensureSession exactly once per resumable session", async () => {
    // ARRANGE — two persisted resumable sessions; the warm-restore loop
    // should re-attach each one independently with its own resumeSessionId.
    // This guards against a future implementation that scans but only
    // re-attaches the first record.
    const sessionA = "agent:copilot:acp:resumable-a";
    const sessionB = "agent:copilot:acp:resumable-b";
    const metaA = makeResolvedIdleSessionMeta({
      runtimeSessionName: sessionA,
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-a",
        agentSessionId: "copilot-sid-a",
        lastUpdatedAt: Date.now(),
      },
    });
    const metaB = makeResolvedIdleSessionMeta({
      runtimeSessionName: sessionB,
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-b",
        agentSessionId: "copilot-sid-b",
        lastUpdatedAt: Date.now(),
      },
    });
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/fake/store.json",
        sessionKey: sessionA,
        storeSessionKey: sessionA,
        acp: metaA,
        entry: { updatedAt: metaA.lastActivityAt, acp: metaA },
      },
      {
        cfg: baseCfg,
        storePath: "/fake/store.json",
        sessionKey: sessionB,
        storeSessionKey: sessionB,
        acp: metaB,
        entry: { updatedAt: metaB.lastActivityAt, acp: metaB },
      },
    ]);
    hoisted.readAcpSessionEntryMock.mockImplementation((paramsUnknown: unknown) => {
      const key = (paramsUnknown as { sessionKey?: string }).sessionKey;
      if (key === sessionA) {
        return { sessionKey: sessionA, storeSessionKey: sessionA, acp: metaA };
      }
      if (key === sessionB) {
        return { sessionKey: sessionB, storeSessionKey: sessionB, acp: metaB };
      }
      return null;
    });

    const runtimeRecorder = createRecordingRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeRecorder.runtime,
    });

    const manager = new AcpSessionManager();

    // ACT
    await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    // ASSERT — both sessions get re-attached, each with its own resume id.
    // FAILURE MODE TODAY: zero ensureSession calls; today's scan filters
    // both records as already-resolved.
    const ensureCalls = runtimeRecorder.ensureSession.mock.calls.map(([input]) => input);
    expect(ensureCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionKey: sessionA,
          resumeSessionId: expect.stringMatching(/^(copilot-sid-a|acpx-sid-a)$/),
        }),
        expect.objectContaining({
          sessionKey: sessionB,
          resumeSessionId: expect.stringMatching(/^(copilot-sid-b|acpx-sid-b)$/),
        }),
      ]),
    );
    expect(runtimeRecorder.ensureSession).toHaveBeenCalledTimes(2);
  });
});
