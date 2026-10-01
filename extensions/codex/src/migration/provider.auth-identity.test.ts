// Register native mocks before migration modules load.
// oxfmt-ignore
import {
  credentialStorage,
  createCodexFixture,
  fakeJwt,
  findItem,
  loadTargetAuthStore,
  makeContext,
  targetAgentDir,
  writeFile,
} from "./provider.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
} from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  updateAuthProfileStoreWithLock,
  upsertAuthProfile,
  type OAuthCredential,
} from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
import { buildCodexMigrationProvider } from "./provider.js";

type CodexFixture = Awaited<ReturnType<typeof createCodexFixture>>;

function authContext(fixture: CodexFixture, config?: MigrationProviderContext["config"]) {
  return makeContext({
    source: fixture.codexHome,
    stateDir: fixture.stateDir,
    workspaceDir: fixture.workspaceDir,
    includeSecrets: true,
    itemKinds: ["auth"],
    providerOptions: { credentialKind: "oauth", configPatchMode: "none" },
    config,
  });
}

function nativeToken(accountId = "native-account", userId = "native-user", exp = 2_100_000_000) {
  return fakeJwt({
    exp,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_user_id: userId },
  });
}

async function writeOAuth(
  fixture: CodexFixture,
  access = nativeToken(),
  accountId = "native-account",
  refresh = "native-refresh",
) {
  const auth = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: access, refresh_token: refresh, account_id: accountId },
  });
  await writeFile(path.join(fixture.codexHome, "auth.json"), auth);
  return auth;
}

function legacyConfig(fixture: CodexFixture): MigrationProviderContext["config"] {
  return {
    agents: { defaults: { workspace: fixture.workspaceDir } },
    auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
  };
}

function oauthProfile(
  access: string,
  refresh: string,
  expires = 2_100_000_000_000,
): OAuthCredential {
  return { type: "oauth", provider: "openai", access, refresh, expires };
}

async function legacyImport() {
  const fixture = await createCodexFixture();
  vi.stubEnv("CODEX_HOME", fixture.codexHome);
  credentialStorage.accountType = "chatgpt";
  const access = nativeToken();
  const nativeAuth = await writeOAuth(fixture, access);
  const ctx = authContext(fixture, legacyConfig(fixture));
  const provider = buildCodexMigrationProvider();
  const configBefore = structuredClone(ctx.config);
  const plan = await provider.plan(ctx);
  return { fixture, access, nativeAuth, ctx, configBefore, provider, plan };
}

async function expectNoLocalProfiles(fixture: CodexFixture) {
  await updateAuthProfileStoreWithLock({
    agentDir: targetAgentDir(fixture),
    stateDir: fixture.stateDir,
    updater: (localStore) => {
      expect(localStore.profiles).toEqual({});
      return false;
    },
  });
}

