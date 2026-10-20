import fs from "node:fs/promises";
import path from "node:path";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  QA_CODEX_OAUTH_PROFILE_ID,
  QA_OPENAI_API_KEY_PROFILE_ID,
  resolveCodexAuthProfile,
  seedAuthProfiles,
  snapshotAuthProfiles,
} from "./auth-profile.fixture.js";
import {
  CODEX_PLUGIN_LIFECYCLE_MESSAGES,
  evaluateCodexPluginLifecycle,
  installCodexPluginFixture,
  removeCodexPluginFixture,
  snapshotCodexPluginState,
} from "./codex-plugin.fixture.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

async function createAgentState(prefix: string) {
  const stateDir = await tempDirs.makeTempDir(prefix);
  const agentId = "qa";
  const agentDir = path.join(stateDir, "agents", agentId, "agent");
  await fs.mkdir(agentDir, { recursive: true });
  return { agentDir, agentId, stateDir };
}

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await tempDirs.cleanup();
});

describe("codex plugin lifecycle", () => {
  it("repairs a missing codex plugin before the retry succeeds without leaking to the API-key path", async () => {
    const { agentDir, agentId, stateDir } = await createAgentState("qa-codex-plugin-cold-");
    await removeCodexPluginFixture(agentDir);
    await seedAuthProfiles("mixed", { agentId, stateDir });

    const missing = evaluateCodexPluginLifecycle({
      plugin: await snapshotCodexPluginState(agentDir),
      auth: await snapshotAuthProfiles(agentDir),
    });

    expect(missing).toMatchObject({
      status: "repair-required",
      remediation: CODEX_PLUGIN_LIFECYCLE_MESSAGES.missingPlugin,
      selectedAuthProfileId: QA_CODEX_OAUTH_PROFILE_ID,
    });
    expect(missing.selectedAuthProfileId).not.toBe(QA_OPENAI_API_KEY_PROFILE_ID);

    await installCodexPluginFixture(agentDir);
    const repaired = evaluateCodexPluginLifecycle({
      plugin: await snapshotCodexPluginState(agentDir),
      auth: await snapshotAuthProfiles(agentDir),
    });

    expect(repaired).toMatchObject({ status: "ready", tokenRoute: "codex-oauth" });
    expect(repaired.remediation).toBeUndefined();
  });

  it("selects openai OAuth when openai API-key profiles are present", async () => {
    const { agentDir, agentId, stateDir } = await createAgentState("qa-codex-auth-mixed-");
    await seedAuthProfiles("mixed", { agentId, stateDir });

    const selection = resolveCodexAuthProfile(await snapshotAuthProfiles(agentDir));

    expect(selection).toMatchObject({
      status: "ready",
      profileId: QA_CODEX_OAUTH_PROFILE_ID,
      provider: "openai",
      mode: "oauth",
    });
    expect(selection).not.toMatchObject({ profileId: QA_OPENAI_API_KEY_PROFILE_ID });
  });

  it.each([
    { name: "oauth-only host", profileShape: "oauth-only" as const, config: {} },
    { name: "mixed profile with no pin", profileShape: "mixed" as const, config: {} },
    {
      name: "mixed profile with defaults OpenClaw pin",
      profileShape: "mixed" as const,
      config: { agents: { defaults: { agentRuntime: { id: "openclaw" } } } },
      expectedRemovedRuntimePins: ["agentRuntime.id=openclaw"],
    },
    {
      name: "mixed profile with main-agent OpenClaw pin",
      profileShape: "mixed" as const,
      config: { agents: { entries: { main: { agentRuntime: { id: "openclaw" } } } } },
      expectedRemovedRuntimePins: ["agentRuntime.id=openclaw"],
    },
  ])(
    "keeps codex auth and strips stale OpenClaw runtime pins for $name",
    async ({ profileShape, config, expectedRemovedRuntimePins = [] }) => {
      const { agentDir, agentId, stateDir } = await createAgentState("qa-codex-doctor-matrix-");
      await installCodexPluginFixture(agentDir);
      await seedAuthProfiles(profileShape, { agentId, stateDir });

      const result = evaluateCodexPluginLifecycle({
        plugin: await snapshotCodexPluginState(agentDir),
        auth: await snapshotAuthProfiles(agentDir),
        config,
        doctorFix: true,
      });

      expect(result).toMatchObject({
        status: "ready",
        selectedAuthProfileId: QA_CODEX_OAUTH_PROFILE_ID,
        tokenRoute: "codex-oauth",
        removedRuntimePins: expectedRemovedRuntimePins,
      });
    },
  );
});
