import { describe, expect, it } from "vitest";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installMutableAcpSessionMetaUpsert,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager startup identity reconcile", () => {
  installAcpSessionManagerTestLifecycle();

  it("reconciles only pending persistent identities with a stable resume target", async () => {
    const runtimeState = createRuntime();
    runtimeState.getStatus.mockResolvedValue({
      acpxRecordId: "record-fresh",
      backendSessionId: "backend-fresh",
      agentSessionId: "agent-fresh",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const identity = {
      state: "pending" as const,
      source: "ensure" as const,
      acpxSessionId: "backend-stale",
      lastUpdatedAt: 1,
    };
    const state: { currentMeta: SessionAcpMeta } = { currentMeta: readySessionMeta({ identity }) };
    const sessionKey = "agent:codex:acp:pending";
    const candidates = [
      { sessionKey, acp: state.currentMeta },
      {
        sessionKey: "agent:codex:acp:oneshot",
        acp: readySessionMeta({ mode: "oneshot", identity }),
      },
      {
        sessionKey: "agent:codex:acp:resolved",
        acp: readySessionMeta({
          identity: { ...identity, state: "resolved", agentSessionId: "agent-stable" },
        }),
      },
      {
        sessionKey: "agent:codex:acp:unstable",
        acp: readySessionMeta({
          identity: {
            state: "pending",
            source: "status",
            acpxRecordId: "record-only",
            lastUpdatedAt: 1,
          },
        }),
      },
    ];
    hoisted.listAcpSessionEntriesMock.mockResolvedValue(
      candidates.map(({ sessionKey: key, acp }) => ({
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey: key,
        storeSessionKey: key,
        entry: { sessionId: key, updatedAt: 1, acp },
        acp,
      })),
    );
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: state.currentMeta,
    }));
    installMutableAcpSessionMetaUpsert(state);

    expect(
      await new AcpSessionManager().reconcilePendingSessionIdentities({ cfg: baseCfg }),
    ).toEqual({ checked: 1, resolved: 1, failed: 0 });
    expect(runtimeState.ensureSession.mock.calls.map(([input]) => input.sessionKey)).toEqual([
      sessionKey,
    ]);
    expect(runtimeState.getStatus).toHaveBeenCalledOnce();
    expect(state.currentMeta.identity).toMatchObject({
      state: "resolved",
      acpxRecordId: "record-fresh",
      acpxSessionId: "backend-fresh",
      agentSessionId: "agent-fresh",
    });
  });
});
