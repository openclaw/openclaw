import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_STORE_VERSION } from "./constants.js";
import { testing as externalAuthTesting } from "./external-auth.js";
import { resolveAuthStorePath } from "./paths.js";
import { getRuntimeAuthProfileStoreSnapshot } from "./runtime-snapshots.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStoreWithoutExternalProfiles,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const PROFILE_ID = "anthropic:claude-cli";

const envBackup: Record<string, string | undefined> = {};
const envKeys = ["OPENCLAW_STATE_DIR"];
const tempDirs: string[] = [];

beforeEach(() => {
  for (const key of envKeys) {
    envBackup[key] = process.env[key];
  }
  clearRuntimeAuthProfileStoreSnapshots();
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
});

afterEach(() => {
  for (const key of envKeys) {
    if (envBackup[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envBackup[key];
    }
  }
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createCredential(): OAuthCredential {
  return {
    type: "oauth",
    provider: "anthropic",
    access: "runtime-access-token",
    refresh: "runtime-refresh-token",
    expires: Date.now() + 60_000,
    accountId: "acct-runtime",
  };
}

function createStore(credential = createCredential()): AuthProfileStore {
  return {
    version: AUTH_STORE_VERSION,
    profiles: {
      [PROFILE_ID]: credential,
    },
    order: {
      anthropic: [PROFILE_ID],
    },
    lastGood: {
      anthropic: PROFILE_ID,
    },
    usageStats: {
      [PROFILE_ID]: {
        lastUsed: 1,
      },
    },
  };
}

function createAgentDir(agentId = "main"): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-runtime-snapshot-"));
  tempDirs.push(stateDir);
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const agentDir = path.join(stateDir, "agents", agentId, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

describe("auth profile runtime snapshots", () => {
  it("preserves runtime-only external OAuth profiles in active snapshots after save", () => {
    const agentDir = createAgentDir();
    const credential = createCredential();
    const store = createStore(credential);
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => [
      {
        profileId: PROFILE_ID,
        credential,
        persistence: "runtime-only",
      },
    ]);
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);

    saveAuthProfileStore(store, agentDir);

    const runtimeCredential = getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles[PROFILE_ID];
    expect(runtimeCredential).toMatchObject({
      type: "oauth",
      provider: "anthropic",
      access: "runtime-access-token",
      refresh: "runtime-refresh-token",
    });
    expect(ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[PROFILE_ID]).toEqual(
      runtimeCredential,
    );
    const persisted = JSON.parse(
      fs.readFileSync(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(persisted.profiles[PROFILE_ID]).toBeUndefined();
  });

  it("does not pin inherited main OAuth profiles in child runtime snapshots", () => {
    const childAgentDir = createAgentDir("secondary");
    const mainCredential = createCredential();
    const refreshedMainCredential = {
      ...mainCredential,
      access: "main-refreshed-access-token",
      refresh: "main-refreshed-refresh-token",
      expires: mainCredential.expires + 60_000,
    };
    saveAuthProfileStore(createStore(mainCredential));
    const childStore = createStore(mainCredential);
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: childAgentDir, store: childStore }]);

    saveAuthProfileStore(childStore, childAgentDir);
    saveAuthProfileStore(createStore(refreshedMainCredential));

    expect(getRuntimeAuthProfileStoreSnapshot(childAgentDir)?.profiles[PROFILE_ID]).toBeUndefined();
    const resolvedCredential =
      ensureAuthProfileStoreWithoutExternalProfiles(childAgentDir).profiles[PROFILE_ID];
    expect(resolvedCredential).toMatchObject({
      type: "oauth",
      access: "main-refreshed-access-token",
      refresh: "main-refreshed-refresh-token",
    });
    const persisted = JSON.parse(
      fs.readFileSync(resolveAuthStorePath(childAgentDir), "utf8"),
    ) as AuthProfileStore;
    expect(persisted.profiles[PROFILE_ID]).toBeUndefined();
  });
});
