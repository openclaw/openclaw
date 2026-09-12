// Proves the native compaction credential handoff at the real store boundary:
// the compaction resolver reads a real on-disk auth-profile store seeded with a
// model-provider key and a competing CLI-owned account. Dropping an automatic
// model-provider pin must keep the native login (no discovered replacement
// account reaches the CLI run), and an unavailable explicit selection must be
// rejected before any child runs.
import { mkdirSync } from "node:fs";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { PreparedAgentRunAdmission } from "../admitted-run-context.js";
import { resolveAgentDir } from "../agent-scope-config.js";
import { clearAuthProfileMigrationDiagnostics } from "../auth-profiles/legacy-source-diagnostic.js";
import { updateAuthProfileStoreWithLock } from "../auth-profiles/store-runtime.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { compactNativeCliSession } from "./compact.js";

const { runCliAgentMock } = vi.hoisted(() => ({
  runCliAgentMock: vi.fn(async (_params: { preparedRunAdmission?: PreparedAgentRunAdmission }) => ({
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "native-session", provider: "claude-cli", model: "opus" },
    },
  })),
}));

vi.mock("../cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));

describe("native CLI manual compaction: CLI child credential handoff", () => {
  let stateDir: string;
  let agentDir: string;

  beforeEach(() => {
    stateDir = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-compact-child-auth-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    agentDir = resolveAgentDir({}, "agent");
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    clearAuthProfileMigrationDiagnostics();
    cliBackendsTesting.resetDepsForTest();
    runCliAgentMock.mockClear();
  });

  async function seedAuthProfile(profileId: string, credential: unknown) {
    await updateAuthProfileStoreWithLock({
      agentDir,
      updater: (store) => {
        store.profiles[profileId] = credential as never;
        return true;
      },
    });
  }

  function registerScriptedClaudeCliBackend() {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () =>
        [
          {
            id: "claude-cli",
            modelProvider: "anthropic",
            pluginId: "anthropic",
            ownsNativeCompaction: true,
            bundleMcp: false,
            config: {
              command: "claude",
              args: ["-p"],
              input: "stdin",
              output: "jsonl",
              sessionMode: "existing",
            },
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
  }

  function compactParams(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: "openclaw-session",
      sessionKey: "agent:agent:main",
      sessionTarget: {
        agentId: "agent",
        sessionId: "openclaw-session",
        sessionKey: "agent:agent:main",
        storePath: nodePath.join(stateDir, "openclaw.sqlite"),
      },
      sessionFile: "agent:agent:main",
      agentId: "agent",
      workspaceDir: nodePath.join(stateDir, "workspace"),
      agentDir,
      config: {},
      provider: "anthropic",
      model: "claude-opus-4-6",
      trigger: "manual",
      cliSessionId: "native-session",
      cliSessionBinding: { sessionId: "native-session" },
      sessionEntry: {},
      customInstructions: "keep decisions",
      preparedModelRuntime: {},
      ...overrides,
    } as never;
  }

  it("keeps the native login when a competing stored CLI account is eligible", async () => {
    registerScriptedClaudeCliBackend();
    await seedAuthProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "test-anthropic-key",
    });
    await seedAuthProfile("claude-cli:work", {
      type: "oauth",
      provider: "claude-cli",
      access: "test-cli-work-token",
      refresh: "test-cli-work-refresh",
      expires: Date.now() + 3_600_000,
    });

    await compactNativeCliSession({
      runtime: "claude-cli",
      compactParams: compactParams({
        authProfileId: "anthropic:default",
        authProfileIdSource: "auto",
      }),
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    const forwarded = runCliAgentMock.mock.calls[0]?.[0] as { authProfileId?: string };
    // The auto model-provider pin is dropped, and the competing CLI-owned
    // credential is not discovered as a replacement: the compaction child
    // keeps its own native login instead of receiving another account.
    expect(forwarded.authProfileId).toBeUndefined();
  }, 60_000);

  it("rejects an unavailable explicit selection before the compaction child runs", async () => {
    registerScriptedClaudeCliBackend();

    await expect(
      compactNativeCliSession({
        runtime: "claude-cli",
        compactParams: compactParams({
          authProfileId: "anthropic:missing",
          authProfileIdSource: "user",
        }),
      }),
    ).rejects.toThrow(/No credentials found for profile "anthropic:missing"/);
    expect(runCliAgentMock).not.toHaveBeenCalled();
  }, 60_000);
});
