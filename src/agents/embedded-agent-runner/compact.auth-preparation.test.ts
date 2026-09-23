import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
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
  { closeOpenClawAgentDatabasesForTest },
  { ensureAuthProfileStoreWithoutExternalProfiles },
  { AsyncWorkScope },
  { prepareProviderRuntimeAuth },
] = await Promise.all([
  import("../../config/sessions/session-accessor.js"),
  import("../../state/openclaw-agent-db.js"),
  import("../model-auth.js"),
  import("../../shared/async-work-scope.js"),
  import("../../plugins/provider-runtime.js"),
]);
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);

it.each(["lookup", "hook", "allowed"] as const)(
  "honors direct compaction cancellation across provider auth (%s)",
  async (stage) => {
    const workspaceDir = await realpath(tempDirs.make("openclaw-compaction-auth-cancel-"));
    resetCompactHooksHarnessMocks(workspaceDir);
    const sessionTarget = {
      agentId: "main",
      sessionId: "compaction-auth-cancel",
      sessionKey: "agent:main:compaction-auth-cancel",
      storePath: join(workspaceDir, "sessions.sqlite"),
    };
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: sessionTarget.sessionId,
      updatedAt: 1,
    });
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
    const parent = new AsyncWorkScope();
    let result: Awaited<ReturnType<typeof compactEmbeddedAgentSessionDirect>>;
    try {
      result = await parent.run(() =>
        compactEmbeddedAgentSessionDirect({
          ...sessionTarget,
          sessionTarget,
          sessionFile: sessionTarget.sessionKey,
          workspaceDir,
          provider: "openai",
          model: "gpt-primary",
          trigger: "budget",
          abortSignal: controller.signal,
          config: { agents: { defaults: { compaction: { model: "openai/gpt-primary" } } } },
        }),
      );
    } finally {
      await AsyncWorkScope.runWhenAllIdle(
        () => [parent],
        () => parent.drain(),
      );
    }
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
    const workspaceDir = await realpath(tempDirs.make("openclaw-compaction-auth-"));
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
      ...sessionTarget,
      sessionTarget,
      sessionFile: sessionTarget.sessionKey,
      workspaceDir,
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

    const parent = new AsyncWorkScope();
    let result: Awaited<ReturnType<typeof compactEmbeddedAgentSession>>;
    try {
      result = await parent.run(() =>
        mode === "direct"
          ? compactEmbeddedAgentSessionDirect(params)
          : compactEmbeddedAgentSession(params),
      );
    } finally {
      await AsyncWorkScope.runWhenAllIdle(
        () => [parent],
        () => parent.drain(),
      );
    }

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
