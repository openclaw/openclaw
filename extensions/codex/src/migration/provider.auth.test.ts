// Register native mocks before migration modules load.
// oxfmt-ignore
import {
  closeCredentialReader,
  nativeCredentialReaderStart,
  credentialStorage,
  createCodexFixture,
  createConfigRuntime,
  createFailingConfigRuntime,
  expectRecordFields,
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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readCodexCliCredentialsAsync } from "./cli-credentials.js";
import { buildCodexMigrationProvider } from "./provider.js";

type CodexFixture = Awaited<ReturnType<typeof createCodexFixture>>;
let fixture: CodexFixture;
let provider: ReturnType<typeof buildCodexMigrationProvider>;
beforeEach(async () => {
  fixture = await createCodexFixture();
  provider = buildCodexMigrationProvider();
});

function importContext(
  options: Omit<Parameters<typeof makeContext>[0], "source" | "stateDir" | "workspaceDir">,
) {
  return makeContext({ ...fixture, source: fixture.codexHome, includeSecrets: true, ...options });
}

async function writeAuth(auth: Record<string, unknown>) {
  await writeFile(path.join(fixture.codexHome, "auth.json"), JSON.stringify(auth));
}

async function createOAuthImport(accountId: string, email = "codex@example.test") {
  const accessToken = fakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" },
    "https://api.openai.com/profile": { email },
  });
  await writeAuth({
    auth_mode: "chatgpt",
    tokens: {
      access_token: accessToken,
      refresh_token: "fixture-refresh",
      account_id: accountId,
    },
  });
  const configState: MigrationProviderContext["config"] = {
    agents: { defaults: { workspace: fixture.workspaceDir } },
  };
  const ctx = importContext({
    config: configState,
    runtime: createConfigRuntime(configState),
    reportDir: path.join(fixture.root, "report"),
  });
  return { accessToken, configState, ctx };
}

async function selectedApiKeyImport(key: string) {
  await writeAuth({ auth_mode: "apikey", OPENAI_API_KEY: key });
  const ctx = importContext({
    itemKinds: ["auth"],
    providerOptions: { credentialKind: "api_key", configPatchMode: "none" },
  });
  return { ctx, plan: await provider.plan(ctx) };
}

