// Migrate Hermes tests cover secrets plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAuthStorePathForDisplay } from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import {
  HERMES_REASON_AUTH_PROFILE_EXISTS,
  HERMES_REASON_SECRET_NO_LONGER_PRESENT,
} from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { fakeJwt, readAuthProfileStore, writeAuthProfileStore } from "./test/auth-helpers.js";
import { useHermesFixture, writeJson } from "./test/migration-fixture.js";
import {
  makeConfigRuntime,
  makeHermesPaths,
  makeContext as makeProviderContext,
  writeFile,
} from "./test/provider-helpers.js";

const fixture = useHermesFixture(async (root) => {
  vi.unstubAllEnvs();
  await closeOpenClawAgentDatabasesAsync(root);
  await closeOpenClawStateDatabaseAsync();
});

async function expectMissingPath(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

function authProfileTarget(agentDir: string, profileId: string): string {
  return `${resolveAuthStorePathForDisplay(agentDir)}#${profileId}`;
}

const HERMES_ACCESS_FIELD = ["access", "token"].join("_");
const HERMES_REFRESH_FIELD = ["refresh", "token"].join("_");

function expectItems(items: MigrationItem[], ...expected: Array<Partial<MigrationItem>>) {
  expect(items).toEqual(
    expect.arrayContaining(expected.map((item) => expect.objectContaining(item))),
  );
}

function poolKey(id: string, value: string, source = "manual") {
  return { id, auth_type: "api_key", source, [HERMES_ACCESS_FIELD]: value };
}

function openAiOAuth(access: string, refresh: string, extra: Record<string, unknown> = {}) {
  return { openai: { type: "oauth", access, refresh, ...extra } };
}

async function makeHermesSecretFixture(sourceName = "hermes") {
  const { root, source, workspaceDir, stateDir, reportDir, agentDir } = makeHermesPaths(
    fixture.paths.root,
    sourceName,
  );
  const config = { agents: { defaults: { workspace: workspaceDir } } } as OpenClawConfig;
  const runtime = makeConfigRuntime(config);
  const provider = buildHermesMigrationProvider();
  const secretContext = (overrides: Partial<Parameters<typeof makeProviderContext>[0]> = {}) =>
    makeProviderContext({ source, stateDir, workspaceDir, includeSecrets: true, ...overrides });
  const openCodeAuth = (value: unknown) =>
    writeJson(path.join(root, ".local", "share", "opencode", "auth.json"), value);
  return {
    root,
    source,
    workspaceDir,
    stateDir,
    reportDir,
    agentDir,
    config,
    runtime,
    provider,
    secretContext,
    openCodeAuth,
  };
}

describe("Hermes migration secret items", () => {
  it("uses configured agentDir for secret planning and imports without runtime helpers", async () => {
    const { root, source, workspaceDir, stateDir, secretContext, provider } =
      await makeHermesSecretFixture();
    const customAgentDir = path.join(root, "custom-agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const config = {
      agents: {
        defaults: { workspace: workspaceDir },
        entries: { custom: { agentDir: customAgentDir } },
      },
    } as OpenClawConfig;
    const plan = await provider.plan(secretContext({ config }));

    expect(plan.metadata?.agentDir).toBe(customAgentDir);
    expect(plan.items).toEqual([
      {
        id: "secret:openai",
        kind: "secret",
        action: "create",
        source: path.join(source, ".env"),
        target: authProfileTarget(customAgentDir, "openai:hermes-import"),
        status: "planned",
        sensitive: true,
        details: {
          envVar: "OPENAI_API_KEY",
          provider: "openai",
          profileId: "openai:hermes-import",
        },
      },
    ]);

    const result = await provider.apply(
      secretContext({ config, overwrite: true, reportDir: path.join(root, "report") }),
    );

    expect(result.summary.errors).toBe(0);
    const authStore = readAuthProfileStore(customAgentDir);
    expect(authStore.profiles?.["openai:hermes-import"]).toEqual({
      type: "api_key",
      provider: "openai",
      key: "sk-hermes",
      displayName: "Hermes import",
    });
    await expectMissingPath(path.join(stateDir, "agents", "custom", "agent", "auth-profiles.json"));
  });

  it("parses current Hermes dotenv syntax and legacy Kimi credentials", async () => {
    const { source, secretContext } = await makeHermesSecretFixture();
    const kimiEnv = ["KIMI", "CODING", "API", "KEY"].join("_");
    const openaiEnv = ["OPENAI", "API", "KEY"].join("_");
    await writeFile(
      path.join(source, ".env"),
      `\uFEFFexport ${kimiEnv} = placeholder\nexport ${openaiEnv}='redacted'\n`,
    );
    const plan = await buildHermesMigrationProvider().plan(secretContext());
    expectItems(
      plan.items,
      {
        kind: "secret",
        details: expect.objectContaining({ provider: "moonshot" }),
      },
      {
        kind: "secret",
        details: expect.objectContaining({ provider: "openai" }),
      },
    );
  });

  it("keeps legacy Moonshot model routing and credentials aligned", async () => {
    const { source, secretContext } = await makeHermesSecretFixture();
    const envVar = ["MOONSHOT", "API", "KEY"].join("_");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: moonshot\n  default: kimi-k2.5\n",
    );
    await writeFile(path.join(source, ".env"), `${envVar}=placeholder\n`);

    const plan = await buildHermesMigrationProvider().plan(secretContext());

    expect(plan.items.find((item) => item.id === "config:default-model")?.details?.model).toBe(
      "moonshot/kimi-k2.5",
    );
    expectItems(plan.items, {
      kind: "secret",
      details: expect.objectContaining({ envVar, provider: "moonshot" }),
    });
  });

  it.each([["sk-kimi-placeholder", "kimi"]])(
    "aligns KIMI_API_KEY with its effective %s route",
    async (apiKey, expectedProvider) => {
      const { source, secretContext } = await makeHermesSecretFixture(expectedProvider);
      const envVar = ["KIMI", "API", "KEY"].join("_");
      await writeFile(
        path.join(source, "config.yaml"),
        "model:\n  provider: kimi-coding\n  default: kimi-k2.5\n",
      );
      await writeFile(path.join(source, ".env"), `${envVar}=${apiKey}\n`);

      const plan = await buildHermesMigrationProvider().plan(secretContext());

      expect(plan.items.find((item) => item.id === "config:default-model")?.details?.model).toBe(
        `${expectedProvider}/kimi-k2.5`,
      );
      expectItems(plan.items, {
        kind: "secret",
        details: expect.objectContaining({ envVar, provider: expectedProvider }),
      });
    },
  );

  it("imports a configured provider key_env as matching OpenClaw provider auth", async () => {
    const { source, stateDir, secretContext, config, runtime } = await makeHermesSecretFixture();
    const value = ["custom", "provider", "placeholder"].join("-");
    const envVar = ["ACME", "TOKEN"].join("_");
    await writeJson(path.join(source, "config.yaml"), {
      model: { provider: "acme", default: "acme-chat" },
      providers: {
        acme: { api: "https://api.acme.example/v1", key_env: envVar, models: ["acme-chat"] },
      },
    });
    await writeFile(path.join(source, ".env"), `${envVar}=${value}\n`);
    const result = await buildHermesMigrationProvider({ runtime }).apply(
      secretContext({ config, runtime, overwrite: true }),
    );

    expect(result.summary.errors).toBe(0);
    expectItems(result.items, {
      details: expect.objectContaining({ envVar, provider: "acme" }),
      status: "migrated",
    });
    const store = readAuthProfileStore(path.join(stateDir, "agents", "main", "agent"));
    const profile = store.profiles["acme:hermes-import"];
    expect(profile).toEqual(expect.objectContaining({ provider: "acme", type: "api_key" }));
    if (!profile || profile.type !== "api_key") {
      throw new Error("expected imported API key profile");
    }
    expect(profile.key).toBe(value);
    expect(config.models?.providers?.acme?.apiKey).toBeUndefined();
    expect(config.auth?.profiles?.["acme:hermes-import"]).toMatchObject({
      mode: "api_key",
      provider: "acme",
    });
  });

  it("binds the host-gated OpenAI key fallback to a model-scoped endpoint", async () => {
    const { source, secretContext } = await makeHermesSecretFixture();
    const envVar = ["OPENAI", "API", "KEY"].join("_");
    await writeJson(path.join(source, "config.yaml"), {
      model: { provider: "custom", default: "gpt-5.6", base_url: "https://api.openai.com/v1" },
    });
    await writeFile(path.join(source, ".env"), `${envVar}=placeholder\n`);

    const plan = await buildHermesMigrationProvider().plan(secretContext());

    const secretItems = plan.items.filter((item) => item.kind === "secret");
    expect(secretItems).toHaveLength(1);
    expect(secretItems[0]?.details).toMatchObject({ envVar, provider: "custom" });
  });

  it("keeps an env-backed custom endpoint and its OpenAI key on one provider", async () => {
    const { source, secretContext } = await makeHermesSecretFixture();
    const keyEnv = ["OPENAI", "API", "KEY"].join("_");
    const baseUrlEnv = ["OPENAI", "BASE", "URL"].join("_");
    await writeFile(
      path.join(source, "config.yaml"),
      "model: {provider: custom, default: private-model}\n",
    );
    await writeFile(
      path.join(source, ".env"),
      `${keyEnv}=placeholder\n${baseUrlEnv}=https://private.example.test/v1\n`,
    );

    const plan = await buildHermesMigrationProvider().plan(secretContext());

    const providers = Object.assign(
      {},
      ...plan.items
        .filter((item) => item.id.startsWith("config:model-provider:"))
        .map((item) => item.details?.value),
    ) as Record<string, { baseUrl?: string }>;
    expect(providers?.custom?.baseUrl).toBe("https://private.example.test/v1");
    const secretItems = plan.items.filter((item) => item.kind === "secret");
    expect(secretItems).toHaveLength(1);
    expect(secretItems[0]?.details).toMatchObject({ envVar: keyEnv, provider: "custom" });
  });

  it("imports current Hermes singleton and pooled OpenAI OAuth accounts", async () => {
    const { source, stateDir, secretContext, config, runtime } = await makeHermesSecretFixture();
    const accountOne = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_one" },
      "https://api.openai.com/profile": { email: "one@example.test" },
    });
    const accountTwo = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_two" },
      "https://api.openai.com/profile": { email: "two@example.test" },
    });
    await writeJson(path.join(source, "auth.json"), {
      providers: {
        "openai-codex": {
          tokens: { [HERMES_ACCESS_FIELD]: accountOne, [HERMES_REFRESH_FIELD]: "refresh-one" },
          last_refresh: "2026-07-13T10:00:00Z",
        },
      },
      credential_pool: {
        "openai-codex": [
          {
            [HERMES_ACCESS_FIELD]: accountOne,
            [HERMES_REFRESH_FIELD]: "refresh-one",
            last_refresh: "2026-07-13T09:00:00Z",
          },
          {
            [HERMES_ACCESS_FIELD]: accountTwo,
            [HERMES_REFRESH_FIELD]: "refresh-two",
            last_refresh: "2026-07-13T08:00:00Z",
          },
        ],
      },
    });
    const provider = buildHermesMigrationProvider({ runtime });
    const ctx = secretContext({ config, runtime, overwrite: true });
    const plan = await provider.plan(ctx);
    const plannedAuth = plan.items.filter((item) => item.kind === "auth");
    expect(plannedAuth).toHaveLength(2);
    for (const item of plannedAuth) {
      expect(item).toMatchObject({
        status: "planned",
        sensitive: true,
        details: { provider: "openai", sourceKind: "hermes-auth-json" },
      });
    }
    expect(plan.warnings).toContain(
      "Hermes and OpenClaw must not keep using the same imported OpenAI OAuth refresh grant after migration; reauthenticate one side before running both.",
    );
    const result = await provider.apply(ctx, plan);
    const authItems = result.items.filter((item) => item.kind === "auth");
    expect(authItems).toHaveLength(2);
    expect(authItems.every((item) => item.status === "migrated")).toBe(true);
    const store = readAuthProfileStore(path.join(stateDir, "agents", "main", "agent"));
    expect(store.profiles).toMatchObject({
      "openai:account-acct_one": { provider: "openai", refresh: "refresh-one" },
      "openai:account-acct_two": { provider: "openai", refresh: "refresh-two" },
    });
  });

  it("imports manual Hermes API-key pool entries and skips borrowed references", async () => {
    const { source, stateDir, secretContext, config, runtime } = await makeHermesSecretFixture();
    const firstValue = "openrouter-one";
    const secondValue = "openrouter-two";
    const borrowedValue = "borrowed-value";
    const geminiValue = "gemini-value";
    await writeJson(path.join(source, "auth.json"), {
      credential_pool: {
        openrouter: [
          poolKey("key-one", firstValue),
          poolKey("key-two", secondValue),
          poolKey("borrowed", borrowedValue, "env:OPENROUTER_API_KEY"),
        ],
        gemini: [poolKey("google-key", geminiValue)],
      },
    });
    const result = await buildHermesMigrationProvider({ runtime }).apply(
      secretContext({ config, runtime, overwrite: true }),
    );
    const secretItems = result.items.filter(
      (item) => item.kind === "secret" && item.details?.sourceKind === "hermes-auth-json",
    );
    expect(secretItems).toHaveLength(3);
    const store = readAuthProfileStore(path.join(stateDir, "agents", "main", "agent"));
    expect(store.profiles).toMatchObject({
      "openrouter:hermes-key-one": { type: "api_key", key: firstValue },
      "openrouter:hermes-key-two": { type: "api_key", key: secondValue },
      "google:hermes-google-key": { type: "api_key", key: geminiValue },
    });
    expect(store.profiles["openrouter:hermes-borrowed"]).toBeUndefined();
  });

  it("uses per-provider global API-key pool fallback for an active profile", async () => {
    const { root, secretContext, config, runtime } = await makeHermesSecretFixture();
    const hermesRoot = path.join(root, ".hermes");
    const source = path.join(hermesRoot, "profiles", "coder");
    const stateDir = path.join(root, "state");
    const globalOpenRouterValue = ["global", "openrouter", "placeholder"].join("-");
    const globalGeminiValue = ["global", "gemini", "placeholder"].join("-");
    const profileOpenRouterValue = ["profile", "openrouter", "placeholder"].join("-");
    await writeFile(path.join(hermesRoot, "active_profile"), "coder\n");
    await writeFile(path.join(source, "config.yaml"), "{}\n");
    await writeJson(path.join(hermesRoot, "auth.json"), {
      credential_pool: {
        openrouter: [poolKey("global-openrouter", globalOpenRouterValue)],
        gemini: [poolKey("global-gemini", globalGeminiValue)],
      },
    });
    await writeJson(path.join(source, "auth.json"), {
      credential_pool: { openrouter: [poolKey("profile-openrouter", profileOpenRouterValue)] },
    });
    vi.stubEnv("HOME", root);
    vi.stubEnv("HERMES_HOME", "");
    const result = await buildHermesMigrationProvider({ runtime }).apply(
      secretContext({ source: "", config, runtime, overwrite: true }),
    );

    expectItems(
      result.items,
      {
        source: path.join(source, "auth.json"),
        details: expect.objectContaining({ provider: "openrouter" }),
      },
      {
        source: path.join(hermesRoot, "auth.json"),
        details: expect.objectContaining({ provider: "google" }),
      },
    );
    const store = readAuthProfileStore(path.join(stateDir, "agents", "main", "agent"));
    expect(store.profiles["openrouter:hermes-profile-openrouter"]).toMatchObject({
      key: profileOpenRouterValue,
    });
    expect(store.profiles["openrouter:hermes-global-openrouter"]).toBeUndefined();
    expect(store.profiles["google:hermes-global-gemini"]).toMatchObject({ key: globalGeminiValue });
  });

  it("reports API key import when config update fails after profile write", async () => {
    const { source, config, secretContext, reportDir, agentDir, provider } =
      await makeHermesSecretFixture();
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const runtime = {
      config: {
        current: () => config,
        mutateConfigFile: async () => {
          throw new Error("config write failed");
        },
      },
    } as unknown as MigrationProviderContext["runtime"];
    const ctx = secretContext({ config, reportDir, runtime });
    const plan = await provider.plan(ctx);

    const result = await provider.apply(ctx, plan);

    const item = result.items.find((entry) => entry.id === "secret:openai");
    expect(item).toMatchObject({
      status: "migrated",
      details: expect.objectContaining({ configUpdated: false }),
    });
    const authStore = readAuthProfileStore(agentDir);
    expect(authStore.profiles?.["openai:hermes-import"]).toMatchObject({
      type: "api_key",
      provider: "openai",
      key: "sk-hermes",
    });
  });

  it("reports late-created auth profiles as conflicts without overwriting", async () => {
    const { source, secretContext, reportDir, agentDir, provider } =
      await makeHermesSecretFixture();
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const ctx = secretContext({ reportDir });
    const plan = await provider.plan(ctx);
    const plannedTarget = authProfileTarget(agentDir, "openai:hermes-import");
    writeAuthProfileStore(agentDir, {
      version: 1,
      profiles: { "openai:hermes-import": { type: "api_key", provider: "openai", key: "sk-late" } },
    });

    const result = await provider.apply(ctx, plan);

    expect(result.items).toEqual([
      {
        id: "secret:openai",
        kind: "secret",
        action: "create",
        source: path.join(source, ".env"),
        target: plannedTarget,
        status: "conflict",
        sensitive: true,
        reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
        details: {
          envVar: "OPENAI_API_KEY",
          provider: "openai",
          profileId: "openai:hermes-import",
        },
      },
    ]);
    expect(result.summary.conflicts).toBe(1);
    const authStore = readAuthProfileStore(agentDir);
    expect(authStore.profiles?.["openai:hermes-import"]).toMatchObject({
      type: "api_key",
      provider: "openai",
      key: "sk-late",
    });
  });

  it("reports API key config auth profile conflicts during planning", async () => {
    const { source, workspaceDir, secretContext, agentDir, provider } =
      await makeHermesSecretFixture();
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const config = {
      agents: { defaults: { workspace: workspaceDir } },
      auth: {
        profiles: { "openai:hermes-import": { provider: "anthropic", mode: "api_key" } },
      },
    } as OpenClawConfig;
    const ctx = secretContext({ config });
    const plan = await provider.plan(ctx);

    expect(plan.items).toEqual([
      expect.objectContaining({
        id: "secret:openai",
        status: "conflict",
        reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
      }),
    ]);

    const result = await provider.apply(ctx, plan);

    expect(result.summary.conflicts).toBe(1);
    await expectMissingPath(path.join(agentDir, "auth-profiles.json"));
  });

  it("reports late-created API key config auth profile conflicts before writing", async () => {
    const { source, config, secretContext, agentDir, provider } = await makeHermesSecretFixture();
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const ctx = secretContext({ config, runtime: makeConfigRuntime(config) });
    const plan = await provider.plan(ctx);
    config.auth = {
      profiles: { "openai:hermes-import": { provider: "anthropic", mode: "api_key" } },
    };

    const result = await provider.apply(ctx, plan);

    expect(result.items).toEqual([
      expect.objectContaining({
        id: "secret:openai",
        status: "conflict",
        reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
      }),
    ]);
    expect(result.summary.conflicts).toBe(1);
    await expectMissingPath(path.join(agentDir, "auth-profiles.json"));
  });

  it("imports supported OpenCode auth store credentials next to the Hermes home", async () => {
    const { root, source, config, secretContext, reportDir, agentDir, provider, openCodeAuth } =
      await makeHermesSecretFixture(".hermes");
    await writeFile(path.join(source, "config.yaml"), "model: opencode/kimi-k2.5\n");
    await openCodeAuth({
      "github-copilot": {
        type: "oauth",
        refresh: "gho-opencode-copilot-token",
        access: "copilot-api-token",
        expires: Date.now() + 3600_000,
      },
      opencode: { type: "api", key: "opencode-zen-key" },
      "opencode-go": { type: "api", key: "opencode-go-key" },
    });
    const ctx = secretContext({ config, reportDir, runtime: makeConfigRuntime(config) });
    const plan = await provider.plan(ctx);

    const expectedSecret = (name: string, secretField = "key", mode?: string) => ({
      id: `secret:${name}:opencode-auth-json`,
      status: "planned" as const,
      details: expect.objectContaining({
        provider: name,
        sourceKind: "opencode-auth-json",
        sourceProvider: name,
        secretField,
        ...(mode ? { mode } : {}),
      }),
    });
    expectItems(
      plan.items,
      {
        ...expectedSecret("opencode"),
        source: path.join(root, ".local", "share", "opencode", "auth.json"),
      },
      expectedSecret("opencode-go"),
      expectedSecret("github-copilot", "refresh", "token"),
    );

    const result = await provider.apply(ctx, plan);

    expect(result.summary.errors).toBe(0);
    const authStore = readAuthProfileStore(agentDir);
    expect(authStore.profiles?.["opencode:hermes-import"]).toMatchObject({
      type: "api_key",
      provider: "opencode",
      key: "opencode-zen-key",
    });
    expect(authStore.profiles?.["opencode-go:hermes-import"]).toMatchObject({
      type: "api_key",
      provider: "opencode-go",
      key: "opencode-go-key",
    });
    expect(authStore.profiles?.["github-copilot:github"]).toMatchObject({
      type: "token",
      provider: "github-copilot",
      token: "gho-opencode-copilot-token",
    });
  });

  it("skips OpenCode GitHub Copilot enterprise credentials until endpoint routing is supported", async () => {
    const { source, config, secretContext, reportDir, agentDir, provider, openCodeAuth } =
      await makeHermesSecretFixture(".hermes");
    await writeFile(path.join(source, "config.yaml"), "model: github-copilot/gpt-5.4\n");
    await openCodeAuth({
      "github-copilot": {
        type: "oauth",
        refresh: "gho-enterprise-copilot-token",
        access: "enterprise-copilot-api-token",
        enterpriseUrl: "https://api.enterprise.githubcopilot.example",
        expires: Date.now() + 3600_000,
      },
    });
    const ctx = secretContext({ config, reportDir, runtime: makeConfigRuntime(config) });
    const plan = await provider.plan(ctx);

    expect(plan.items.some((item) => item.id === "secret:github-copilot:opencode-auth-json")).toBe(
      false,
    );

    const result = await provider.apply(ctx, plan);

    expect(result.summary.errors).toBe(0);
    await expectMissingPath(path.join(agentDir, "auth-profiles.json"));
  });

  it("imports OpenCode OpenAI OAuth credentials as OpenAI auth", async () => {
    const { root, source, config, secretContext, reportDir, agentDir, provider, openCodeAuth } =
      await makeHermesSecretFixture(".hermes");
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "opencode-openai@example.test" },
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    });
    await writeFile(path.join(source, "auth.json"), "{}");
    await openCodeAuth(
      openAiOAuth(accessToken, "openai-refresh-token", {
        expires: Date.now() + 3600_000,
        accountId: "acct_opencode",
      }),
    );
    const ctx = secretContext({ config, reportDir, runtime: makeConfigRuntime(config) });
    const plan = await provider.plan(ctx);

    expectItems(plan.items, {
      id: "auth:openai",
      kind: "auth",
      status: "planned",
      source: path.join(root, ".local", "share", "opencode", "auth.json"),
      details: expect.objectContaining({
        provider: "openai",
        sourceKind: "opencode-auth-json",
        sourceLabel: "OpenCode OpenAI OAuth credential",
      }),
    });

    const result = await provider.apply(ctx, plan);

    expect(result.summary.errors).toBe(0);
    const authStore = readAuthProfileStore(agentDir);
    expect(authStore.profiles?.["openai:account-acct_opencode"]).toMatchObject({
      type: "oauth",
      provider: "openai",
      accountId: "acct_opencode",
      access: accessToken,
      refresh: "openai-refresh-token",
    });
    expect(config.agents?.defaults?.model).toEqual({ primary: "openai/gpt-6-astra" });
    expect(config.agents?.defaults?.models?.["openai/gpt-6-astra"]).toEqual({});
  });

  it("does not apply a planned OpenCode OpenAI OAuth credential after the source token changes", async () => {
    const { source, secretContext, reportDir, agentDir, provider, openCodeAuth } =
      await makeHermesSecretFixture(".hermes");
    await writeFile(path.join(source, "auth.json"), "{}");
    await openCodeAuth(openAiOAuth("planned-opencode-access", "planned-opencode-refresh"));
    const ctx = secretContext({ reportDir });
    const plan = await provider.plan(ctx);
    expectItems(plan.items, {
      id: "auth:openai",
      details: expect.objectContaining({
        sourceCredentialFingerprint: expect.any(String),
        sourceCredentialIndex: 0,
        sourceKind: "opencode-auth-json",
      }),
    });

    await openCodeAuth(openAiOAuth("changed-opencode-access", "changed-opencode-refresh"));

    const result = await provider.apply(ctx, plan);
    const authItem = result.items.find((item) => item.id === "auth:openai");

    expect(authItem).toMatchObject({
      status: "skipped",
      reason: HERMES_REASON_SECRET_NO_LONGER_PRESENT,
    });
    await expectMissingPath(path.join(agentDir, "auth-profiles.json"));
  });

  it("reports OpenCode OpenAI OAuth config auth profile conflicts during planning", async () => {
    const { source, workspaceDir, secretContext, provider, openCodeAuth } =
      await makeHermesSecretFixture();
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "codex@example.test" },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_conflict",
        chatgpt_plan_type: "plus",
      },
    });
    const config = {
      agents: { defaults: { workspace: workspaceDir } },
      auth: {
        profiles: { "openai:account-acct_conflict": { provider: "openai", mode: "api_key" } },
      },
    } as OpenClawConfig;
    await writeFile(path.join(source, "auth.json"), "{}");
    await openCodeAuth(openAiOAuth(accessToken, "refresh-test-token"));
    const plan = await provider.plan(secretContext({ config }));
    const authItem = plan.items.find((item) => item.id === "auth:openai");

    expect(authItem).toMatchObject({
      status: "conflict",
      reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
      details: expect.objectContaining({ profileId: "openai:account-acct_conflict" }),
    });
  });

  it("does not collapse OpenCode OpenAI OAuth accounts that share an email", async () => {
    const { source, workspaceDir, secretContext, reportDir, agentDir, provider, openCodeAuth } =
      await makeHermesSecretFixture();
    const sharedEmail = "shared@example.com";
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: sharedEmail },
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_new", chatgpt_plan_type: "plus" },
    });
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: { primary: "anthropic/claude-opus-4-8", fallbacks: ["openai/gpt-5.5"] },
          models: {
            "openai/gpt-5.5": { alias: "existing-openai", params: { temperature: 0.2 } },
            "anthropic/claude-opus-4-8": { alias: "existing-claude" },
          },
        },
      },
    } as OpenClawConfig;
    await writeFile(path.join(source, "config.yaml"), "model: openai/gpt-5.5\n");
    await openCodeAuth(openAiOAuth(accessToken, "refresh-new-token"));
    writeAuthProfileStore(agentDir, {
      version: 1,
      profiles: {
        "openai:account-acct_old": {
          type: "oauth",
          provider: "openai",
          access: "old-access-token",
          refresh: "old-refresh-token",
          expires: Date.now() + 3600_000,
          accountId: "acct_old",
          email: sharedEmail,
        },
      },
    });
    const ctx = secretContext({ config, reportDir, runtime: makeConfigRuntime(config) });
    const plan = await provider.plan(ctx);
    const authItem = plan.items.find((item) => item.id === "auth:openai");

    expect(authItem).toMatchObject({
      status: "planned",
      details: expect.objectContaining({ profileId: "openai:account-acct_new" }),
    });

    const result = await provider.apply(ctx, plan);

    expect(result.summary.errors).toBe(0);
    const authStore = readAuthProfileStore(agentDir);
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
    expect(config.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-8",
      fallbacks: ["openai/gpt-5.5"],
    });
    expect(config.agents?.defaults?.models).toMatchObject({
      "openai/gpt-5.5": { alias: "existing-openai", params: { temperature: 0.2 } },
      "anthropic/claude-opus-4-8": { alias: "existing-claude" },
    });
  });
});