describe("Codex migration auth identity and inherited profiles", () => {
  it("does not reuse another user's OAuth profile in the same ChatGPT workspace", async () => {
    const fixture = await createCodexFixture();
    const jwt = (user: string) => nativeToken("shared-workspace", user, 2_000_000_000);
    const existing = {
      ...oauthProfile(jwt("previous-user"), "previous-refresh", 2_000_000_000_000),
      accountId: "shared-workspace",
    };
    upsertAuthProfile({
      profileId: "openai:account-shared-workspace",
      credential: existing,
      agentDir: targetAgentDir(fixture),
    });
    await writeOAuth(fixture, jwt("new-user"), "shared-workspace", "new-refresh");
    const provider = buildCodexMigrationProvider();
    const ctx = authContext(fixture);
    const plan = await provider.plan(ctx);
    expect(findItem(plan.items, "auth:openai").status).toBe("conflict");
    await provider.apply(ctx, plan);
    expect(loadTargetAuthStore(fixture).profiles["openai:account-shared-workspace"]).toEqual(
      existing,
    );
  });

  it("preserves an expired same-account local OAuth profile", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
    const expires = 1_899_999_999_999;
    try {
      const fixture = await createCodexFixture();
      credentialStorage.accountType = "chatgpt";
      const profileId = "openai:existing-account";
      const existing = {
        ...oauthProfile(
          nativeToken("same-account", "same-user", expires / 1000),
          "old-refresh",
          expires,
        ),
        accountId: "same-account",
      };
      const unrelated = { type: "api_key" as const, provider: "other", key: "unrelated-key" };
      const seeded = await updateAuthProfileStoreWithLock({
        agentDir: targetAgentDir(fixture),
        stateDir: fixture.stateDir,
        updater(store) {
          store.profiles[profileId] = existing;
          store.profiles["other:retained"] = unrelated;
          return true;
        },
      });
      expect(seeded?.profiles).toEqual({ [profileId]: existing, "other:retained": unrelated });
      await writeOAuth(
        fixture,
        nativeToken("same-account", "same-user"),
        "same-account",
        "new-native-refresh",
      );
      const ctx = authContext(fixture, {
        agents: { defaults: { model: "other/retained", workspace: fixture.workspaceDir } },
      });
      const configBefore = structuredClone(ctx.config);
      const provider = buildCodexMigrationProvider();
      const plan = await provider.plan(ctx);
      expect(findItem(plan.items, "auth:openai").status).toBe("skipped");
      expect(findItem(plan.items, "auth:openai")).toMatchObject({
        reason: "existing OAuth profile requires sign-in",
        details: { credentialImportUnavailable: true },
      });
      const result = await provider.apply(ctx, plan);
      expect(findItem(result.items, "auth:openai").status).toBe("skipped");
      expect(loadTargetAuthStore(fixture).profiles).toEqual({
        [profileId]: existing,
        "other:retained": unrelated,
      });
      expect(ctx.config).toEqual(configBefore);
    } finally {
      clock.mockRestore();
    }
  });

  it("preserves the configured CLI-backed profile during explicit import with an agent home", async () => {
    const fixture = await createCodexFixture();
    vi.stubEnv("CODEX_HOME", fixture.codexHome);
    credentialStorage.accountType = "chatgpt";
    const access = nativeToken();
    const nativeAuth = await writeOAuth(fixture, access);
    const config: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
          model: "openai/gpt-5.4@openai:default",
        },
      },
      auth: {
        profiles: { "openai:default": { provider: "openai", mode: "oauth" } },
        order: { openai: ["openai:default"] },
      },
      plugins: { entries: { codex: { config: { appServer: { homeScope: "agent" } } } } },
    };
    const before = structuredClone(config);
    const ctx = authContext(fixture, config);
    const provider = buildCodexMigrationProvider();

    const result = await provider.apply(ctx, await provider.plan(ctx));

    expect(findItem(result.items, "auth:openai")).toMatchObject({
      status: "migrated",
      details: { profileId: "openai:default" },
    });
    expect(loadTargetAuthStore(fixture).profiles).toEqual({
      "openai:default": expect.objectContaining({
        type: "oauth",
        provider: "openai",
        access,
        accountId: "native-account",
      }),
    });
    expect(config).toEqual(before);
    expect(await fs.readFile(path.join(fixture.codexHome, "auth.json"), "utf8")).toBe(nativeAuth);

    const repeated = await provider.apply(ctx, await provider.plan(ctx));
    expect(findItem(repeated.items, "auth:openai")).toMatchObject({
      status: "migrated",
      details: { profileId: "openai:default", wroteAuthProfile: false },
    });
  });

  it.each(["other source home", "missing user"])(
    "keeps the account-scoped import identity for %s",
    async (scenario) => {
      const fixture = await createCodexFixture();
      vi.stubEnv(
        "CODEX_HOME",
        scenario === "other source home"
          ? path.join(fixture.root, "other-codex")
          : fixture.codexHome,
      );
      credentialStorage.accountType = "chatgpt";
      const access = fakeJwt({
        exp: 2_100_000_000,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "native-account",
          ...(scenario === "missing user" ? {} : { chatgpt_user_id: "native-user" }),
        },
      });
      await writeOAuth(fixture, access);
      const ctx = authContext(fixture, legacyConfig(fixture));
      const before = structuredClone(ctx.config);
      const provider = buildCodexMigrationProvider();

      const result = await provider.apply(ctx, await provider.plan(ctx));

      expect(findItem(result.items, "auth:openai")).toMatchObject({
        status: "migrated",
        details: { profileId: "openai:account-native-account" },
      });
      expect(loadTargetAuthStore(fixture).profiles["openai:default"]).toBeUndefined();
      expect(ctx.config).toEqual(before);
    },
  );

  it("does not fill the legacy pin after another account is imported during planning", async () => {
    const { fixture, ctx, provider, plan } = await legacyImport();
    expect(findItem(plan.items, "auth:openai")).toMatchObject({
      status: "planned",
      details: { profileId: "openai:default" },
    });
    const managed = oauthProfile("managed-access", "managed-refresh");
    upsertAuthProfile({
      profileId: "openai:managed",
      credential: managed,
      agentDir: targetAgentDir(fixture),
    });

    const result = await provider.apply(ctx, plan);

    expect(findItem(result.items, "auth:openai").status).toBe("conflict");
    expect(loadTargetAuthStore(fixture).profiles).toEqual({ "openai:managed": managed });
  });

  it("rejects a different inherited account added at the planned legacy destination", async () => {
    const { fixture, nativeAuth, ctx, configBefore, provider, plan } = await legacyImport();
    expect(findItem(plan.items, "auth:openai")).toMatchObject({
      status: "planned",
      details: { profileId: "openai:default" },
    });
    const inherited = oauthProfile(nativeToken("shared-account", "shared-user"), "shared-refresh");
    upsertAuthProfile({ profileId: "openai:default", credential: inherited });

    const result = await provider.apply(ctx, plan);

    expect(findItem(result.items, "auth:openai").status).toBe("conflict");
    clearRuntimeAuthProfileStoreSnapshots();
    expect(loadTargetAuthStore(fixture).profiles).toEqual({ "openai:default": inherited });
    await expectNoLocalProfiles(fixture);
    expect(ctx.config).toEqual(configBefore);
    expect(await fs.readFile(path.join(fixture.codexHome, "auth.json"), "utf8")).toBe(nativeAuth);
  });

  it.each([
    {
      state: "usable",
      expires: 2_100_000_000_000,
      status: "migrated",
    },
    { state: "expired", expires: 1_000, status: "skipped" },
  ])("checks inherited matching OAuth after planning ($state)", async ({ expires, status }) => {
    const { fixture, access, ctx, provider, plan } = await legacyImport();
    expect(findItem(plan.items, "auth:openai").status).toBe("planned");
    const inherited = oauthProfile(access, "shared-refresh", expires);
    upsertAuthProfile({ profileId: "openai:default", credential: inherited });

    const result = await provider.apply(ctx, plan);

    expect(findItem(result.items, "auth:openai").status).toBe(status);
    await expectNoLocalProfiles(fixture);
    clearRuntimeAuthProfileStoreSnapshots();
    expect(loadTargetAuthStore(fixture).profiles["openai:default"]).toMatchObject({ access });
    expect(loadAuthProfileStoreForSecretsRuntime().profiles).toEqual({
      "openai:default": inherited,
    });
  });
});
