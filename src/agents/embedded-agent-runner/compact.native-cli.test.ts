import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { decideTurnGrant } from "../../gateway/operator-admission.js";
import { createOperatorAuthorityInactiveError } from "../../infra/operator-authority-error.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { createParticipationTestAuthority } from "../participation-ceiling.test-support.js";
import { attachCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type CliRunParams = Parameters<typeof import("../cli-runner.js").runCliAgent>[0];
type CliRunResult = Awaited<ReturnType<typeof import("../cli-runner.js").runCliAgent>>;

const { runCliAgentMock, storedProfiles } = vi.hoisted(() => ({
  // The runner reports the sizes from the backend's own compaction record.
  runCliAgentMock: vi.fn(async (_params: CliRunParams): Promise<CliRunResult> => ({
    meta: {
      durationMs: 1,
      agentMeta: {
        sessionId: "",
        provider: "anthropic",
        model: "opus",
        compactionCount: 1,
        compactionTokensBefore: 33_905,
        compactionTokensAfter: 6_173,
      },
    },
  })),
  storedProfiles: {} as Record<string, unknown>,
}));

vi.mock("../cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));
// The real CLI account selector runs against this store, as on the reply path.
vi.mock("../auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-profiles/store-runtime.js")>()),
  loadAuthProfileStoreForRuntimeAsync: async () => ({ version: 1, profiles: storedProfiles }),
}));

const { compactEmbeddedAgentSessionDirect, compactNativeCliSession } = await import("./compact.js");

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
    skillsSnapshot: { prompt: "stored skills prompt", skills: [] }, // stored copy: no catalogs
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
    result: { tokensBefore: 33_905, tokensAfter: 6_173 },
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
    skillsSnapshot: { resolvedSkills: expect.any(Array) },
    controlOperation: "compact",
    disableCliLiveSession: true,
    cleanupCliLiveSessionOnRunEnd: true,
    allowEmptyAssistantReplyAsSilent: true,
  });
  await expect(call?.preparedRunAdmission?.admit("embedded")).rejects.toThrow(
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

describe("session maintenance identity", () => {
  function endedRunAuthority(ceiling?: Parameters<typeof createParticipationTestAuthority>[0]) {
    // The triggering turn held the only reference and released it when it ended.
    const retain = () => {
      throw createOperatorAuthorityInactiveError("closure-released", "before-sources", 0);
    };
    return ceiling
      ? createParticipationTestAuthority(ceiling, [], retain)
      : createAdmittedRunOperatorAuthority({
          canonicalIdentity: null,
          profileId: "owner",
          scopes: ["operator.admin"],
          grant: decideTurnGrant(["operator.admin"]),
          retain,
        });
  }

  async function compactAfterTurn(operatorAuthority: AdmittedRunOperatorAuthority) {
    const params = compactParams() as Record<string, unknown>;
    const contextEngineRuntimeContext = {};
    attachCompactionAccountingRecorder(contextEngineRuntimeContext, {
      operatorAuthority,
      preparedSession: {
        sessionTarget: {
          agentId: "main",
          sessionId: "openclaw-session",
          sessionKey: "agent:main:main",
          storePath: join(String(params.agentDir), "sessions.sqlite"),
        },
        entry: {
          sessionId: "openclaw-session",
          updatedAt: 1,
          agentHarnessId: "claude-cli",
          modelSelectionLocked: true,
        } as never,
      },
    });
    return await compactEmbeddedAgentSessionDirect({
      ...params,
      contextEngineRuntimeContext,
    } as never);
  }

  it("compacts after the triggering turn's authority was released", async () => {
    const result = await compactAfterTurn(endedRunAuthority());

    expect(result).toMatchObject({ ok: true, compacted: true });
    const admission = runCliAgentMock.mock.calls[0]?.[0]?.preparedRunAdmission;
    expect(admission?.readOperatorAuthority?.()).toBeUndefined();
  });

  it("compacts when an invited participant's turn triggered it", async () => {
    const result = await compactAfterTurn(
      endedRunAuthority({ kind: "send", profileId: "guest", sessionKey: "agent:main:main" }),
    );

    expect(result).toMatchObject({ ok: true, compacted: true });
    // The participant lends nothing: the control operation runs as session maintenance.
    const admission = runCliAgentMock.mock.calls[0]?.[0]?.preparedRunAdmission;
    expect(admission?.readOperatorAuthority?.()).toBeUndefined();
  });
});
