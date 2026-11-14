import "./external-auth.test-support.js";
import { afterEach, expect, it } from "vitest";
import { assertProviderAuthAuthority } from "../../plugins/provider-auth-authority.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withAuthProfileCredentialWrite } from "../../state/user-model-account-authority.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { createApiKeyCredential as apiKey } from "./credential-fixtures.test-support.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { withAuthProfileTestState } from "./profile-mutations.test-support.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots as publishSnapshots,
} from "./runtime-snapshots.js";
import { runAuthProfileWriteTransaction, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import {
  loadAuthProfileStoreForRuntime as loadRuntime,
  saveAuthProfileStore,
} from "./store-runtime.js";
import { getRuntimeAuthProfileStoreSnapshot as runtimeSnapshot } from "./store.js";
import type { AuthProfileCredential } from "./types.js";

const profileStore = (id: string, credential: AuthProfileCredential) => ({
  version: AUTH_STORE_VERSION,
  profiles: { [id]: credential },
});
const saveProfile = (id: string, credential: AuthProfileCredential, agentDir?: string) =>
  saveAuthProfileStore(profileStore(id, credential), agentDir);
const withProfileState = (run: Parameters<typeof withAuthProfileTestState<void>>[1]) =>
  withAuthProfileTestState("auth-recovered-inheritance-", run, { clearOAuthDir: true });
afterEach(() => clearRuntimeAuthProfileStoreSnapshots());

it("refuses unpublished local shadows and unreadable owners", () =>
  withProfileState(async ({ agentDirFor }) => {
    const agentDir = agentDirFor("shadow-before-preparation");
    const profileId = "openai:shared";
    saveProfile(profileId, apiKey("openai", "shared"));
    saveProfile("google:local", apiKey("google", "local"), agentDir);
    const retained = loadRuntime(agentDir);
    publishSnapshots([{ agentDir, store: retained }]);
    writePersistedAuthProfileStoreRaw(
      profileStore(profileId, apiKey("openai", "shadow")),
      agentDir,
    );
    const resolve = () =>
      resolveApiKeyForProfile({ cfg: {}, store: retained, profileId, agentDir });
    await expect(resolve()).rejects.toThrow(/removed|replaced/);
    clearRuntimeAuthProfileStoreSnapshots();
    writePersistedAuthProfileStoreRaw(
      { version: AUTH_STORE_VERSION, profiles: "invalid" },
      agentDir,
    );
    await expect(resolve()).rejects.toThrow();
  }));

it.each(["shadow", "malformed", "unknown-outcome", "retired", "closed"])(
  "fences recovered inherited credentials after local %s while allowing unrelated recovery",
  (change) =>
    withProfileState(async ({ agentDirFor }) => {
      const agentDir = agentDirFor("recovered");
      const profileId = "openai:shared";
      saveProfile(profileId, apiKey("openai", "shared"));
      saveProfile("google:local", apiKey("google", "local"), agentDir);
      publishSnapshots([{ agentDir, store: loadRuntime(agentDir) }]);
      const corrupt = () =>
        writePersistedAuthProfileStoreRaw(
          { version: AUTH_STORE_VERSION, profiles: "invalid-profile-map" },
          agentDir,
        );
      corrupt();
      saveProfile(profileId, apiKey("openai", "rotated"));
      const recovered = runtimeSnapshot(agentDir)!;
      const selected = await resolveApiKeyForProfile({
        cfg: {},
        store: recovered,
        profileId,
        agentDir,
      });
      expect(selected?.apiKey).toBe("rotated");
      assertProviderAuthAuthority(selected!);
      saveProfile("google:local", apiKey("google", "unrelated"), agentDir);
      assertProviderAuthAuthority(selected!);
      const current = await resolveApiKeyForProfile({
        cfg: {},
        store: runtimeSnapshot(agentDir)!,
        profileId,
        agentDir,
      });
      expect(current?.apiKey).toBe("rotated");
      assertProviderAuthAuthority(current!);
      if (change === "shadow") {
        saveProfile(profileId, apiKey("openai", "local-shadow"), agentDir);
      } else if (change === "malformed") {
        corrupt();
      } else if (change === "unknown-outcome") {
        runAuthProfileWriteTransaction(agentDir, ({ db }) => {
          expect(() =>
            withAuthProfileCredentialWrite(db, undefined, () => {
              throw new Error("lost credential write outcome");
            }),
          ).toThrow("lost credential write outcome");
        });
        expect(() => assertProviderAuthAuthority(selected!)).toThrow();
        saveProfile("google:local", apiKey("google", "later-known"), agentDir);
        await expect(
          resolveApiKeyForProfile({
            cfg: {},
            store: runtimeSnapshot(agentDir)!,
            profileId,
            agentDir,
          }),
        ).rejects.toThrow();
      } else if (change === "retired") {
        clearRuntimeAuthProfileStoreSnapshots();
      } else {
        closeOpenClawAgentDatabasesForTest();
      }
      expect(() => assertProviderAuthAuthority(selected!)).toThrow();
    }),
);

it("retains canonical shared SecretRef authority through materialized recovery", () =>
  withProfileState(async ({ agentDirFor }) => {
    const agentDir = agentDirFor("recovered-reference");
    const profileId = "openai:shared";
    const keyRef = { source: "env", provider: "default", id: "OPENAI_API_KEY" } as const;
    const credential = { type: "api_key" as const, provider: "openai", keyRef };
    saveProfile(profileId, apiKey("openai", "old"));
    saveProfile("google:local", apiKey("google", "local"), agentDir);
    publishSnapshots([{ agentDir, store: loadRuntime(agentDir) }]);
    writePersistedAuthProfileStoreRaw(
      { version: AUTH_STORE_VERSION, profiles: "invalid" },
      agentDir,
    );
    saveProfile(profileId, credential);
    const recovered = runtimeSnapshot(agentDir)!;
    recovered.profiles[profileId] = { ...credential, key: "materialized" };
    publishSnapshots([{ agentDir, store: recovered }]);
    const selected = await resolveApiKeyForProfile({
      cfg: {},
      store: recovered,
      profileId,
      agentDir,
    });
    expect(selected?.apiKey).toBe("materialized");
    assertProviderAuthAuthority(selected!);
    saveAuthProfileStore({ version: AUTH_STORE_VERSION, profiles: {} });
    expect(() => assertProviderAuthAuthority(selected!)).toThrow();
  }));
