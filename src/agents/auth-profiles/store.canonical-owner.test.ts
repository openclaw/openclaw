import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import {
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  createExpiredOauthStore,
  removeOAuthTestTempRoot,
} from "./oauth-test-utils.js";
import { AUTH_PROFILE_FILENAME, AUTH_STATE_FILENAME } from "./path-constants.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";

describe("canonical OAuth owner reconciliation", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let tempRoot = "";
  let mainAgentDir = "";

  beforeEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await createOAuthTestTempRoot("openclaw-auth-canonical-");
    mainAgentDir = await createOAuthMainAgentDir(tempRoot);
  });

  afterEach(async () => {
    envSnapshot.restore();
    clearRuntimeAuthProfileStoreSnapshots();
    await removeOAuthTestTempRoot(tempRoot);
  });

  it("reconciles duplicate openai-codex credentials out of non-owner agent stores", async () => {
    const profileId = "openai-codex:default";
    const subAgentDir = path.join(tempRoot, "agents", "orchestrator", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });

    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        access: "main-access",
        refresh: "main-refresh",
        accountId: "acct-main",
      }),
      mainAgentDir,
      { filterExternalAuthProfiles: false },
    );

    await fs.writeFile(
      path.join(subAgentDir, AUTH_PROFILE_FILENAME),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "orchestrator-access",
              refresh: "orchestrator-refresh",
              expires: Date.now() - 60_000,
              accountId: "acct-main",
            },
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "anthropic-key",
            },
          },
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(subAgentDir, AUTH_STATE_FILENAME),
      JSON.stringify(
        {
          version: 1,
          order: {
            "openai-codex": [profileId],
            anthropic: ["anthropic:default"],
          },
          lastGood: {
            "openai-codex": profileId,
          },
        },
        null,
        2,
      ),
    );

    const runtimeStore = ensureAuthProfileStore(subAgentDir);

    expect(runtimeStore.profiles[profileId]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "main-access",
      refresh: "main-refresh",
      accountId: "acct-main",
    });
    expect(runtimeStore.profiles["anthropic:default"]).toMatchObject({
      type: "api_key",
      provider: "anthropic",
      key: "anthropic-key",
    });

    const persistedSubStore = JSON.parse(
      await fs.readFile(path.join(subAgentDir, AUTH_PROFILE_FILENAME), "utf8"),
    ) as {
      profiles: Record<string, unknown>;
    };
    expect(persistedSubStore.profiles[profileId]).toBeUndefined();
    expect(persistedSubStore.profiles["anthropic:default"]).toBeTruthy();

    const persistedMainStore = JSON.parse(
      await fs.readFile(path.join(mainAgentDir, AUTH_PROFILE_FILENAME), "utf8"),
    ) as {
      profiles: Record<string, unknown>;
    };
    expect(persistedMainStore.profiles[profileId]).toBeTruthy();

    const persistedSubState = JSON.parse(
      await fs.readFile(path.join(subAgentDir, AUTH_STATE_FILENAME), "utf8"),
    ) as {
      lastGood?: Record<string, string>;
      order?: Record<string, string[]>;
    };
    expect(persistedSubState.lastGood?.["openai-codex"]).toBe(profileId);
    expect(persistedSubState.order?.["openai-codex"]).toEqual([profileId]);
  });
});
