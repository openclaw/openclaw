import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type CliRunParams = Parameters<typeof import("../cli-runner.js").runCliAgent>[0];

const { runCliAgentMock, storedProfiles } = vi.hoisted(() => ({
  runCliAgentMock: vi.fn(async (_params: CliRunParams) => undefined),
  storedProfiles: {} as Record<string, unknown>,
}));

vi.mock("../cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));
// The real CLI account selector runs against this store, as on the reply path.
vi.mock("../auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-profiles/store-runtime.js")>()),
  loadAuthProfileStoreForRuntimeAsync: async () => ({ version: 1, profiles: storedProfiles }),
}));

const { compactNativeCliSession } = await import("./compact.js");

function compactParams(overrides: Record<string, unknown> = {}) {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () =>
      [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          config: { command: "claude" },
          bundleMcp: false,
          pluginId: "anthropic",
          ownsNativeCompaction: true,
          manualCompaction: {
            buildPrompt: (instructions?: string) =>
              instructions ? `/compact ${instructions}` : "/compact",
            input: "arg",
            validateOutput: () => ({ ok: true }),
          },
        },
      ] as never,
    resolvePluginSetupCliBackend: () => undefined,
  });
  const dir = tempDirs.make("openclaw-compact-native-cli-");
  return {
    sessionId: "openclaw-session",
    sessionKey: "agent:main:main",
    sessionFile: "agent:main:main",
    agentId: "main",
    workspaceDir: join(dir, "workspace"),
    agentDir: join(dir, "agent"),
    config: {},
    provider: "anthropic",
    model: "opus",
    trigger: "manual",
    cliSessionBinding: { sessionId: "native-session", authProfileId: "anthropic:subscription" },
    sessionEntry: { execHost: "node", execNode: "paired-node" },
    customInstructions: "keep decisions",
    ...overrides,
  } as never;
}

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  runCliAgentMock.mockClear();
  for (const profileId of Object.keys(storedProfiles)) {
    delete storedProfiles[profileId];
  }
});

it("resumes the bound backend session with the backend-owned command", async () => {
  const result = await compactNativeCliSession({
    runtime: "claude-cli",
    compactParams: compactParams(),
  });

  expect(result).toEqual({
    ok: true,
    compacted: true,
    reason: 'CLI backend "claude-cli" compacted its native session.',
  });
  expect(runCliAgentMock).toHaveBeenCalledOnce();
  const call = runCliAgentMock.mock.calls[0]?.[0];
  expect(call).toMatchObject({
    preparedRunAdmission: {
      operationalRunInstance: {
        runId: "openclaw-session:native-compact",
      },
    },
    prompt: "/compact keep decisions",
    provider: "claude-cli",
    modelProvider: "anthropic",
    cliSessionId: "native-session",
    cliSessionBinding: { sessionId: "native-session", authProfileId: "anthropic:subscription" },
    authProfileId: "anthropic:subscription",
    sessionEntry: { execHost: "node", execNode: "paired-node" },
    controlOperation: "compact",
    disableCliLiveSession: true,
    cleanupCliLiveSessionOnRunEnd: true,
    allowEmptyAssistantReplyAsSilent: true,
  });
  const preparedRunAdmission = call?.preparedRunAdmission;
  if (!preparedRunAdmission) {
    throw new Error("native compaction did not prepare run admission");
  }
  await expect(preparedRunAdmission.admit("embedded")).rejects.toThrow(
    "prepared execution context is already closed",
  );
});

describe("session pin conversion for the CLI child", () => {
  const apiKey = { type: "api_key", provider: "anthropic", key: "metered-key" }; // pragma: allowlist secret
  const cliAccount = {
    type: "oauth",
    provider: "claude-cli",
    access: "cli-access",
    refresh: "cli-refresh",
    expires: Date.now() + 3_600_000,
  };

  it.each([
    ["native-login binding with a competing CLI account", { sessionId: "native-session" }, true],
    ["no binding and no CLI account", undefined, false],
  ])("does not bill the auto-selected API key: %s", async (_name, binding, seedCliAccount) => {
    storedProfiles["anthropic:default"] = apiKey;
    if (seedCliAccount) {
      storedProfiles["claude-cli:work"] = cliAccount;
    }
    await compactNativeCliSession({
      runtime: "claude-cli",
      compactParams: compactParams({
        cliSessionBinding: binding,
        cliSessionId: "native-session",
        authProfileId: "anthropic:default",
        authProfileIdSource: "auto",
      }),
    });
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(runCliAgentMock.mock.calls[0]?.[0]?.authProfileId).toBeUndefined();
  });

  it("forwards an explicitly selected API key", async () => {
    storedProfiles["anthropic:default"] = apiKey;
    await compactNativeCliSession({
      runtime: "claude-cli",
      compactParams: compactParams({
        cliSessionBinding: { sessionId: "native-session" },
        authProfileId: "anthropic:default",
        authProfileIdSource: "user",
      }),
    });
    expect(runCliAgentMock.mock.calls[0]?.[0]?.authProfileId).toBe("anthropic:default");
  });

  it("refuses a missing explicit selection before the child runs", async () => {
    const result = await compactNativeCliSession({
      runtime: "claude-cli",
      compactParams: compactParams({
        cliSessionBinding: { sessionId: "native-session" },
        authProfileId: "anthropic:missing",
        authProfileIdSource: "user",
      }),
    });
    expect(result).toMatchObject({ ok: false, compacted: false });
    expect(result?.reason).toContain('No credentials found for profile "anthropic:missing"');
    expect(result?.reason).toContain("then run /compact again");
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });
});
