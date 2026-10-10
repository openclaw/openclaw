import path from "node:path";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "openclaw/plugin-sdk/model-session-runtime";
import {
  getSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { captureOpenClawAgentDatabaseExecution } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  observeHostDataSql,
  openIncognitoTestActor,
  useSessionStoreTempDirs,
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexSupervisionTestConnectionFingerprint,
  readCodexAppServerBinding,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.test-helpers.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  formatPermissionsMode,
  parseCodexPermissionsModeArg,
  steerCodexConversationTurn,
  stopCodexConversationTurn,
  trackCodexConversationActiveTurn,
  setCodexConversationFastMode as setCodexConversationFastModeImpl,
  setCodexConversationModel as setCodexConversationModelImpl,
  setCodexConversationPermissions as setCodexConversationPermissionsImpl,
} from "./conversation-control.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-control-");

function controlTarget(sessionFile: string) {
  const identity = { kind: "session" as const, agentId: "main", sessionId: sessionFile };
  const binding = testCodexAppServerBindingStore.read(identity);
  return {
    identity,
    bindingStore: testCodexAppServerBindingStore,
    binding,
    assertCurrent: () => {
      expect(testCodexAppServerBindingStore.read(identity)).toEqual(binding);
    },
  };
}

function setCodexConversationFastMode(
  params: Omit<
    Parameters<typeof setCodexConversationFastModeImpl>[0],
    "identity" | "bindingStore" | "binding" | "assertCurrent"
  > & {
    sessionFile: string;
  },
) {
  const { sessionFile, ...rest } = params;
  return setCodexConversationFastModeImpl({ ...rest, ...controlTarget(sessionFile) });
}

function setCodexConversationModel(
  params: Omit<
    Parameters<typeof setCodexConversationModelImpl>[0],
    "identity" | "bindingStore" | "binding" | "assertCurrent"
  > & {
    sessionFile: string;
  },
) {
  const { sessionFile, ...rest } = params;
  return setCodexConversationModelImpl({ ...rest, ...controlTarget(sessionFile) });
}

let tempDir: string;

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", () => ({
  ...sharedClientMocks,
  getLeasedSharedCodexAppServerClient: sharedClientMocks.getSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient:
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient,
  releaseCodexAppServerClientLease: vi.fn((lease: { client?: unknown }) => {
    lease.client = undefined;
  }),
  withLeasedCodexAppServerClientStartSelectionRetry: async (params: {
    lease: { client?: unknown };
    options?: { timeoutMs?: number };
    run: (
      client: unknown,
      requestOptions: () => { timeoutMs: number; assertCurrent: () => void },
    ) => Promise<unknown>;
  }) =>
    await params.run(params.lease.client, () => ({
      timeoutMs: params.options?.timeoutMs ?? 60_000,
      assertCurrent: () => undefined,
    })),
}));

