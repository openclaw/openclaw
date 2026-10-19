// Register native mocks before migration modules load.
// oxfmt-ignore
import {
  closeCredentialReader,
  nativeCredentialReaderStart,
  credentialStorage,
  createCodexFixture,
  createConfigRuntime,
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
  upsertAuthProfileAsync,
  type OAuthCredential,
} from "openclaw/plugin-sdk/provider-auth";
import { beforeEach, expect, it, vi } from "vitest";
import { readCodexCliCredentialsAsync } from "./cli-credentials.js";
import { buildCodexMigrationProvider } from "./provider.js";

type CodexFixture = Awaited<ReturnType<typeof createCodexFixture>>;
let fixture: CodexFixture;
let provider: ReturnType<typeof buildCodexMigrationProvider>;
beforeEach(async () => {
  fixture = await createCodexFixture();
  provider = buildCodexMigrationProvider();
});

function importContext(options: Partial<MigrationProviderContext> = {}) {
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
  await writeOAuth(accessToken, accountId, "fixture-refresh");
  const ctx = importContext({ reportDir: path.join(fixture.root, "report") });
  ctx.runtime = createConfigRuntime(ctx.config);
  return { accessToken, configState: ctx.config, ctx };
}

function authContext(config?: MigrationProviderContext["config"], credentialKind = "oauth") {
  return importContext({
    itemKinds: ["auth"],
    providerOptions: { credentialKind, configPatchMode: "none" },
    config,
  });
}

function readCredentials(credentialKind?: "api_key" | "oauth") {
  return readCodexCliCredentialsAsync({
    codexHome: fixture.codexHome,
    allowKeychainPrompt: true,
    credentialKind,
  });
}

function nativeToken(accountId = "native-account", userId = "native-user", exp = 2_100_000_000) {
  return fakeJwt({
    exp,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_user_id: userId },
  });
}

async function writeOAuth(access: string, id = "native-account", refresh = "native-refresh") {
  const auth = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: access, refresh_token: refresh, account_id: id },
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

function oauthProfile(access: string, refresh: string, exp = 2_100_000_000_000): OAuthCredential {
  return { type: "oauth", provider: "openai", access, refresh, expires: exp };
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

function seedLocalProfile(profileId: string, credential: OAuthCredential) {
  return upsertAuthProfileAsync({ profileId, credential, agentDir: targetAgentDir(fixture) });
}

function localProfiles() {
  return loadTargetAuthStore(fixture).profiles;
}

type AuthResult = { items: readonly { id?: string }[] };

function authItem(result: AuthResult, id = "auth:openai") {
  return findItem(result.items, id);
}

function expectAuth(result: AuthResult, status: string, details: Record<string, unknown>) {
  expect(authItem(result)).toMatchObject({ status, details });
}

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
  expect(localProfiles()).toEqual({});
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
    expect.soft(offer.items.map((item) => item.id)).toEqual(["auth:openai", "auth:openai:api-key"]);
    for (const item of offer.items) {
      expect.soft(item.reason).toBeUndefined();
      expect.soft(item.message).toContain("Codex credentials have not been inspected.");
      expect.soft(item.message).toContain("Confirm credential import");
    }
    const offeredAuth = authItem(offer);
    expect.soft(offeredAuth).toMatchObject({ kind: "auth", status: "skipped", sensitive: true });
    expect.soft(offeredAuth.details).not.toHaveProperty("profileId");
    expect.soft(offeredAuth.details).not.toHaveProperty("sourceCredentialFingerprint");
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
    expect(authItem(result).status).toBe(changed === "oauth" ? "skipped" : "migrated");
    expect(authItem(result, "auth:openai:api-key").status).toBe(
      changed === "api_key" ? "skipped" : "migrated",
    );
    const profiles = localProfiles();
    expect(profiles["openai:account-read-once-account"]).toEqual(
      changed === "oauth"
        ? undefined
        : expect.objectContaining({ type: "oauth", refresh: "fixture-consented-refresh" }),
    );
    expect(profiles["openai:codex-import"]).toEqual(
      changed === "api_key"
        ? undefined
        : expect.objectContaining({ type: "api_key", key: "fixture-consented-key" }),
    );
    expect(nativeCredentialReaderStart).toHaveBeenCalledTimes(2);
  },
);

