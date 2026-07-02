/** Tests ACP manager session initialization limits and persisted runtime options. */
import { describe, expect, it } from "vitest";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  expectRecordFields,
  expectRejectedRecord,
  extractRuntimeOptionsFromUpserts,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  mockCallArg,
  readySessionMeta,
  type OpenClawConfig,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager initializeSession", () => {
  installAcpSessionManagerTestLifecycle();

  it("enforces acp.maxConcurrentSessions during initializeSession", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-a",
      storeSessionKey: "agent:codex:acp:session-a",
      acp: readySessionMeta(),
    });
    const limitedCfg = {
      acp: {
        ...baseCfg.acp,
        maxConcurrentSessions: 1,
      },
    } as OpenClawConfig;

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: limitedCfg,
      sessionKey: "agent:codex:acp:session-a",
      agent: "codex",
      mode: "persistent",
    });

    await expectRejectedRecord(
      manager.initializeSession({
        cfg: limitedCfg,
        sessionKey: "agent:codex:acp:session-b",
        agent: "codex",
        mode: "persistent",
      }),
      {
        code: "ACP_SESSION_INIT_FAILED",
        message: "ACP max concurrent sessions reached (1/1).",
      },
    );
    expect(runtimeState.ensureSession).toHaveBeenCalledTimes(1);
  });

  it("persists runtime options provided during initializeSession", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-a",
      storeSessionKey: "agent:codex:acp:session-a",
      acp: readySessionMeta({
        runtimeOptions: {
          model: "openai/gpt-5.4",
          thinking: "high",
        },
      }),
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-a",
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        model: "openai/gpt-5.4",
        thinking: "high",
      },
    });

    expect(extractRuntimeOptionsFromUpserts()).toEqual([
      {
        model: "openai/gpt-5.4",
        thinking: "high",
      },
    ]);
    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey: "agent:codex:acp:session-a",
      model: "openai/gpt-5.4",
      thinking: "high",
    });
  });

  it("derives explicit-only memory policy for ACP runtime keys when initializeSession omits it", async () => {
    const runtimeState = createRuntime();
    const sessionKey = "agent:codex:acp:session-derived-policy";
    let persistedMeta: SessionAcpMeta | undefined;
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        mutate: (
          current: SessionAcpMeta | undefined,
          entry: { acp?: SessionAcpMeta } | undefined,
        ) => SessionAcpMeta | null | undefined;
      };
      persistedMeta = params.mutate(undefined, undefined) ?? undefined;
      return {
        sessionKey,
        storeSessionKey: sessionKey,
        acp: persistedMeta,
      };
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey,
      agent: "codex",
      mode: "persistent",
    });

    expect(mockCallArg(runtimeState.ensureSession).memoryPolicy).toEqual({
      chatType: "group",
      longTermMemoryDefaultPolicy: "explicit-only",
    });
    expect(persistedMeta?.identity?.memoryPolicy).toEqual({
      chatType: "group",
      longTermMemoryDefaultPolicy: "explicit-only",
    });
  });

  it("preserves runtimeOptions cwd when initializeSession cwd is omitted", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockResolvedValue({
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      storeSessionKey: "agent:codex:acp:session-cwd-runtime-options",
      acp: readySessionMeta({
        runtimeOptions: {
          cwd: "/workspace/from-runtime-options",
        },
        cwd: "/workspace/from-runtime-options",
      }),
    });

    const manager = new AcpSessionManager();
    await manager.initializeSession({
      cfg: baseCfg,
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      agent: "codex",
      mode: "persistent",
      runtimeOptions: {
        cwd: "/workspace/from-runtime-options",
      },
    });

    expectRecordFields(mockCallArg(runtimeState.ensureSession), {
      sessionKey: "agent:codex:acp:session-cwd-runtime-options",
      cwd: "/workspace/from-runtime-options",
    });
    expect(extractRuntimeOptionsFromUpserts()).toEqual([
      {
        cwd: "/workspace/from-runtime-options",
      },
    ]);
  });

  it("rolls back ensured runtime sessions when metadata persistence fails", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    hoisted.upsertAcpSessionMetaMock.mockRejectedValueOnce(new Error("disk full"));

    const manager = new AcpSessionManager();
    await expect(
      manager.initializeSession({
        cfg: baseCfg,
        sessionKey: "agent:codex:acp:session-1",
        agent: "codex",
        mode: "persistent",
      }),
    ).rejects.toThrow("disk full");
    const closeInput = mockCallArg(runtimeState.close);
    expectRecordFields(closeInput, {
      reason: "init-meta-failed",
    });
    expectRecordFields(closeInput.handle, {
      sessionKey: "agent:codex:acp:session-1",
    });
  });
});
