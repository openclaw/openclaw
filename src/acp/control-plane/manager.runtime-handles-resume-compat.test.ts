/** Protects stored persistent resume identities while opting one-shot sessions into ACP IDs. */
import { resolveRuntimeResumeSessionId } from "@openclaw/acp-core/runtime/session-identity";
import { describe, expect, it } from "vitest";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installMutableAcpSessionMetaUpsert,
  mockCallArg,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

const storedIdentity = {
  state: "resolved" as const,
  source: "status" as const,
  acpxSessionId: "backend-session",
  agentSessionId: "agent-session",
  lastUpdatedAt: 100,
};

const identityCases = [
  {
    name: "legacy metadata with distinct IDs and no flags",
    identity: storedIdentity,
    expected: "agent-session",
  },
  {
    name: "metadata with confirmed resume flags",
    identity: { ...storedIdentity, sessionResumeSupported: true, sessionResumeReady: true },
    expected: "agent-session",
  },
  {
    name: "agent-only metadata",
    identity: { ...storedIdentity, acpxSessionId: undefined },
    expected: "agent-session",
  },
  {
    name: "backend-only metadata",
    identity: { ...storedIdentity, agentSessionId: undefined },
    expected: "backend-session",
  },
];

describe("runtime resume selector compatibility", () => {
  it.each(identityCases)(
    "keeps the public default agent-first for $name",
    ({ identity, expected }) => {
      expect(resolveRuntimeResumeSessionId(identity)).toBe(expected);
    },
  );

  it("does not invent a resume target for absent identity", () => {
    expect(resolveRuntimeResumeSessionId(undefined)).toBeUndefined();
  });
});

describe("AcpSessionManager resume compatibility", () => {
  installAcpSessionManagerTestLifecycle();

  async function runStoredSession(params: {
    backend: string;
    mode: SessionAcpMeta["mode"];
    identity: NonNullable<SessionAcpMeta["identity"]>;
  }) {
    const runtimeState = createRuntime();
    const sessionKey = "agent:gemini:acp:resume-compat";
    runtimeState.ensureSession.mockImplementation(async (input) => ({
      sessionKey: input.sessionKey,
      backend: params.backend,
      runtimeSessionName: "resumed-runtime",
      backendSessionId: params.identity.acpxSessionId,
      agentSessionId: params.identity.agentSessionId,
      sessionResumeSupported: params.identity.sessionResumeSupported,
    }));
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: params.backend,
      runtime: runtimeState.runtime,
    });
    const state = {
      currentMeta: readySessionMeta({
        backend: params.backend,
        agent: "gemini",
        mode: params.mode,
        identity: params.identity,
      }),
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(() => ({
      sessionKey,
      storeSessionKey: sessionKey,
      acp: state.currentMeta,
    }));
    installMutableAcpSessionMetaUpsert(state);

    const manager = new AcpSessionManager();
    await manager.runTurn({
      provenance: "system",
      cfg: { ...baseCfg, acp: { ...baseCfg.acp, backend: params.backend } },
      sessionKey,
      text: "continue the stored conversation",
      mode: "prompt",
      requestId: "resume-compat-turn",
    });

    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtimeState.prepareFreshSession).not.toHaveBeenCalled();
    expect(runtimeState.runTurn).toHaveBeenCalledTimes(1);
    return mockCallArg(runtimeState.ensureSession);
  }

  describe.each(["acpx", "legacy-backend"])("persistent %s backend", (backend) => {
    it.each(identityCases)(
      "resumes $name without a fresh fallback",
      async ({ identity, expected }) => {
        const input = await runStoredSession({ backend, mode: "persistent", identity });

        expect(input).toMatchObject({ mode: "persistent", resumeSessionId: expected });
      },
    );
  });

  it.each([
    { name: "distinct IDs", identity: storedIdentity, expected: "backend-session" },
    {
      name: "agent-only identity",
      identity: { ...storedIdentity, acpxSessionId: undefined },
      expected: "agent-session",
    },
    {
      name: "backend-only identity",
      identity: { ...storedIdentity, agentSessionId: undefined },
      expected: "backend-session",
    },
  ])(
    "uses the ACP ID with legacy fallback for eligible one-shot $name",
    async ({ identity, expected }) => {
      const input = await runStoredSession({
        backend: "acpx",
        mode: "oneshot",
        identity: { ...identity, sessionResumeSupported: true, sessionResumeReady: true },
      });

      expect(input).toMatchObject({ mode: "oneshot", resumeSessionId: expected });
    },
  );
});