function authContext(config?: MigrationProviderContext["config"]) {
  return importContext({
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

function legacyConfig(): MigrationProviderContext["config"] {
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
  vi.stubEnv("CODEX_HOME", fixture.codexHome);
  credentialStorage.accountType = "chatgpt";
  const access = nativeToken();
  const nativeAuth = await writeOAuth(access);
  const ctx = authContext(legacyConfig());
  const configBefore = structuredClone(ctx.config);
  const plan = await provider.plan(ctx);
  return { access, nativeAuth, ctx, configBefore, plan };
}

async function expectNoLocalProfiles() {
  await updateAuthProfileStoreWithLock({
    agentDir: targetAgentDir(fixture),
    stateDir: fixture.stateDir,
    updater: (localStore) => {
      expect(localStore.profiles).toEqual({});
      return false;
    },
  });
}

describe("Codex migration credential inspection and persistence", () => {
  it("does not open native credential storage when prompting is explicitly disabled", async () => {
    await writeAuth({
      OPENAI_API_KEY: "fixture-uninspected-key",
      tokens: {
        access_token: fakeJwt({ exp: 2_000_000_000 }),
        refresh_token: "fixture-refresh",
      },
    });
    credentialStorage.requiredMode = "keyring";
    const plan = await provider.plan(
      importContext({
        itemKinds: ["auth"],
        providerOptions: { credentialKind: "api_key", allowKeychainPrompt: false },
      }),
    );

    expect(nativeCredentialReaderStart).not.toHaveBeenCalled();
    expect(plan.items).toEqual([
      expect.objectContaining({
        kind: "auth",
        status: "skipped",
        details: expect.objectContaining({ credentialImportUnavailable: true }),
      }),
    ]);
    expect(loadTargetAuthStore(fixture).profiles).toEqual({});
  });

  it.each(["oauth", "api_key"])(
    "offers uninspected auth and skips only the changed %s from one fresh snapshot",
    async (changed) => {
      const auth = {
        OPENAI_API_KEY: "fixture-consented-key",
        tokens: {
          access_token: fakeJwt({ exp: 2_000_000_000 }),
          refresh_token: "fixture-consented-refresh",
          account_id: "read-once-account",
        },
      };
      await writeAuth(auth);
      credentialStorage.accountType = "apiKey";
      const ctx = importContext({
        itemKinds: ["auth"],
        includeSecrets: false,
        providerOptions: { configPatchMode: "none" },
      });
      const offer = await provider.plan(ctx);

      expect.soft(nativeCredentialReaderStart).not.toHaveBeenCalled();
      expect
        .soft(offer.items.map((item) => item.id))
        .toEqual(["auth:openai", "auth:openai:api-key"]);
      for (const item of offer.items) {
        expect.soft(item.reason).toBeUndefined();
        expect.soft(item.message).toContain("Codex credentials have not been inspected.");
        expect.soft(item.message).toContain("Confirm credential import");
      }
      expect.soft(findItem(offer.items, "auth:openai")).toMatchObject({
        kind: "auth",
        status: "skipped",
        sensitive: true,
      });
      expect.soft(findItem(offer.items, "auth:openai").details).not.toHaveProperty("profileId");
      expect
        .soft(findItem(offer.items, "auth:openai").details)
        .not.toHaveProperty("sourceCredentialFingerprint");
      nativeCredentialReaderStart.mockClear();
      ctx.includeSecrets = true;
      const plan = await provider.plan(ctx);
      expect(plan.items.map((item) => item.id)).toEqual(["auth:openai", "auth:openai:api-key"]);
      await writeAuth({
        ...auth,
        ...(changed === "api_key" ? { OPENAI_API_KEY: "fixture-changed-key" } : {}),
        ...(changed === "oauth"
          ? { tokens: { ...auth.tokens, refresh_token: "fixture-changed-refresh" } }
          : {}),
      });
      const result = await provider.apply(ctx, plan);

      expect(findItem(result.items, "auth:openai").status).toBe(
        changed === "oauth" ? "skipped" : "migrated",
      );
      const profiles = loadTargetAuthStore(fixture).profiles;
      if (changed === "oauth") {
        expect(profiles["openai:account-read-once-account"]).toBeUndefined();
      } else {
        expect(profiles["openai:account-read-once-account"]).toMatchObject({
          type: "oauth",
          refresh: "fixture-consented-refresh",
        });
      }
      expect(findItem(result.items, "auth:openai:api-key").status).toBe(
        changed === "api_key" ? "skipped" : "migrated",
      );
      if (changed === "api_key") {
        expect(profiles["openai:codex-import"]).toBeUndefined();
      } else {
        expect(profiles["openai:codex-import"]).toMatchObject({
          type: "api_key",
          key: "fixture-consented-key",
        });
      }
      expect(nativeCredentialReaderStart).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    "does not persist credentials after uncertain reader cleanup (exited=%s)",
    async (exited) => {
      const { ctx, plan } = await selectedApiKeyImport("fixture-selected-key");
      closeCredentialReader.mockResolvedValue({ exited, cleanup: "uncertain" });

      await expect(provider.apply(ctx, plan)).rejects.toThrow(
        "The Codex credential reader could not stop. No credential was imported.",
      );

      expect(loadTargetAuthStore(fixture).profiles["openai:codex-import"]).toBeUndefined();
    },
  );

  it("does not persist a cancelled selected import", async () => {
    const { ctx, plan } = await selectedApiKeyImport("fixture-first-key");
    ctx.signal = AbortSignal.abort(new Error("Sign-in cancelled"));
    await expect(provider.apply(ctx, plan)).rejects.toThrow("Sign-in cancelled");
    expect(loadTargetAuthStore(fixture).profiles["openai:codex-import"]).toBeUndefined();
  });

  it.each(["keyring", "ephemeral"])(
    "does not borrow a file key when native requirements select %s storage",
    async (mode) => {
      await writeAuth({
        auth_mode: "apikey",
        OPENAI_API_KEY: "fixture-stale-file-key",
      });
      credentialStorage.requiredMode = mode;

      expect(
        (
          await readCodexCliCredentialsAsync({
            codexHome: fixture.codexHome,
            credentialKind: "api_key",
            allowKeychainPrompt: true,
          })
        )?.apiKey,
      ).toBeUndefined();
    },
  );

  it.each([false, true])(
    "preserves legacy OAuth without importing an unproven API key (account lookup fails=%s)",
    async (accountReadFails) => {
      const access = fakeJwt({ exp: 2_000_000_000 });
      await writeAuth({
        OPENAI_API_KEY: "fixture-inactive-key",
        tokens: { access_token: access, refresh_token: "fixture-legacy-refresh" },
      });
      credentialStorage.accountType = "chatgpt";
      credentialStorage.accountReadFails = accountReadFails;
      const credentials = await readCodexCliCredentialsAsync({
        codexHome: fixture.codexHome,
        allowKeychainPrompt: true,
      });

      expect(credentials?.apiKey).toBeUndefined();
      expect(credentials?.oauth).toMatchObject({ access, refresh: "fixture-legacy-refresh" });
      expect(nativeCredentialReaderStart).toHaveBeenCalledTimes(1);
    },
  );

  it("imports auth into the selected agent directory under the effective OpenClaw home", async () => {
    const effectiveHome = path.join(fixture.root, "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", effectiveHome);
    await writeAuth({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-selected-agent-key" });
    const config: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
          model: { primary: "other/model" },
          models: { "other/model": {} },
        },
        list: [{ id: "research", agentDir: "~/research-agent" }],
      },
    };
    const before = structuredClone(config);
    const ctx = importContext({
      config,
      targetAgentId: "research",
      itemKinds: ["auth"],
      providerOptions: { credentialKind: "api_key", configPatchMode: "none" },
    });
    const plan = await provider.plan(ctx);
    expect(plan.items.map(({ id }) => id)).toEqual(["auth:openai:api-key"]);
    const result = await provider.apply(ctx, plan);
    expect(config).toEqual(before);

    expectRecordFields(findItem(result.items, "auth:openai:api-key"), { status: "migrated" });
    expect(
      loadAuthProfileStoreForSecretsRuntime(path.join(effectiveHome, "research-agent")).profiles[
        "openai:codex-import"
      ],
    ).toMatchObject({ type: "api_key", provider: "openai", key: "fixture-selected-agent-key" });
    await expect(fs.access(path.join(fixture.homeDir, "research-agent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports Codex OAuth config auth profile conflicts during planning", async () => {
    const { configState, ctx } = await createOAuthImport("acct_conflict");
    configState.auth = {
      profiles: { "openai:account-acct_conflict": { provider: "openai", mode: "api_key" } },
    };
    const plan = await provider.plan(ctx);

    expect(findItem(plan.items, "auth:openai")).toMatchObject({
      status: "conflict",
      reason: "auth profile exists",
      details: { profileId: "openai:account-acct_conflict" },
    });
  });

  it("reports late-created Codex API key config auth profile conflicts before writing", async () => {
    const reportDir = path.join(fixture.root, "report");
    await writeAuth({ OPENAI_API_KEY: "sk-codex" });
    const configState: MigrationProviderContext["config"] = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    };
    const ctx = importContext({
      config: configState,
      runtime: createConfigRuntime(configState),
      reportDir,
    });
    const plan = await provider.plan(ctx);
    configState.auth = {
      profiles: {
        "openai:codex-import": {
          provider: "anthropic",
          mode: "api_key",
        },
      },
    };

    const result = await provider.apply(ctx, plan);

    expect(findItem(result.items, "auth:openai:api-key")).toMatchObject({
      status: "conflict",
      reason: "auth profile exists",
    });
    expect(loadTargetAuthStore(fixture).profiles["openai:codex-import"]).toBeUndefined();
  });

  it("skips Codex OAuth import when the source account changes after planning", async () => {
    const { configState, ctx } = await createOAuthImport("acct_planned", "planned@example.test");
    const changedAccessToken = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_changed" },
      "https://api.openai.com/profile": { email: "changed@example.test" },
    });
    const plan = await provider.plan(ctx);
    expect(findItem(plan.items, "auth:openai").details).toMatchObject({
      profileId: "openai:account-acct_planned",
      sourceProfileId: "openai:account-acct_planned",
    });
    await writeAuth({
      auth_mode: "chatgpt",
      tokens: {
        access_token: changedAccessToken,
        refresh_token: "refresh-changed-token",
        account_id: "acct_changed",
      },
    });

    const result = await provider.apply(ctx, plan);

    expect(findItem(result.items, "auth:openai")).toMatchObject({
      status: "skipped",
      reason: "auth credential no longer present",
    });
    const authStore = loadTargetAuthStore(fixture);
    expect(authStore.profiles["openai:account-acct_planned"]).toBeUndefined();
    expect(authStore.profiles["openai:account-acct_changed"]).toBeUndefined();
    expect(configState.auth).toBeUndefined();
  });

  it("does not collapse Codex OAuth accounts that share an email", async () => {
    const sharedEmail = "shared@example.com";
    const { accessToken, ctx } = await createOAuthImport("acct_new", sharedEmail);
    upsertAuthProfile({
      agentDir: targetAgentDir(fixture),
      profileId: "openai:account-acct_old",
      credential: {
        type: "oauth",
        provider: "openai",
        access: "old-access-token",
        refresh: "old-refresh-token",
        expires: Date.now() + 60_000,
        accountId: "acct_old",
        email: sharedEmail,
      },
    });
    const plan = await provider.plan(ctx);
    expect(findItem(plan.items, "auth:openai").status).toBe("planned");
    expect(findItem(plan.items, "auth:openai").details).toMatchObject({
      profileId: "openai:account-acct_new",
    });

    const result = await provider.apply(ctx, plan);

    expectRecordFields(findItem(result.items, "auth:openai"), { status: "migrated" });
    const authStore = loadTargetAuthStore(fixture);
    expect(authStore.profiles?.["openai:account-acct_old"]).toMatchObject({
      access: "old-access-token",
      accountId: "acct_old",
      email: sharedEmail,
    });
    expect(authStore.profiles?.["openai:account-acct_new"]).toMatchObject({
      access: accessToken,
      accountId: "acct_new",
      email: sharedEmail,
    });
  });

  it("reports Codex auth import when config update fails after profile write", async () => {
    const { accessToken, configState, ctx } = await createOAuthImport("acct_test");
    ctx.runtime = createFailingConfigRuntime(configState);
    const plan = await provider.plan(ctx);

    const result = await provider.apply(ctx, plan);

    expectRecordFields(findItem(result.items, "auth:openai"), { status: "migrated" });
    expect(findItem(result.items, "auth:openai").details).toMatchObject({
      configUpdated: false,
    });
    const authStore = loadTargetAuthStore(fixture);
    expect(authStore.profiles?.["openai:account-acct_test"]).toMatchObject({
      type: "oauth",
      provider: "openai",
      access: accessToken,
    });
  });
});

describe("Codex migration auth identity and inherited profiles", () => {
  it("does not reuse another user's OAuth profile in the same ChatGPT workspace", async () => {
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
    await writeOAuth(jwt("new-user"), "shared-workspace", "new-refresh");
    const ctx = authContext();
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
        nativeToken("same-account", "same-user"),
        "same-account",
        "new-native-refresh",
      );
      const ctx = authContext({
        agents: { defaults: { model: "other/retained", workspace: fixture.workspaceDir } },
      });
      const configBefore = structuredClone(ctx.config);
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
    vi.stubEnv("CODEX_HOME", fixture.codexHome);
    credentialStorage.accountType = "chatgpt";
    const access = nativeToken();
    const nativeAuth = await writeOAuth(access);
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
    const ctx = authContext(config);

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
      await writeOAuth(access);
      const ctx = authContext(legacyConfig());
      const before = structuredClone(ctx.config);

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
    const { ctx, plan } = await legacyImport();
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

  it.each([
    {
      state: "different account",
      accountId: "shared-account",
      userId: "shared-user",
      expires: 2_100_000_000_000,
      status: "conflict",
    },
    {
      state: "usable matching account",
      accountId: "native-account",
      userId: "native-user",
      expires: 2_100_000_000_000,
      status: "migrated",
    },
    {
      state: "expired matching account",
      accountId: "native-account",
      userId: "native-user",
      expires: 1_000,
      status: "skipped",
    },
  ])(
    "rechecks inherited OAuth after planning: $state",
    async ({ accountId, userId, expires, status }) => {
      const { nativeAuth, ctx, configBefore, plan } = await legacyImport();
      expect(findItem(plan.items, "auth:openai")).toMatchObject({
        status: "planned",
        details: { profileId: "openai:default" },
      });
      const inherited = oauthProfile(nativeToken(accountId, userId), "shared-refresh", expires);
      upsertAuthProfile({ profileId: "openai:default", credential: inherited });

      const result = await provider.apply(ctx, plan);

      expect(findItem(result.items, "auth:openai").status).toBe(status);
      await expectNoLocalProfiles();
      clearRuntimeAuthProfileStoreSnapshots();
      expect(loadTargetAuthStore(fixture).profiles).toEqual({ "openai:default": inherited });
      expect(loadAuthProfileStoreForSecretsRuntime().profiles).toEqual({
        "openai:default": inherited,
      });
      expect(ctx.config).toEqual(configBefore);
      expect(await fs.readFile(path.join(fixture.codexHome, "auth.json"), "utf8")).toBe(nativeAuth);
    },
  );
});
