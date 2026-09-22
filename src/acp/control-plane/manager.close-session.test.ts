/** Close semantics: `/acp close` keeps a terminal row, discarding closes delete it. */
import { describe, expect, it } from "vitest";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

const SESSION_KEY = "agent:codex:acp:session-1";

function mockStoredMeta(meta: SessionAcpMeta): void {
  hoisted.readAcpSessionEntryMock.mockReturnValue({
    sessionKey: SESSION_KEY,
    storeSessionKey: SESSION_KEY,
    entry: { sessionId: "session-1", updatedAt: Date.now() },
    acp: meta,
  });
}

/** Records what each metadata write asked to persist: a row, or `null` for delete. */
function captureMetaWrites(current: SessionAcpMeta): Array<SessionAcpMeta | null | undefined> {
  const writes: Array<SessionAcpMeta | null | undefined> = [];
  hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as {
      mutate: (
        meta: SessionAcpMeta | undefined,
        entry: { acp?: SessionAcpMeta } | undefined,
      ) => SessionAcpMeta | null | undefined;
    };
    const next = params.mutate(current, { acp: current });
    writes.push(next);
    return next ? { sessionId: "session-1", updatedAt: Date.now(), acp: next } : null;
  });
  return writes;
}

function closedSessionMeta(): SessionAcpMeta {
  return readySessionMeta({
    state: "closed",
    lastActivityAt: 1_700_000_000_000,
    closedAt: 1_700_000_000_000,
  });
}

describe("AcpSessionManager close semantics", () => {
  installAcpSessionManagerTestLifecycle();

  it("keeps a closed row for a non-discarding metadata-clearing close", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const current = readySessionMeta({
      identity: { state: "resolved", acpxSessionId: "acpx-1", source: "ensure", lastUpdatedAt: 1 },
      runtimeOptions: { model: "gpt-5" },
      cwd: "/repo",
      lastError: "earlier failure",
    });
    mockStoredMeta(current);
    const writes = captureMetaWrites(current);

    const manager = new AcpSessionManager();
    const result = await manager.closeSession({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      reason: "manual-close",
      allowBackendUnavailable: true,
      clearMeta: true,
    });

    expect(result).toMatchObject({ runtimeClosed: true, metaCleared: true });
    expectRecordFields(mockCallArg(runtimeState.close), { reason: "manual-close" });
    expect(mockCallArg(runtimeState.close)).not.toHaveProperty("discardPersistentState", true);
    // Ensure may persist reconciled identity first; the close is always the final write.
    const closed = writes.at(-1);
    expect(closed).toBeDefined();
    expect(closed).toMatchObject({
      backend: current.backend,
      agent: current.agent,
      runtimeSessionName: current.runtimeSessionName,
      identity: current.identity,
      mode: current.mode,
      runtimeOptions: current.runtimeOptions,
      cwd: current.cwd,
      state: "closed",
    });
    expect(closed?.closedAt).toEqual(expect.any(Number));
    expect(closed?.lastActivityAt).toBe(closed?.closedAt);
    expect(closed).not.toHaveProperty("lastError");
  });

  it("deletes the row when a metadata-clearing close also discards persistent state", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const current = readySessionMeta({
      identity: { state: "resolved", acpxSessionId: "acpx-1", source: "ensure", lastUpdatedAt: 1 },
    });
    mockStoredMeta(current);
    const writes = captureMetaWrites(current);

    const manager = new AcpSessionManager();
    const result = await manager.closeSession({
      cfg: baseCfg,
      sessionKey: SESSION_KEY,
      reason: "task-cleanup",
      discardPersistentState: true,
      clearMeta: true,
      allowBackendUnavailable: true,
      requireAcpSession: false,
    });

    expect(result).toMatchObject({ runtimeClosed: true, metaCleared: true });
    expectRecordFields(mockCallArg(runtimeState.close), { discardPersistentState: true });
    expect(writes.at(-1)).toBeNull();
    expect(writes.filter((write) => write?.state === "closed")).toEqual([]);
  });

  it("resolves a closed row as terminal instead of missing metadata", () => {
    mockStoredMeta(closedSessionMeta());
    const manager = new AcpSessionManager();

    const resolved = manager.resolveSession({ cfg: baseCfg, sessionKey: SESSION_KEY });

    expect(resolved.kind).toBe("stale");
    if (resolved.kind !== "stale") {
      return;
    }
    expect(resolved.closedMeta?.state).toBe("closed");
    expect(resolved.error.code).toBe("ACP_SESSION_INIT_FAILED");
    expect(resolved.error.detailCode).toBe("ACP_SESSION_CLOSED");
    expect(resolved.error.message).toContain(
      `ACP session ${SESSION_KEY} was closed at 2023-11-14T22:13:20.000Z`,
    );
    expect(resolved.error.message).toContain("/acp spawn");
    expect(resolved.error.message).not.toContain("metadata is missing");
    expectRecordFields(mockCallArg(hoisted.readAcpSessionEntryMock), { includeClosed: true });
  });

  it("rejects turns to a closed session without touching the row or the backend", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    mockStoredMeta(closedSessionMeta());
    const manager = new AcpSessionManager();

    await expect(
      manager.runTurn({
        provenance: "system",
        cfg: baseCfg,
        sessionKey: SESSION_KEY,
        text: "after close",
        mode: "prompt",
        requestId: "r-closed",
      }),
    ).rejects.toMatchObject({ code: "ACP_SESSION_INIT_FAILED", detailCode: "ACP_SESSION_CLOSED" });

    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(hoisted.upsertAcpSessionMetaMock).not.toHaveBeenCalled();
  });

  it("treats a second close of a closed session as terminal and prunes only on discard", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const closed = closedSessionMeta();
    mockStoredMeta(closed);
    const writes = captureMetaWrites(closed);
    const manager = new AcpSessionManager();

    await expect(
      manager.closeSession({
        cfg: baseCfg,
        sessionKey: SESSION_KEY,
        reason: "manual-close",
        allowBackendUnavailable: true,
        clearMeta: true,
      }),
    ).rejects.toMatchObject({ detailCode: "ACP_SESSION_CLOSED" });
    await expect(
      manager.closeSession({
        cfg: baseCfg,
        sessionKey: SESSION_KEY,
        reason: "config-binding-reconfigure",
        clearMeta: false,
        allowBackendUnavailable: true,
        requireAcpSession: false,
      }),
    ).resolves.toEqual({ runtimeClosed: false, metaCleared: false });
    expect(writes).toEqual([]);

    await expect(
      manager.closeSession({
        cfg: baseCfg,
        sessionKey: SESSION_KEY,
        reason: "session-delete",
        discardPersistentState: true,
        requireAcpSession: false,
        allowBackendUnavailable: true,
      }),
    ).resolves.toEqual({ runtimeClosed: false, metaCleared: true });
    expect(writes).toEqual([null]);
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.close).not.toHaveBeenCalled();
  });
});
