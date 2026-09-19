import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
] = await Promise.all([
  import("../../config/sessions/session-accessor.js"),
  import("../../state/openclaw-agent-db.js"),
  import("../model-auth.js"),
  import("../../shared/async-work-scope.js"),
]);
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
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
