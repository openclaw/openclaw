import { join } from "node:path";
import { afterAll, expect, it, onTestFinished, vi } from "vitest";
import { delegateCompactionToRuntime } from "../../context-engine/delegate.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import {
  clearRuntimeAuthProfileStoreSnapshotCore,
  setRuntimeAuthProfileStoreSnapshot,
} from "../auth-profiles/runtime-snapshots.js";
import { installSessionPlacementAdmissionProvider } from "../session-placement-admission.js";
import {
  contextEngineCompactMock,
  getApiKeyForModelMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveContextEngineMock,
  resolveModelMock,
  sessionCompactImpl,
} from "./compact.hooks.harness.js";

const { compactEmbeddedAgentSession, compactEmbeddedAgentSessionDirect } =
  await loadCompactHooksHarness();
const [
  { upsertSessionEntryCore },
  { ensureAuthProfileStoreWithoutExternalProfiles },
  { AsyncWorkScope },
  { prepareProviderRuntimeAuth },
] = await Promise.all([
  import("../../config/sessions/session-accessor.js"),
  import("../model-auth.js"),
  import("../../shared/async-work-scope.js"),
  import("../../plugins/provider-runtime.js"),
]);
const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-compaction-auth-");

async function prepareCompactionParams() {
  const workspaceDir = tempDirs.make();
  resetCompactHooksHarnessMocks(workspaceDir);
  const sessionTarget = {
    agentId: "main",
    sessionId: "compaction-auth",
    sessionKey: "agent:main:compaction-auth",
    storePath: join(workspaceDir, "sessions.sqlite"),
  };
  await upsertSessionEntryCore(sessionTarget, {
    sessionId: sessionTarget.sessionId,
    updatedAt: 1,
  });
  return { ...sessionTarget, sessionTarget, sessionFile: sessionTarget.sessionKey, workspaceDir };
}

async function runOwnedCompaction(run: () => ReturnType<typeof compactEmbeddedAgentSessionDirect>) {
  const parent = new AsyncWorkScope();
  try {
    return await parent.run(run);
  } finally {
    await AsyncWorkScope.runWhenAllIdle(
      () => [parent],
      () => parent.drain(),
    );
  }
}

it.each(["lookup", "hook", "allowed"] as const)(
  "honors direct compaction cancellation across provider auth (%s)",
  async (stage) => {
    const baseParams = await prepareCompactionParams();
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("compaction source revoked"));
    getApiKeyForModelMock.mockImplementation(async (params) => {
      if (stage === "lookup") {
        cancel();
      }
      return {
        apiKey: "lookup-fixture-key",
        mode: "api-key",
        source: "compaction auth fixture",
        profileId: params?.profileId,
      };
    });
    const prepareAuth = vi.mocked(prepareProviderRuntimeAuth);
    const previousPrepareAuth = prepareAuth.getMockImplementation();
    onTestFinished(() => {
      prepareAuth.mockReset();
      if (previousPrepareAuth) {
        prepareAuth.mockImplementation(previousPrepareAuth);
      }
    });
    prepareAuth.mockReset();
    prepareAuth.mockImplementation(async () => {
      if (stage === "hook") {
        cancel();
      }
      return { apiKey: "prepared-fixture-key" };
    });
    const result = await runOwnedCompaction(() =>
      compactEmbeddedAgentSessionDirect({
        ...baseParams,
        provider: "openai",
        model: "gpt-primary",
        trigger: "budget",
        abortSignal: controller.signal,
        config: { agents: { defaults: { compaction: { model: "openai/gpt-primary" } } } },
      }),
    );
    expect(getApiKeyForModelMock).toHaveBeenCalled();
    expect(prepareAuth).toHaveBeenCalledTimes(stage === "lookup" ? 0 : 1);
    expect(result.ok).toBe(stage === "allowed");
    if (stage !== "allowed") {
      expect(result.reason).toContain("compaction source revoked");
    }
    expect(resolveModelMock).toHaveBeenCalled();
    for (const resolution of resolveModelMock.mock.results) {
      if (resolution.type === "return") {
        expect(resolution.value.authStorage.setRuntimeApiKey).toHaveBeenCalledTimes(
          stage === "allowed" ? 1 : 0,
        );
      }
    }
  },
);

