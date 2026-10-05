import { join } from "node:path";
import { afterAll, expect, it, onTestFinished, vi } from "vitest";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import {
  contextEngineCompactMock,
  getApiKeyForModelMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
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
