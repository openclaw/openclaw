import fs from "node:fs/promises";
import path from "node:path";
import { resolveAuthStorePathForDisplay } from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HERMES_REASON_AUTH_PROFILE_EXISTS,
  HERMES_REASON_INCLUDE_SECRETS,
  HERMES_REASON_SECRET_NO_LONGER_PRESENT,
} from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { fakeJwt, readAuthProfileStore, writeAuthProfileStore } from "./test/auth-helpers.js";
import { hermesCase, item as migrationItem } from "./test/hermes-case.js";
import { useHermesFixture, writeJson } from "./test/migration-fixture.js";
import { makeConfigRuntime, writeFile } from "./test/provider-helpers.js";

const fixture = useHermesFixture(async (root) => {
  vi.unstubAllEnvs();
  await closeOpenClawAgentDatabasesAsync(root);
  await closeOpenClawStateDatabaseAsync();
});

const expectMissingPath = (filePath: string) =>
  expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });

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

let h: ReturnType<typeof hermesCase>;
beforeEach(() => {
  h = hermesCase(fixture.paths.root, true, ".hermes");
});

describe("Hermes migration secret items", () => {
  it("honors agentDir without runtime helpers", async () => {
    const customAgentDir = path.join(h.root, "custom-agent");
    await h.write(".env", "OPENAI_API_KEY=sk-hermes\n");
    const config = {
      agents: {
        defaults: { workspace: h.workspaceDir },
        entries: { custom: { agentDir: customAgentDir } },
      },
    } as OpenClawConfig;
    const skipped = await h.plan({ config, includeSecrets: false });
    expect(migrationItem(skipped, "secret:openai")).toMatchObject({
      sensitive: true,
      status: "skipped",
      reason: HERMES_REASON_INCLUDE_SECRETS,
    });
    const plan = await h.plan({ config });
    expect(plan.metadata?.agentDir).toBe(customAgentDir);
    expect(migrationItem(plan, "secret:openai")).toMatchObject({
      target: `${resolveAuthStorePathForDisplay(customAgentDir)}#openai:hermes-import`,
      sensitive: true,
    });
    const result = await h.apply({ config, overwrite: true });
    expect(result.summary.errors).toBe(0);
    const profiles = readAuthProfileStore(customAgentDir).profiles;
    expect(profiles["openai:hermes-import"]).toEqual({
      type: "api_key",
      provider: "openai",
      key: "sk-hermes",
      displayName: "Hermes import",
    });
    await expectMissingPath(
      path.join(h.stateDir, "agents", "custom", "agent", "auth-profiles.json"),
    );
  });

  it("parses dotenv exports and legacy Kimi keys", async () => {
    const kimiEnv = ["KIMI", "CODING", "API", "KEY"].join("_");
    const openaiEnv = ["OPENAI", "API", "KEY"].join("_");
    await h.write(
      ".env",
      `\uFEFFexport ${kimiEnv} = placeholder\nexport ${openaiEnv}='redacted'\n`,
    );
    const plan = await h.plan();
    expectItems(
      plan.items,
      { kind: "secret", details: expect.objectContaining({ provider: "moonshot" }) },
      { kind: "secret", details: expect.objectContaining({ provider: "openai" }) },
    );
  });

  it.each([
    ["moonshot", "MOONSHOT_API_KEY", "placeholder", "moonshot"],
    ["kimi-coding", "KIMI_API_KEY", "sk-kimi-placeholder", "kimi"],
  ])("aligns %s model routing and credentials", async (source, envVar, key, provider) => {
    await h.write("config.yaml", { model: { provider: source, default: "kimi-k2.5" } });
    await h.write(".env", `${envVar}=${key}\n`);
    const plan = await h.plan();
    expect(plan.items.find((item) => item.id === "config:default-model")?.details?.model).toBe(
      `${provider}/kimi-k2.5`,
    );
    expectItems(plan.items, {
      kind: "secret",
      details: expect.objectContaining({ envVar, provider }),
    });
  });

  it.each(["key_env", "keyEnv"])("imports configured provider keys (%s)", async (field) => {
    const value = ["custom", "provider", "placeholder"].join("-");
    const envVar = ["ACME", "TOKEN"].join("_");
    await h.write("config.yaml", {
      model: { provider: "acme", default: "acme-chat" },
      providers: {
        acme: { api: "https://api.acme.example/v1", [field]: envVar, models: ["acme-chat"] },
      },
    });
    await h.write(".env", `${envVar}=${value}\n`);
    const result = await h.import({ overwrite: true });
    expect(result.summary.errors).toBe(0);
    expectItems(result.items, {
      details: expect.objectContaining({ envVar, provider: "acme" }),
      status: "migrated",
    });
    const profiles = h.profiles();
    const profile = profiles["acme:hermes-import"];
    expect(profile).toMatchObject({ provider: "acme", type: "api_key", key: value });
    expect(h.config.models?.providers?.acme?.apiKey).toBeUndefined();
    expect(h.config.auth?.profiles?.["acme:hermes-import"]).toMatchObject({
      mode: "api_key",
      provider: "acme",
    });
  });

  it.each([true, false])(
    "binds the OpenAI key to its custom endpoint (explicit=%s)",
    async (explicit) => {
      const baseUrl = explicit ? "https://api.openai.com/v1" : "https://private.example.test/v1";
      await h.write("config.yaml", {
        model: {
          provider: "custom",
          default: "gpt-5.6",
          ...(explicit ? { base_url: baseUrl } : {}),
        },
      });
      await h.write(
        ".env",
        `OPENAI_API_KEY=placeholder\n${explicit ? "" : `OPENAI_BASE_URL=${baseUrl}\n`}`,
      );
      const plan = await h.plan();
      expect(migrationItem(plan, "config:model-provider:custom")?.details?.value).toMatchObject({
        custom: { baseUrl },
      });
      const secretItems = plan.items.filter((item) => item.kind === "secret");
      expect(secretItems).toHaveLength(1);
      expect(secretItems[0]?.details).toMatchObject({
        envVar: "OPENAI_API_KEY",
        provider: "custom",
      });
    },
  );

  it("deduplicates singleton and pooled OpenAI accounts", async () => {
    const accountOne = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_one" },
      "https://api.openai.com/profile": { email: "one@example.test" },
    });
    const accountTwo = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_two" },
      "https://api.openai.com/profile": { email: "two@example.test" },
    });
    await h.write("auth.json", {
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
    const provider = buildHermesMigrationProvider({ runtime: h.runtime });
    const ctx = h.context({ config: h.config, runtime: h.runtime, overwrite: true });
    const plan = await provider.plan(ctx);
    const plannedAuth = plan.items.filter((item) => item.kind === "auth");
    // Saved migration plans retain these identities, including the trailing NUL in their input.
    expect(plannedAuth.map((item) => item.details?.sourceCredentialFingerprint)).toEqual([
      "f115fb638e4d83a0e0357ec2c3238e8914456d1a88474d0e85c6319566af7742",
      "244884a0f3a0ced413ddcad6fd1ce1bb6969e3ee68752012abc1af8fe310f745",
    ]);
    expect(plannedAuth.every((entry) => entry.sensitive)).toBe(true);
    expect(plan.warnings).toContain(
      "Hermes and OpenClaw must not keep using the same imported OpenAI OAuth refresh grant after migration; reauthenticate one side before running both.",
    );
    const result = await provider.apply(ctx, plan);
    const authItems = result.items.filter((item) => item.kind === "auth");
    expect(authItems).toHaveLength(2);
    expect(authItems.every((item) => item.status === "migrated")).toBe(true);
    const profiles = h.profiles();
    expect(profiles).toMatchObject({
      "openai:account-acct_one": { provider: "openai", refresh: "refresh-one" },
      "openai:account-acct_two": { provider: "openai", refresh: "refresh-two" },
    });
  });

  it("imports manual pools but not borrowed keys", async () => {
    const firstValue = "openrouter-one";
    const secondValue = "openrouter-two";
    const borrowedValue = "borrowed-value";
    const geminiValue = "gemini-value";
    await h.write("auth.json", {
      credential_pool: {
        openrouter: [
          poolKey("key-one", firstValue),
          poolKey("key-two", secondValue),
          poolKey("borrowed", borrowedValue, "env:OPENROUTER_API_KEY"),
        ],
        gemini: [poolKey("google-key", geminiValue)],
      },
    });
    const result = await h.import({ overwrite: true });
    const secretItems = result.items.filter(
      (item) => item.kind === "secret" && item.details?.sourceKind === "hermes-auth-json",
    );
    expect(secretItems).toHaveLength(3);
    const profiles = h.profiles();
    expect(profiles).toMatchObject({
      "openrouter:hermes-key-one": { type: "api_key", key: firstValue },
      "openrouter:hermes-key-two": { type: "api_key", key: secondValue },
      "google:hermes-google-key": { type: "api_key", key: geminiValue },
    });
    expect(profiles["openrouter:hermes-borrowed"]).toBeUndefined();
  });

  it("uses per-provider global pool fallback", async () => {
    const hermesRoot = path.join(h.root, ".hermes");
    const source = path.join(hermesRoot, "profiles", "coder");
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
    vi.stubEnv("HOME", h.root);
    vi.stubEnv("HERMES_HOME", "");
    const result = await buildHermesMigrationProvider({ runtime: h.runtime }).apply(
      h.context({ source: "", config: h.config, runtime: h.runtime, overwrite: true }),
    );
    expect(result.summary.errors).toBe(0);
    const profiles = h.profiles();
    expect(profiles["openrouter:hermes-profile-openrouter"]).toMatchObject({
      key: profileOpenRouterValue,
    });
    expect(profiles["openrouter:hermes-global-openrouter"]).toBeUndefined();
    expect(profiles["google:hermes-global-gemini"]).toMatchObject({ key: globalGeminiValue });
  });

  it("keeps imported keys when config writes fail", async () => {
    await h.write(".env", "OPENAI_API_KEY=sk-hermes\n");
    const runtime = {
      config: {
        current: () => h.config,
        mutateConfigFile: async () => {
          throw new Error("config write failed");
        },
      },
    } as unknown as MigrationProviderContext["runtime"];
    const ctx = h.context({ config: h.config, reportDir: h.reportDir, runtime });
    const plan = await h.provider.plan(ctx);
    const result = await h.provider.apply(ctx, plan);
    const item = result.items.find((entry) => entry.id === "secret:openai");
    expect(item).toMatchObject({
      status: "migrated",
      details: expect.objectContaining({ configUpdated: false }),
    });
    const profiles = h.profiles();
    expect(profiles["openai:hermes-import"]).toMatchObject({
      type: "api_key",
      provider: "openai",
      key: "sk-hermes",
    });
  });

  it("preserves late-created auth profiles", async () => {
    await h.write(".env", "OPENAI_API_KEY=sk-hermes\n");
    const ctx = h.context({ reportDir: h.reportDir });
    const plan = await h.provider.plan(ctx);
    writeAuthProfileStore(h.agentDir, {
      version: 1,
      profiles: { "openai:hermes-import": { type: "api_key", provider: "openai", key: "sk-late" } },
    });
    const result = await h.provider.apply(ctx, plan);
    expect(migrationItem(result, "secret:openai")).toMatchObject({
      status: "conflict",
      reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
    });
    expect(result.summary.conflicts).toBe(1);
    const profiles = h.profiles();
    expect(profiles["openai:hermes-import"]).toMatchObject({
      type: "api_key",
      provider: "openai",
      key: "sk-late",
    });
  });

  it.each(["key-plan", "key-apply", "oauth-plan"])("blocks config conflicts (%s)", async (kind) => {
    const oauth = kind === "oauth-plan";
    const late = kind === "key-apply";
    const profileId = oauth ? "openai:account-acct_conflict" : "openai:hermes-import";
    if (oauth) {
      const access = fakeJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_conflict" },
      });
      await h.write("auth.json", "{}");
      await h.openCode(openAiOAuth(access, "refresh-test-token"));
    } else {
      await h.write(".env", "OPENAI_API_KEY=sk-hermes\n");
    }
    const auth: OpenClawConfig["auth"] = {
      profiles: { [profileId]: { provider: oauth ? "openai" : "anthropic", mode: "api_key" } },
    };
    if (!late) {
      h.config.auth = auth;
    }
    const ctx = h.context({ config: h.config, ...(late ? { runtime: h.runtime } : {}) });
    const plan = await h.provider.plan(ctx);
    h.config.auth = auth;
    const result = await h.provider.apply(ctx, plan);
    const conflict = {
      id: oauth ? "auth:openai" : "secret:openai",
      status: "conflict",
      reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
    };
    if (!late) {
      expect(plan.items).toEqual([expect.objectContaining(conflict)]);
    }
    if (oauth) {
      expect(migrationItem(plan, "auth:openai")?.details?.profileId).toBe(profileId);
    }
    expect(result.items).toEqual([expect.objectContaining(conflict)]);
    expect(result.summary.conflicts).toBe(1);
    await expectMissingPath(path.join(h.agentDir, "auth-profiles.json"));
  });

  it("imports adjacent OpenCode credentials", async () => {
    await h.write("config.yaml", "model: opencode/kimi-k2.5\n");
    await h.openCode({
      "github-copilot": {
        type: "oauth",
        refresh: "gho-opencode-copilot-token",
        access: "copilot-api-token",
        expires: Date.now() + 3600_000,
      },
      opencode: { type: "api", key: "opencode-zen-key" },
      "opencode-go": { type: "api", key: "opencode-go-key" },
    });
    const result = await h.import();
    expect(result.summary.errors).toBe(0);
    const profiles = h.profiles();
    expect(profiles).toMatchObject({
      "opencode:hermes-import": { type: "api_key", provider: "opencode", key: "opencode-zen-key" },
      "opencode-go:hermes-import": {
        type: "api_key",
        provider: "opencode-go",
        key: "opencode-go-key",
      },
      "github-copilot:github": {
        type: "token",
        provider: "github-copilot",
        token: "gho-opencode-copilot-token",
      },
    });
  });

  it("rejects unroutable enterprise Copilot credentials", async () => {
    await h.write("config.yaml", "model: github-copilot/gpt-5.4\n");
    await h.openCode({
      "github-copilot": {
        type: "oauth",
        refresh: "gho-enterprise-copilot-token",
        access: "enterprise-copilot-api-token",
        enterpriseUrl: "https://api.enterprise.githubcopilot.example",
        expires: Date.now() + 3600_000,
      },
    });
    const ctx = h.context({ config: h.config, runtime: h.runtime });
    const plan = await h.provider.plan(ctx);
    expect(plan.items.some((item) => item.id === "secret:github-copilot:opencode-auth-json")).toBe(
      false,
    );
    const result = await h.provider.apply(ctx, plan);
    expect(result.summary.errors).toBe(0);
    await expectMissingPath(path.join(h.agentDir, "auth-profiles.json"));
  });

  it("imports OpenCode OpenAI OAuth", async () => {
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "opencode-openai@example.test" },
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    });
    await h.write("auth.json", "{}");
    await h.openCode(
      openAiOAuth(accessToken, "openai-refresh-token", {
        expires: Date.now() + 3600_000,
        accountId: "acct_opencode",
      }),
    );
    const result = await h.import();
    expect(result.summary.errors).toBe(0);
    const profiles = h.profiles();
    expect(profiles["openai:account-acct_opencode"]).toMatchObject({
      type: "oauth",
      provider: "openai",
      accountId: "acct_opencode",
      access: accessToken,
      refresh: "openai-refresh-token",
    });
    expect(h.config.agents?.defaults?.model).toEqual({ primary: "openai/gpt-6-astra" });
    expect(h.config.agents?.defaults?.models?.["openai/gpt-6-astra"]).toEqual({});
  });

  it("rejects changed OAuth source credentials", async () => {
    await h.write("auth.json", "{}");
    await h.openCode(openAiOAuth("planned-opencode-access", "planned-opencode-refresh"));
    const ctx = h.context({ reportDir: h.reportDir });
    const plan = await h.provider.plan(ctx);
    expect(migrationItem(plan, "auth:openai")?.status).toBe("planned");
    await h.openCode(openAiOAuth("changed-opencode-access", "changed-opencode-refresh"));
    const result = await h.provider.apply(ctx, plan);
    const authItem = result.items.find((item) => item.id === "auth:openai");
    expect(authItem).toMatchObject({
      status: "skipped",
      reason: HERMES_REASON_SECRET_NO_LONGER_PRESENT,
    });
    await expectMissingPath(path.join(h.agentDir, "auth-profiles.json"));
  });

  it("keeps same-email accounts distinct", async () => {
    const sharedEmail = "shared@example.com";
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: sharedEmail },
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_new", chatgpt_plan_type: "plus" },
    });
    const config = {
      agents: {
        defaults: {
          workspace: h.workspaceDir,
          model: { primary: "anthropic/claude-opus-4-8", fallbacks: ["openai/gpt-5.5"] },
          models: {
            "openai/gpt-5.5": { alias: "existing-openai", params: { temperature: 0.2 } },
            "anthropic/claude-opus-4-8": { alias: "existing-claude" },
          },
        },
      },
    } as OpenClawConfig;
    await h.write("config.yaml", "model: openai/gpt-5.5\n");
    await h.openCode(openAiOAuth(accessToken, "refresh-new-token"));
    writeAuthProfileStore(h.agentDir, {
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
    const ctx = h.context({ config, reportDir: h.reportDir, runtime: makeConfigRuntime(config) });
    const plan = await h.provider.plan(ctx);
    const authItem = plan.items.find((item) => item.id === "auth:openai");
    expect(authItem).toMatchObject({
      status: "planned",
      details: expect.objectContaining({ profileId: "openai:account-acct_new" }),
    });
    const result = await h.provider.apply(ctx, plan);
    expect(result.summary.errors).toBe(0);
    const profiles = h.profiles();
    expect(profiles["openai:account-acct_old"]).toMatchObject({
      access: "old-access-token",
      accountId: "acct_old",
      email: sharedEmail,
    });
    expect(profiles["openai:account-acct_new"]).toMatchObject({
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