it.each([false, true, "cancelled"] as const)(
  "does not persist a selected import after failed cleanup or cancellation (%s)",
  async (failure) => {
    await writeAuth({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-selected-key" });
    const ctx = authContext(undefined, "api_key");
    const plan = await provider.plan(ctx);
    const cancelled = failure === "cancelled";
    if (cancelled) {
      ctx.signal = AbortSignal.abort(new Error("Sign-in cancelled"));
    } else {
      closeCredentialReader.mockResolvedValue({ exited: failure, cleanup: "uncertain" });
    }
    await expect(provider.apply(ctx, plan)).rejects.toThrow(
      cancelled
        ? "Sign-in cancelled"
        : "The Codex credential reader could not stop. No credential was imported.",
    );
    expect(localProfiles()["openai:codex-import"]).toBeUndefined();
  },
);

it.each(["keyring", "ephemeral"])(
  "does not borrow a file key when native requirements select %s storage",
  async (mode) => {
    await writeAuth({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-stale-file-key" });
    credentialStorage.requiredMode = mode;
    const credentials = await readCredentials("api_key");
    expect(credentials?.apiKey).toBeUndefined();
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
    const credentials = await readCredentials();
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
      entries: { research: { agentDir: "~/research-agent" } },
    },
  };
  const before = structuredClone(config);
  const ctx = { ...authContext(config, "api_key"), targetAgentId: "research" };
  const plan = await provider.plan(ctx);
  expect(plan.items.map(({ id }) => id)).toEqual(["auth:openai:api-key"]);
  const result = await provider.apply(ctx, plan);
  expect(config).toEqual(before);
  expect(authItem(result, "auth:openai:api-key")).toMatchObject({ status: "migrated" });
  expect(
    loadAuthProfileStoreForSecretsRuntime(path.join(effectiveHome, "research-agent")).profiles[
      "openai:codex-import"
    ],
  ).toMatchObject({ type: "api_key", provider: "openai", key: "fixture-selected-agent-key" });
  await expect(fs.access(path.join(fixture.homeDir, "research-agent"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["oauth", "api_key"])("reports %s config auth profile conflicts", async (kind) => {
  const { configState, ctx } = await createOAuthImport("acct_conflict");
  const oauth = kind === "oauth";
  const profileId = oauth ? "openai:account-acct_conflict" : "openai:codex-import";
  const conflict = {
    profiles: {
      [profileId]: { provider: oauth ? "openai" : "anthropic", mode: "api_key" as const },
    },
  };
  if (oauth) {
    configState.auth = conflict;
  } else {
    await writeAuth({ OPENAI_API_KEY: "sk-codex" });
  }
  const plan = await provider.plan(ctx);
  if (!oauth) {
    configState.auth = conflict;
  }
  const result = oauth ? plan : await provider.apply(ctx, plan);
  expect(authItem(result, oauth ? "auth:openai" : "auth:openai:api-key")).toMatchObject({
    status: "conflict",
    reason: "auth profile exists",
    details: { profileId },
  });
  expect(localProfiles()[profileId]).toBeUndefined();
});

it("skips Codex OAuth import when the source account changes after planning", async () => {
  const { configState, ctx } = await createOAuthImport("acct_planned", "planned@example.test");
  const changedAccessToken = fakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_changed" },
    "https://api.openai.com/profile": { email: "changed@example.test" },
  });
  const plan = await provider.plan(ctx);
  expect(authItem(plan).details).toMatchObject({
    profileId: "openai:account-acct_planned",
    sourceProfileId: "openai:account-acct_planned",
  });
  await writeOAuth(changedAccessToken, "acct_changed", "refresh-changed-token");
  const result = await provider.apply(ctx, plan);
  expect(authItem(result)).toMatchObject({
    status: "skipped",
    reason: "auth credential no longer present",
  });
  expect(localProfiles()["openai:account-acct_planned"]).toBeUndefined();
  expect(localProfiles()["openai:account-acct_changed"]).toBeUndefined();
  expect(configState.auth).toBeUndefined();
});

it("does not collapse Codex OAuth accounts that share an email", async () => {
  const sharedEmail = "shared@example.com";
  const { accessToken, ctx } = await createOAuthImport("acct_new", sharedEmail);
  await seedLocalProfile("openai:account-acct_old", {
    ...oauthProfile("old-access-token", "old-refresh-token", Date.now() + 60_000),
    accountId: "acct_old",
    email: sharedEmail,
  });
  const plan = await provider.plan(ctx);
  expectAuth(plan, "planned", { profileId: "openai:account-acct_new" });
  const result = await provider.apply(ctx, plan);
  expect(authItem(result)).toMatchObject({ status: "migrated" });
  expect(localProfiles()["openai:account-acct_old"]).toMatchObject({
    access: "old-access-token",
    accountId: "acct_old",
    email: sharedEmail,
  });
  expect(localProfiles()["openai:account-acct_new"]).toMatchObject({
    access: accessToken,
    accountId: "acct_new",
    email: sharedEmail,
  });
});

it("reports Codex auth import when config update fails after profile write", async () => {
  const { accessToken, configState, ctx } = await createOAuthImport("acct_test");
  ctx.runtime = createConfigRuntime(configState, new Error("config write failed"));
  const result = await provider.apply(ctx, await provider.plan(ctx));
  expectAuth(result, "migrated", { configUpdated: false });
  expect(localProfiles()["openai:account-acct_test"]).toMatchObject({
    type: "oauth",
    provider: "openai",
    access: accessToken,
  });
});

it.each(["another user in the same workspace", "an expired same-account local profile"])(
  "preserves %s",
  async (scenario) => {
    const expired = scenario === "an expired same-account local profile";
    const accountId = expired ? "same-account" : "shared-workspace";
    const previousUser = expired ? "same-user" : "previous-user";
    const user = expired ? "same-user" : "new-user";
    const profileId = expired ? "openai:existing-account" : "openai:account-shared-workspace";
    const expires = expired ? 1_899_999_999_999 : 2_000_000_000_000;
    const status = expired ? "skipped" : "conflict";
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
    try {
      credentialStorage.accountType = "chatgpt";
      const access = nativeToken(accountId, previousUser, expires / 1000);
      const existing = { ...oauthProfile(access, "old-refresh", expires), accountId };
      const unrelated = { type: "api_key" as const, provider: "other", key: "unrelated-key" };
      const profiles = { [profileId]: existing, "other:retained": unrelated };
      const seeded = await updateAuthProfileStoreWithLock({
        agentDir: targetAgentDir(fixture),
        stateDir: fixture.stateDir,
        updater(store) {
          Object.assign(store.profiles, profiles);
          return true;
        },
      });
      expect(seeded?.profiles).toEqual(profiles);
      await writeOAuth(nativeToken(accountId, user), accountId, "new-native-refresh");
      const ctx = authContext({
        agents: { defaults: { model: "other/retained", workspace: fixture.workspaceDir } },
      });
      const configBefore = structuredClone(ctx.config);
      const plan = await provider.plan(ctx);
      expect(authItem(plan).status).toBe(status);
      if (status === "skipped") {
        expect(authItem(plan)).toMatchObject({
          reason: "existing OAuth profile requires sign-in",
          details: { credentialImportUnavailable: true },
        });
      }
      const result = await provider.apply(ctx, plan);
      expect(authItem(result).status).toBe(status);
      expect(localProfiles()).toEqual(profiles);
      expect(ctx.config).toEqual(configBefore);
    } finally {
      clock.mockRestore();
    }
  },
);

it("preserves the configured CLI-backed profile during explicit import with an agent home", async () => {
  vi.stubEnv("CODEX_HOME", fixture.codexHome);
  credentialStorage.accountType = "chatgpt";
  const access = nativeToken();
  const nativeAuth = await writeOAuth(access);
  const config: MigrationProviderContext["config"] = {
    agents: {
      defaults: { workspace: fixture.workspaceDir, model: "openai/gpt-5.4@openai:default" },
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
  expectAuth(result, "migrated", { profileId: "openai:default" });
  expect(localProfiles()).toEqual({
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
  expectAuth(repeated, "migrated", { profileId: "openai:default", wroteAuthProfile: false });
});

it.each(["other source home", "missing user"])(
  "keeps the account-scoped import identity for %s",
  async (scenario) => {
    vi.stubEnv(
      "CODEX_HOME",
      scenario === "other source home" ? path.join(fixture.root, "other-codex") : fixture.codexHome,
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
    expectAuth(result, "migrated", { profileId: "openai:account-native-account" });
    expect(localProfiles()["openai:default"]).toBeUndefined();
    expect(ctx.config).toEqual(before);
  },
);

it("does not fill the legacy pin after another account is imported during planning", async () => {
  const { ctx, plan } = await legacyImport();
  expectAuth(plan, "planned", { profileId: "openai:default" });
  const managed = oauthProfile("managed-access", "managed-refresh");
  await seedLocalProfile("openai:managed", managed);
  const result = await provider.apply(ctx, plan);
  expect(authItem(result).status).toBe("conflict");
  expect(localProfiles()).toEqual({ "openai:managed": managed });
});

it.each([
  ["different account", "shared-account", "shared-user", 2_100_000_000_000, "conflict"],
  ["usable matching account", "native-account", "native-user", 2_100_000_000_000, "migrated"],
  ["expired matching account", "native-account", "native-user", 1_000, "skipped"],
] as const)(
  "rechecks inherited OAuth after planning: %s",
  async (_state, accountId, userId, expires, status) => {
    const { nativeAuth, ctx, configBefore, plan } = await legacyImport();
    expectAuth(plan, "planned", { profileId: "openai:default" });
    const inherited = oauthProfile(nativeToken(accountId, userId), "shared-refresh", expires);
    await upsertAuthProfileAsync({ profileId: "openai:default", credential: inherited });
    const result = await provider.apply(ctx, plan);
    expect(authItem(result).status).toBe(status);
    await updateAuthProfileStoreWithLock({
      agentDir: targetAgentDir(fixture),
      stateDir: fixture.stateDir,
      updater: (localStore) => {
        expect(localStore.profiles).toEqual({});
        return false;
      },
    });
    clearRuntimeAuthProfileStoreSnapshots();
    expect(localProfiles()).toEqual({ "openai:default": inherited });
    expect(loadAuthProfileStoreForSecretsRuntime().profiles).toEqual({
      "openai:default": inherited,
    });
    expect(ctx.config).toEqual(configBefore);
    expect(await fs.readFile(path.join(fixture.codexHome, "auth.json"), "utf8")).toBe(nativeAuth);
  },
);