describe("codex conversation controls", () => {
  beforeEach(() => {
    resetCodexTestBindingStore();
    tempDir = sessionDirs.make();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["native", "bound"] as const)(
    "reads %s private permission policy through its selected owner",
    async (mode) => {
      const env = { OPENCLAW_STATE_DIR: tempDir };
      const session = {
        agentId: "main",
        sessionId: "private-policy",
        sessionKey: "agent:main:dashboard:incognito-policy",
      };
      const storePath = resolveStorePath(undefined, { agentId: session.agentId });
      const authority = { assertCurrent() {} };
      const actor = mode === "bound" ? await openIncognitoTestActor(env, authority) : undefined;
      const entry: SessionEntry = {
        sessionId: session.sessionId,
        updatedAt: 1,
        incognito: true,
        permissionMode: "full",
      };
      try {
        if (actor) {
          await actor.sessions.create(authority, { sessionKey: session.sessionKey, entry });
        } else {
          await upsertSessionEntry({ ...session, storePath, entry });
        }
        const read = async () => {
          const sql = observeHostDataSql();
          try {
            await expect(
              setCodexConversationPermissionsImpl({ session, storePath, assertCurrent() {} }),
            ).resolves.toBe("Codex permissions: full access.");
            if (actor) {
              expect(sql.queries).toEqual([]);
            }
          } finally {
            sql.restore();
          }
        };
        if (actor) {
          await withIncognitoSessionActor(actor, read);
        } else {
          await read();
          expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
        }
      } finally {
        await actor?.close();
      }
      if (actor) {
        await expect(
          withIncognitoSessionBinding({ actor }, () =>
            setCodexConversationPermissionsImpl({ session, storePath, assertCurrent() {} }),
          ),
        ).rejects.toMatchObject({ code: "INCOGNITO_SESSION_ENDED" });
      }
    },
  );

  it("persists fast mode on the binding and permissions on the session", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const session = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    };
    const storePath = resolveStorePath(undefined, { agentId: session.agentId });
    await upsertSessionEntry({
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      storePath,
      entry: {
        sessionId: session.sessionId,
        updatedAt: Date.now(),
        permissionMode: "full",
        sessionRoot: tempDir,
      },
    });
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    await expect(setCodexConversationFastMode({ sessionFile, enabled: true })).resolves.toBe(
      "Codex fast mode enabled.",
    );
    await expect(
      setCodexConversationPermissionsImpl({
        session,
        mode: "default",
        config: {},
        assertCurrent: () => {},
      }),
    ).resolves.toBe("Codex permissions set to guarded.");

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-1");
    expect(binding?.serviceTier).toBe("priority");
    expect(binding?.approvalPolicy).toBe("never");
    expect(binding?.sandbox).toBe("danger-full-access");
    expect(
      getSessionEntry({
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        storePath,
        readConsistency: "latest",
      }),
    ).toMatchObject({ permissionMode: "guarded", sessionRoot: tempDir });

    await expect(
      setCodexConversationPermissionsImpl({
        session,
        mode: "yolo",
        config: {},
        assertCurrent: () => {},
      }),
    ).resolves.toBe("Codex permissions set to full access.");
    expect(
      getSessionEntry({
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        storePath,
        readConsistency: "latest",
      })?.permissionMode,
    ).toBe("full");
  });

  it("rejects prepared binding mutations after the selected binding changes", async () => {
    const sessionFile = path.join(tempDir, "prepared-binding.jsonl");
    const identity = controlTarget(sessionFile).identity;
    const prepared = {
      threadId: "thread-prepared",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
    };
    await writeCodexAppServerBinding(sessionFile, prepared);
    const assertCurrent = () => {
      expect(testCodexAppServerBindingStore.read(identity)).toEqual(prepared);
    };
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "set",
      binding: { ...prepared, threadId: "thread-replacement" },
    });

    await expect(
      setCodexConversationFastModeImpl({
        identity,
        bindingStore: testCodexAppServerBindingStore,
        binding: prepared,
        enabled: true,
        assertCurrent,
      }),
    ).rejects.toThrow();
    expect(testCodexAppServerBindingStore.read(identity)).not.toHaveProperty("serviceTier");
  });

  it.each([
    { mode: "workspace" as const, display: "workspace" },
    { mode: "full" as const, display: "full access" },
  ])("reports the explicit $mode conversation permission mode", ({ mode, display }) => {
    expect(formatPermissionsMode(mode)).toBe(display);
  });

  it("recognizes a guarded conversation permission alias", () => {
    expect(parseCodexPermissionsModeArg("guardian")).toBe("default");
  });

  it("persists a permission mode on a rootless session", async () => {
    const session = {
      agentId: "main",
      sessionId: "session-without-root",
      sessionKey: "agent:main:session-without-root",
    };
    const storePath = resolveStorePath(undefined, { agentId: session.agentId });
    await upsertSessionEntry({
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      storePath,
      entry: { sessionId: session.sessionId, updatedAt: Date.now() },
    });

    await expect(
      setCodexConversationPermissionsImpl({
        session,
        mode: "default",
        config: {},
        assertCurrent: () => {},
      }),
    ).resolves.toBe("Codex permissions set to guarded.");
    expect(
      getSessionEntry({ agentId: session.agentId, sessionKey: session.sessionKey, storePath }),
    ).toMatchObject({ permissionMode: "guarded" });
  });

  it("routes stop and steer through the client that owns the active turn", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-supervised",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-supervised",
      appServerRuntimeFingerprint: buildCodexSupervisionTestConnectionFingerprint(),
      cwd: tempDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });
    const target = controlTarget(sessionFile);
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line) as { id: number };
        send({ id: request.id, result: {} });
      },
    });
    const stopTracking = trackCodexConversationActiveTurn({
      identity: target.identity,
      client: harness.client,
      requestTimeoutMs: 60_000,
      threadId: "thread-supervised",
      turnId: "turn-1",
    });

    try {
      await expect(stopCodexConversationTurn(target)).resolves.toMatchObject({ stopped: true });
      await expect(
        steerCodexConversationTurn({ ...target, message: "focus tests" }),
      ).resolves.toMatchObject({ steered: true });
      expect(harness.writes.map((line) => JSON.parse(line))).toMatchObject([
        {
          method: "turn/interrupt",
          params: { threadId: "thread-supervised", turnId: "turn-1" },
        },
        {
          method: "turn/steer",
          params: {
            threadId: "thread-supervised",
            expectedTurnId: "turn-1",
            input: [{ type: "text", text: "focus tests", text_elements: [] }],
          },
        },
      ]);
      expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
    } finally {
      stopTracking();
      harness.client.close();
    }
  });

  it("refuses to stop or steer when the active turn no longer matches the private binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "replacement-thread",
      cwd: tempDir,
    });
    const target = controlTarget(sessionFile);
    const harness = createClientHarness();
    const stopTracking = trackCodexConversationActiveTurn({
      identity: target.identity,
      client: harness.client,
      requestTimeoutMs: 60_000,
      threadId: "stale-active-thread",
      turnId: "turn-1",
    });

    try {
      await expect(stopCodexConversationTurn(target)).resolves.toEqual({
        stopped: false,
        message: "The active Codex run no longer matches this session binding.",
      });
      await expect(
        steerCodexConversationTurn({ ...target, message: "do not send" }),
      ).resolves.toEqual({
        steered: false,
        message: "The active Codex run no longer matches this session binding.",
      });
      await testCodexAppServerBindingStore.mutate(target.identity, { kind: "clear" });
      const clearedTarget = controlTarget(sessionFile);
      await expect(stopCodexConversationTurn(clearedTarget)).resolves.toEqual({
        stopped: false,
        message: "The active Codex run no longer matches this session binding.",
      });
      await expect(
        steerCodexConversationTurn({ ...clearedTarget, message: "still do not send" }),
      ).resolves.toEqual({
        steered: false,
        message: "The active Codex run no longer matches this session binding.",
      });
    } finally {
      stopTracking();
      harness.client.close();
    }

    expect(harness.writes).toHaveLength(0);
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("rejects steer before a retained-client write after host rollover", async () => {
    const sessionFile = path.join(tempDir, "steer-retained.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-steer-retained",
      cwd: tempDir,
    });
    const target = controlTarget(sessionFile);
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line) as { id: number };
        send({ id: request.id, result: {} });
      },
    });
    const stopTracking = trackCodexConversationActiveTurn({
      identity: target.identity,
      client: harness.client,
      requestTimeoutMs: 60_000,
      threadId: "thread-steer-retained",
      turnId: "turn-1",
    });

    try {
      await expect(
        steerCodexConversationTurn({
          message: "focus tests",
          ...target,
          assertCurrent: () => {
            throw new Error("host session rolled over");
          },
        }),
      ).rejects.toThrow("host session rolled over");
      expect(harness.writes).toHaveLength(0);
    } finally {
      stopTracking();
      harness.client.close();
    }
  });

  it("rejects direct model changes for private supervised bindings", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-supervised",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-supervised",
      cwd: tempDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });

    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "gpt-5.4",
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("keeps the bound local provider when switching to another unqualified model", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const model = "local-model-2 <@U123> [trusted](evil)";
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    await expect(
      setCodexConversationModel({
        sessionFile,
        model,
      }),
    ).resolves.toBe(
      "Codex model set to local-model-2 &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08evil\uff09.",
    );

    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      model,
      modelProvider: "lmstudio",
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("keeps the bound local provider when reselecting a model id with a slash", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "openai/gpt-oss-20b",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "openai/gpt-oss-20b",
      }),
    ).resolves.toBe("Codex model set to openai/gpt-oss-20b.");

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.model).toBe("openai/gpt-oss-20b");
    expect(binding?.modelProvider).toBe("lmstudio");
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("clears incompatible direct-session auth when the selected provider changes", async () => {
    const sessionKey = "agent:main:model-provider-switch";
    const sessionId = "session-provider-switch";
    const identity = { kind: "session" as const, agentId: "main", sessionId, sessionKey };
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    await upsertSessionEntry({
      agentId: "main",
      storePath,
      sessionKey,
      entry: {
        sessionId,
        updatedAt: Date.now(),
        authProfileOverride: "lmstudio:work",
        authProfileOverrideSource: "user",
      },
    });
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-provider-switch",
        cwd: tempDir,
        model: "local-model",
        modelProvider: "lmstudio",
      },
    });

    await expect(
      setCodexConversationModelImpl({
        identity,
        bindingStore: testCodexAppServerBindingStore,
        binding: testCodexAppServerBindingStore.read(identity),
        model: "openai/gpt-5.5",
        storePath,
        assertCurrent: () => {},
      }),
    ).resolves.toBe("Codex model set to gpt-5.5.");

    expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
      threadId: "thread-provider-switch",
      model: "local-model",
      modelProvider: "lmstudio",
    });
    expect(getSessionEntry({ storePath, sessionKey })).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      liveModelSwitchPending: true,
    });
    expect(getSessionEntry({ storePath, sessionKey })?.authProfileOverride).toBeUndefined();
  });
});
