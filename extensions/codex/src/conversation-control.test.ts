import path from "node:path";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "openclaw/plugin-sdk/model-session-runtime";
import { upsertAuthProfileAsync } from "openclaw/plugin-sdk/provider-auth";
import {
  deleteSessionEntry,
  getSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  observeHostDataSql,
  useSessionStoreTempDirs,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
  setCodexConversationFastMode as setFast,
  setCodexConversationModel as setModel,
  setCodexConversationPermissions as permissions,
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

let tempDir: string;

async function permissionSession(
  sessionId: string,
  entry: Partial<SessionEntry> = {},
  sessionKey = `agent:main:${sessionId}`,
) {
  const session = { agentId: "main", sessionId, sessionKey };
  const storePath = resolveStorePath(undefined, { agentId: session.agentId });
  await upsertSessionEntry({
    ...session,
    storePath,
    entry: { sessionId, updatedAt: Date.now(), ...entry },
  });
  return {
    session,
    storePath,
    set: (mode?: Parameters<typeof permissions>[0]["mode"]) =>
      permissions({ session, mode, config: {}, assertCurrent() {} }),
    read: () => getSessionEntry({ ...session, storePath, readConsistency: "latest" }),
  };
}

async function expectStaleTurn(target: ReturnType<typeof controlTarget>, message: string) {
  const expected = { message: "The active Codex run no longer matches this session binding." };
  await expect(stopCodexConversationTurn(target)).resolves.toEqual({ stopped: false, ...expected });
  await expect(steerCodexConversationTurn({ ...target, message })).resolves.toEqual({
    steered: false,
    ...expected,
  });
}

function trackTurn(
  target: ReturnType<typeof controlTarget>,
  threadId: string,
  harness: ReturnType<typeof createClientHarness>,
) {
  const stop = trackCodexConversationActiveTurn({
    identity: target.identity,
    client: harness.client,
    requestTimeoutMs: 60_000,
    threadId,
    turnId: "turn-1",
  });
  onTestFinished(() => {
    stop();
    harness.client.close();
  });
}

async function boundTarget(
  binding: Omit<Parameters<typeof writeCodexAppServerBinding>[1], "cwd"> & { cwd?: string },
) {
  const sessionFile = path.join(tempDir, "session.jsonl");
  await writeCodexAppServerBinding(sessionFile, { cwd: tempDir, ...binding });
  return { ...controlTarget(sessionFile), sessionFile };
}

function replyingHarness() {
  return createClientHarness({
    onWrite: (line, send) => {
      const request = JSON.parse(line) as { id: number };
      send({ id: request.id, result: {} });
    },
  });
}

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-server/shared-client.js")>()),
  ...sharedClientMocks,
  getLeasedSharedCodexAppServerClient: sharedClientMocks.getSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient:
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient,
  releaseCodexAppServerClientLease: vi.fn((lease: { client?: unknown }) => {
    lease.client = undefined;
  }),
  withCodexAppServerClientRequestScope: async (params: {
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

  it("reads private permission policy from memory and rejects a deleted session", async () => {
    const test = await permissionSession(
      "private-policy",
      { updatedAt: 1, incognito: true, permissionMode: "full" },
      "agent:main:dashboard:incognito-policy",
    );
    const { session, storePath } = test;
    try {
      const sql = observeHostDataSql();
      try {
        await expect(permissions({ session, storePath, assertCurrent() {} })).resolves.toBe(
          "Codex permissions: full access.",
        );
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    } finally {
      await deleteSessionEntry({ ...session, storePath });
    }
    await expect(permissions({ session, storePath, assertCurrent() {} })).rejects.toThrow(
      "Codex session changed while reading the permission mode",
    );
  });

  it("persists fast mode on the binding and permissions on the session", async () => {
    const test = await permissionSession("session-1", {
      permissionMode: "full",
      sessionRoot: tempDir,
    });
    const target = await boundTarget({
      threadId: "thread-1",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    await expect(setFast({ ...target, enabled: true })).resolves.toBe("Codex fast mode enabled.");
    await expect(test.set("default")).resolves.toBe("Codex permissions set to guarded.");

    expect(await readCodexAppServerBinding(target.sessionFile)).toMatchObject({
      threadId: "thread-1",
      serviceTier: "priority",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(test.read()).toMatchObject({ permissionMode: "guarded", sessionRoot: tempDir });

    await expect(test.set("yolo")).resolves.toBe("Codex permissions set to full access.");
    expect(test.read()?.permissionMode).toBe("full");
  });

  it("rejects prepared binding mutations after the selected binding changes", async () => {
    const prepared = {
      threadId: "thread-prepared",
      cwd: tempDir,
    };
    const target = await boundTarget(prepared);
    await testCodexAppServerBindingStore.mutate(target.identity, {
      kind: "set",
      binding: { ...prepared, threadId: "thread-replacement" },
    });

    await expect(setFast({ ...target, enabled: true })).rejects.toThrow();
    expect(testCodexAppServerBindingStore.read(target.identity)).not.toHaveProperty("serviceTier");
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
    const test = await permissionSession("session-without-root");

    await expect(test.set("default")).resolves.toBe("Codex permissions set to guarded.");
    expect(test.read()).toMatchObject({ permissionMode: "guarded" });
  });

  it("routes stop and steer through the client that owns the active turn", async () => {
    const target = await boundTarget({
      threadId: "thread-supervised",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-supervised",
      appServerRuntimeFingerprint: buildCodexSupervisionTestConnectionFingerprint(),
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });
    const harness = replyingHarness();
    trackTurn(target, "thread-supervised", harness);

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
  });

  it("refuses to stop or steer when the active turn no longer matches the private binding", async () => {
    const target = await boundTarget({ threadId: "replacement-thread" });
    const harness = createClientHarness();
    trackTurn(target, "stale-active-thread", harness);

    await expectStaleTurn(target, "do not send");
    await testCodexAppServerBindingStore.mutate(target.identity, { kind: "clear" });
    const clearedTarget = controlTarget(target.sessionFile);
    await expectStaleTurn(clearedTarget, "still do not send");

    expect(harness.writes).toHaveLength(0);
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("rejects steer before a retained-client write after host rollover", async () => {
    const target = await boundTarget({ threadId: "thread-steer-retained" });
    const harness = replyingHarness();
    trackTurn(target, "thread-steer-retained", harness);

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
  });

  it("rejects direct model changes for private supervised bindings", async () => {
    const target = await boundTarget({
      threadId: "thread-supervised",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-supervised",
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });

    await expect(setModel({ ...target, model: "gpt-5.4" })).rejects.toThrow(
      MODEL_SELECTION_LOCKED_MESSAGE,
    );
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it.each([
    [
      "local-model",
      "local-model-2 <@U123> [trusted](evil)",
      "local-model-2 &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08evil\uff09",
    ],
    ["openai/gpt-oss-20b", "openai/gpt-oss-20b", "openai/gpt-oss-20b"],
  ])(
    "keeps the bound local provider when selecting %s -> %s",
    async (previousModel, model, display) => {
      const target = await boundTarget({
        threadId: "thread-1",
        model: previousModel,
        modelProvider: "lmstudio",
      });
      await expect(setModel({ ...target, model })).resolves.toBe(`Codex model set to ${display}.`);

      await expect(readCodexAppServerBinding(target.sessionFile)).resolves.toMatchObject({
        model,
        modelProvider: "lmstudio",
      });
      expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "clears incompatible direct-session auth when the selected provider changes",
      recordedProvider: undefined,
      expectedProfile: undefined,
    },
    {
      name: "preserves compatible recorded direct-session auth over the profile ID prefix",
      recordedProvider: "openai",
      expectedProfile: "lmstudio:work",
    },
  ])("$name", async ({ recordedProvider, expectedProfile }) => {
    const sessionKey = "agent:main:model-provider-switch";
    const agentDir = path.join(tempDir, "agent");
    if (recordedProvider) {
      await upsertAuthProfileAsync({
        agentDir,
        profileId: "lmstudio:work",
        credential: { type: "api_key", provider: recordedProvider, key: "test-key" },
      });
    }
    const { session, storePath } = await permissionSession(
      "session-provider-switch",
      {
        authProfileOverride: "lmstudio:work",
        authProfileOverrideSource: "user",
      },
      sessionKey,
    );
    const identity = { kind: "session" as const, ...session };
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
      setModel({
        identity,
        bindingStore: testCodexAppServerBindingStore,
        binding: testCodexAppServerBindingStore.read(identity),
        model: "openai/gpt-5.5",
        agentDir,
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
    expect(getSessionEntry({ storePath, sessionKey })?.authProfileOverride).toBe(expectedProfile);
  });
});