it.each([false, true])(
  "retains sandbox placement through queued engine preparation (revoked=%s)",
  async (revoke) => {
    const baseParams = await prepareCompactionParams();
    let revoked = false;
    const dispose = vi.fn();
    const provider = {
      async prepareSandbox() {
        return {
          sandbox: null,
          assertCurrent() {
            if (revoked) {
              throw new Error("placement revoked during engine preparation");
            }
          },
          [Symbol.dispose]: dispose,
        };
      },
    };
    const uninstall = installSessionPlacementAdmissionProvider({
      ...provider,
      assertCompactionSuccessorAllowed() {},
      executeLocalTurn: async (_claim, run) => await run(),
      executeTurn: async (_claim, _params, run) => await run(),
    });
    resolveContextEngineMock.mockImplementation(async () => {
      revoked = revoke;
      return { info: { ownsCompaction: true }, compact: contextEngineCompactMock };
    });
    try {
      const operation = runOwnedCompaction(() =>
        compactEmbeddedAgentSession({
          ...baseParams,
          provider: "openai",
          model: "gpt-primary",
          trigger: "manual",
          enqueue: async (task) => await task(),
        }),
      );
      if (revoke) {
        await expect(operation).rejects.toThrow("placement revoked during engine preparation");
        expect(contextEngineCompactMock).not.toHaveBeenCalled();
      } else {
        await operation;
        expect(contextEngineCompactMock).toHaveBeenCalledOnce();
      }
      expect(resolveContextEngineMock).toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      uninstall();
    }
  },
);

it.each(["direct", "queued"] as const)(
  "returns a compaction failure when %s auth preparation is cooldowned",
  async (mode) => {
    const baseParams = await prepareCompactionParams();
    const authStore = {
      version: 1,
      profiles: {
        "summary:default": createApiKeyCredential("summary", "test-summary-key"),
      },
      order: { summary: ["summary:default"] },
      usageStats: { "summary:default": { cooldownUntil: Date.now() + 60_000 } },
    };
    const originalAuthStore = structuredClone(authStore);
    vi.mocked(ensureAuthProfileStoreWithoutExternalProfiles).mockReturnValue(authStore);
    const params = {
      ...baseParams,
      provider: "openai",
      model: "gpt-primary",
      trigger: "budget" as const,
      forcePreflight: true,
      preflightRequired: true,
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-primary", fallbacks: ["openai/gpt-fallback"] },
            compaction: { model: "summary/compact-model" },
          },
        },
      },
      enqueue: async <T>(task: () => Promise<T> | T) => await task(),
    };

    const result = await runOwnedCompaction(() =>
      mode === "direct"
        ? compactEmbeddedAgentSessionDirect(params)
        : compactEmbeddedAgentSession(params),
    );

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason:
        'Auth profile "summary:default" is temporarily unavailable for summary/compact-model.',
    });
    expect(resolveModelMock).toHaveBeenCalledTimes(1);
    expect(resolveModelMock.mock.calls[0]?.slice(0, 2)).toEqual(["summary", "compact-model"]);
    expect(contextEngineCompactMock).not.toHaveBeenCalled();
    expect(sessionCompactImpl).not.toHaveBeenCalled();
    expect(getApiKeyForModelMock).not.toHaveBeenCalled();
    expect(authStore).toEqual(originalAuthStore);
  },
);

it("compacts through the configured fallback when the primary profile is cooling down", async () => {
  const baseParams = await prepareCompactionParams();
  const agentDir = join(baseParams.workspaceDir, "agent");
  const authStore = {
    version: 1 as const,
    profiles: {
      "primary:default": createApiKeyCredential("primary", "test-primary-key"),
      "backup:default": createApiKeyCredential("backup", "test-backup-key"),
    },
    usageStats: {
      "primary:default": {
        cooldownUntil: Date.now() + 3_600_000,
        cooldownReason: "rate_limit" as const,
      },
    },
  };
  setRuntimeAuthProfileStoreSnapshot(authStore, agentDir);
  onTestFinished(() => {
    clearRuntimeAuthProfileStoreSnapshotCore(agentDir);
  });
  vi.mocked(ensureAuthProfileStoreWithoutExternalProfiles).mockReturnValue(authStore);
  resolveContextEngineMock.mockResolvedValue({
    info: { ownsCompaction: false },
    compact: vi.fn(delegateCompactionToRuntime),
  });

  const result = await runOwnedCompaction(() =>
    compactEmbeddedAgentSession({
      ...baseParams,
      agentDir,
      provider: "primary",
      model: "model",
      trigger: "budget",
      forcePreflight: true,
      preflightRequired: true,
      preflightCompactionTrigger: "transcript_bytes",
      config: {
        agents: {
          defaults: { model: { primary: "primary/model", fallbacks: ["backup/model"] } },
        },
      },
    }),
  );

  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
  expect(sessionCompactImpl).toHaveBeenCalledOnce();
  expect(getApiKeyForModelMock).toHaveBeenCalledWith(
    expect.objectContaining({ profileId: "backup:default" }),
  );
});
