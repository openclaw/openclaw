import fs from "node:fs/promises";
import path from "node:path";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, expect, it } from "vitest";
import {
  QA_CODEX_OAUTH_PROFILE_ID,
  QA_OPENAI_API_KEY_PROFILE_ID,
  type QaAuthProfileShape,
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

async function createAgentState(shape: QaAuthProfileShape = "mixed") {
  const stateDir = await tempDirs.makeTempDir("qa-codex-lifecycle-");
  const agentId = "qa";
  const agentDir = path.join(stateDir, "agents", agentId, "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await seedAuthProfiles(shape, { agentId, stateDir });
  return {
    agentDir,
    evaluate: async (config?: unknown, doctorFix = false) =>
      evaluateCodexPluginLifecycle({
        plugin: await snapshotCodexPluginState(agentDir),
        auth: await snapshotAuthProfiles(agentDir),
        config,
        doctorFix,
      }),
  };
}

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await tempDirs.cleanup();
});

it("repairs a missing codex plugin before the retry succeeds without leaking to the API-key path", async () => {
  const { agentDir, evaluate } = await createAgentState();
  await removeCodexPluginFixture(agentDir);
  const missing = await evaluate();
  expect(resolveCodexAuthProfile(await snapshotAuthProfiles(agentDir))).toMatchObject({
    status: "ready",
    profileId: QA_CODEX_OAUTH_PROFILE_ID,
    provider: "openai",
    mode: "oauth",
  });
  expect(missing).toMatchObject({
    status: "repair-required",
    remediation: CODEX_PLUGIN_LIFECYCLE_MESSAGES.missingPlugin,
    selectedAuthProfileId: QA_CODEX_OAUTH_PROFILE_ID,
  });
  expect(missing.selectedAuthProfileId).not.toBe(QA_OPENAI_API_KEY_PROFILE_ID);

  await installCodexPluginFixture(agentDir);
  const repaired = await evaluate();
  expect(repaired).toMatchObject({ status: "ready", tokenRoute: "codex-oauth" });
  expect(repaired.remediation).toBeUndefined();
});

it.each([
  ["oauth-only", undefined],
  ["mixed", "defaults"],
  ["mixed", "main"],
] as const)(
  "keeps %s auth and strips stale OpenClaw runtime pins at %s",
  async (profileShape, pin) => {
    const { agentDir, evaluate } = await createAgentState(profileShape);
    await installCodexPluginFixture(agentDir);
    const pinned = { agentRuntime: { id: "openclaw" } };
    const config = {
      agents: pin === "defaults" ? { defaults: pinned } : pin ? { entries: { main: pinned } } : {},
    };
    expect(await evaluate(config, true)).toMatchObject({
      status: "ready",
      selectedAuthProfileId: QA_CODEX_OAUTH_PROFILE_ID,
      tokenRoute: "codex-oauth",
      removedRuntimePins: pin ? ["agentRuntime.id=openclaw"] : [],
    });
  },
);
