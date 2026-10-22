import fs from "node:fs/promises";
import path from "node:path";
import { resolveAuthStorePathForDisplay } from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import {
  HERMES_REASON_AUTH_PROFILE_EXISTS,
  HERMES_REASON_INCLUDE_SECRETS,
  HERMES_REASON_SECRET_NO_LONGER_PRESENT,
} from "./items.js";
import { fakeJwt, readAuthProfileStore, writeAuthProfileStore } from "./test/auth-helpers.js";
import { hermesCase, item } from "./test/hermes-case.js";
import { useHermesFixture, writeJson } from "./test/migration-fixture.js";
import { writeFile } from "./test/provider-helpers.js";

const fixture = useHermesFixture(async (root) => {
  vi.unstubAllEnvs();
  await closeOpenClawAgentDatabasesAsync(root);
  await closeOpenClawStateDatabaseAsync();
});
const makeCase = (sourceName?: string) => hermesCase(fixture.paths.root, true, sourceName);
const accessField = ["access", "token"].join("_");
const refreshField = ["refresh", "token"].join("_");
const missing = (file: string) => expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
const target = (dir: string, id: string) => `${resolveAuthStorePathForDisplay(dir)}#${id}`;
const poolKey = (id: string, value: string, source = "manual") => ({
  id,
  auth_type: "api_key",
  source,
  [accessField]: value,
});
const oauth = (access: string, refresh: string, extra: Record<string, unknown> = {}) => ({
  openai: { type: "oauth", access, refresh, ...extra },
});
function accountJwt(id: string, email: string) {
  return fakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: id },
    "https://api.openai.com/profile": { email },
  });
}
function expiringJwt(id: string, email: string) {
  return fakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/profile": { email },
    "https://api.openai.com/auth": { chatgpt_account_id: id, chatgpt_plan_type: "plus" },
  });
}
function contains(items: MigrationItem[], ...expected: Array<Partial<MigrationItem>>) {
  expect(items).toEqual(
    expect.arrayContaining(expected.map((entry) => expect.objectContaining(entry))),
  );
}
function expectedSecret(
  h: ReturnType<typeof makeCase>,
  dir: string,
  status: string,
  reason?: string,
) {
  return {
    id: "secret:openai",
    kind: "secret",
    action: "create",
    source: path.join(h.source, ".env"),
    target: target(dir, "openai:hermes-import"),
    status,
    sensitive: true,
    ...(reason ? { reason } : {}),
    details: { envVar: "OPENAI_API_KEY", provider: "openai", profileId: "openai:hermes-import" },
  };
}

describe("Hermes migration credentials", () => {
  it("uses configured agentDir without runtime helpers", async () => {
    const h = makeCase();
    const agentDir = path.join(h.root, "custom-agent");
    await h.write(".env", "OPENAI_API_KEY=sk-hermes\n");
    h.config.agents = {
      defaults: { workspace: h.workspaceDir },
      entries: { custom: { agentDir } },
    };
    const skipped = await h.plan({ config: h.config, includeSecrets: false });
    expect(item(skipped, "secret:openai")).toMatchObject({
      sensitive: true,
      status: "skipped",
      reason: HERMES_REASON_INCLUDE_SECRETS,
    });
    expect(skipped.warnings).toContain(
      "Auth credentials were detected but skipped. Re-run interactively or pass --include-secrets to import supported credentials.",
    );
    const plan = await h.plan({ config: h.config });
    expect(plan.metadata?.agentDir).toBe(agentDir);
    expect(plan.items).toEqual([expectedSecret(h, agentDir, "planned")]);
    const result = await h.apply({ config: h.config, overwrite: true, reportDir: h.reportDir });
    expect(result.summary.errors).toBe(0);
    expect(readAuthProfileStore(agentDir).profiles["openai:hermes-import"]).toEqual({
      type: "api_key",
      provider: "openai",
      key: "sk-hermes",
      displayName: "Hermes import",
    });
    await missing(path.join(h.stateDir, "agents", "custom", "agent", "auth-profiles.json"));
  });

  it("parses current dotenv syntax and legacy Kimi credentials", async () => {
    const h = makeCase();
    await h.write(
      ".env",
      "\uFEFFexport KIMI_CODING_API_KEY = placeholder\nexport OPENAI_API_KEY='redacted'\n",
    );
    contains(
      (await h.plan()).items,
      { kind: "secret", details: expect.objectContaining({ provider: "moonshot" }) },
      { kind: "secret", details: expect.objectContaining({ provider: "openai" }) },
    );
  });

  it.each([
    ["moonshot", "MOONSHOT_API_KEY", "placeholder", "moonshot"],
    ["kimi-coding", "KIMI_API_KEY", "sk-kimi-placeholder", "kimi"],
  ])("aligns %s model routing and credentials", async (sourceProvider, envVar, key, provider) => {
    const h = makeCase();
    await h.write("config.yaml", { model: { provider: sourceProvider, default: "kimi-k2.5" } });
    await h.write(".env", `${envVar}=${key}\n`);
    const plan = await h.plan();
    expect(item(plan, "config:default-model")?.details?.model).toBe(`${provider}/kimi-k2.5`);
    contains(plan.items, {
      kind: "secret",
      details: expect.objectContaining({ envVar, provider }),
    });
  });

  it("imports key_env into matching provider auth, not model config", async () => {
    const h = makeCase();
    const value = "custom-provider-placeholder";
    await h.write(
      "config.yaml",
      `
model: { provider: acme, default: acme-chat }
providers: { acme: { api: https://api.acme.example/v1, key_env: ACME_TOKEN, models: [ acme-chat ] } }
`,
    );
    await h.write(".env", `ACME_TOKEN=${value}\n`);
    const result = await h.import({ overwrite: true });
    expect(result.summary.errors).toBe(0);
    contains(result.items, {
      status: "migrated",
      details: expect.objectContaining({ envVar: "ACME_TOKEN", provider: "acme" }),
    });
    expect(h.profiles()["acme:hermes-import"]).toMatchObject({
      provider: "acme",
      type: "api_key",
      key: value,
    });
    expect(h.config.models?.providers?.acme?.apiKey).toBeUndefined();
    expect(h.config.auth?.profiles?.["acme:hermes-import"]).toMatchObject({
      mode: "api_key",
      provider: "acme",
    });
  });

  it.each([false, true])("binds the OpenAI key to a custom endpoint (env=%s)", async (fromEnv) => {
    const h = makeCase();
    await h.write("config.yaml", {
      model: {
        provider: "custom",
        default: fromEnv ? "private-model" : "gpt-5.6",
        ...(!fromEnv ? { base_url: "https://api.openai.com/v1" } : {}),
      },
    });
    await h.write(
      ".env",
      `OPENAI_API_KEY=placeholder\n${fromEnv ? "OPENAI_BASE_URL=https://private.example.test/v1\n" : ""}`,
    );
    const plan = await h.plan();
    const secrets = plan.items.filter((entry) => entry.kind === "secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.details).toMatchObject({ envVar: "OPENAI_API_KEY", provider: "custom" });
    if (fromEnv) {
      expect(item(plan, "config:model-provider:custom")?.details?.value).toMatchObject({
        custom: { baseUrl: "https://private.example.test/v1" },
      });
    }
  });

  it("imports singleton and pooled OAuth accounts once, preserving saved fingerprints", async () => {
    const h = makeCase();
    const one = accountJwt("acct_one", "one@example.test");
    const two = accountJwt("acct_two", "two@example.test");
    const tokens = (access: string, refresh: string, last_refresh: string) => ({
      [accessField]: access,
      [refreshField]: refresh,
      last_refresh,
    });
    await h.write("auth.json", {
      providers: {
        "openai-codex": {
          tokens: { [accessField]: one, [refreshField]: "refresh-one" },
          last_refresh: "2026-07-13T10:00:00Z",
        },
      },
      credential_pool: {
        "openai-codex": [
          tokens(one, "refresh-one", "2026-07-13T09:00:00Z"),
          tokens(two, "refresh-two", "2026-07-13T08:00:00Z"),
        ],
      },
    });
    const ctx = h.context({ config: h.config, runtime: h.runtime, overwrite: true });
    const plan = await h.provider.plan(ctx);
    const auth = plan.items.filter((entry) => entry.kind === "auth");
    expect(auth).toHaveLength(2);
    // Saved plans retain these identities, including the trailing NUL in their input.
    expect(auth.map((entry) => entry.details?.sourceCredentialFingerprint)).toEqual([
      "f115fb638e4d83a0e0357ec2c3238e8914456d1a88474d0e85c6319566af7742",
      "244884a0f3a0ced413ddcad6fd1ce1bb6969e3ee68752012abc1af8fe310f745",
    ]);
    expect(auth).toMatchObject(
      [1, 2].map(() => ({
        status: "planned",
        sensitive: true,
        details: { provider: "openai", sourceKind: "hermes-auth-json" },
      })),
    );
    expect(plan.warnings).toContain(
      "Hermes and OpenClaw must not keep using the same imported OpenAI OAuth refresh grant after migration; reauthenticate one side before running both.",
    );
    const applied = (await h.provider.apply(ctx, plan)).items.filter(
      (entry) => entry.kind === "auth",
    );
    expect(applied).toHaveLength(2);
    expect(applied.every((entry) => entry.status === "migrated")).toBe(true);
    expect(h.profiles()).toMatchObject({
      "openai:account-acct_one": { provider: "openai", refresh: "refresh-one" },
      "openai:account-acct_two": { provider: "openai", refresh: "refresh-two" },
    });
  });

  it("imports manual API-key pools but not borrowed references", async () => {
    const h = makeCase();
    await h.write("auth.json", {
      credential_pool: {
        openrouter: [
          poolKey("key-one", "openrouter-one"),
          poolKey("key-two", "openrouter-two"),
          poolKey("borrowed", "borrowed-value", "env:OPENROUTER_API_KEY"),
        ],
        gemini: [poolKey("google-key", "gemini-value")],
      },
    });
    const result = await h.import({ overwrite: true });
    expect(
      result.items.filter(
        (entry) => entry.kind === "secret" && entry.details?.sourceKind === "hermes-auth-json",
      ),
    ).toHaveLength(3);
    expect(h.profiles()).toMatchObject({
      "openrouter:hermes-key-one": { type: "api_key", key: "openrouter-one" },
      "openrouter:hermes-key-two": { type: "api_key", key: "openrouter-two" },
      "google:hermes-google-key": { type: "api_key", key: "gemini-value" },
    });
    expect(h.profiles()["openrouter:hermes-borrowed"]).toBeUndefined();
  });

  it("uses per-provider global API-key and OAuth fallback for an active profile", async () => {
    const h = makeCase();
    const global = path.join(h.root, ".hermes");
    const source = path.join(global, "profiles", "coder");
    await writeFile(path.join(global, "active_profile"), "coder\n");
    await writeFile(path.join(source, "config.yaml"), "{}\n");
    await writeJson(path.join(global, "auth.json"), {
      providers: {
        "openai-codex": {
          tokens: {
            [accessField]: accountJwt("acct-global", "global@example.test"),
            [refreshField]: "global-refresh",
          },
        },
      },
      credential_pool: {
        openrouter: [poolKey("global-openrouter", "global-openrouter-placeholder")],
        gemini: [poolKey("global-gemini", "global-gemini-placeholder")],
      },
    });
    await writeJson(path.join(source, "auth.json"), {
      credential_pool: {
        openrouter: [poolKey("profile-openrouter", "profile-openrouter-placeholder")],
      },
    });
    vi.stubEnv("HOME", h.root);
    vi.stubEnv("HERMES_HOME", "");
    const result = await h.import({ source: "", overwrite: true });
    expect(result.source).toBe(source);
    contains(
      result.items,
      {
        source: path.join(source, "auth.json"),
        details: expect.objectContaining({ provider: "openrouter" }),
      },
      ...["google", "openai"].map((provider) => ({
        source: path.join(global, "auth.json"),
        details: expect.objectContaining({ provider }),
      })),
    );
    expect(h.profiles()).toMatchObject({
      "openrouter:hermes-profile-openrouter": { key: "profile-openrouter-placeholder" },
      "google:hermes-global-gemini": { key: "global-gemini-placeholder" },
      "openai:account-acct-global": { provider: "openai", refresh: "global-refresh" },
    });
    expect(h.profiles()["openrouter:hermes-global-openrouter"]).toBeUndefined();
  });

  it("reports a written API key even when its config update fails", async () => {
    const h = makeCase();
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
    const result = await h.provider.apply(ctx, await h.provider.plan(ctx));
    expect(item(result, "secret:openai")).toMatchObject({
      status: "migrated",
      details: expect.objectContaining({ configUpdated: false }),
    });
    expect(h.profiles()["openai:hermes-import"]).toMatchObject({
      type: "api_key",
      provider: "openai",
      key: "sk-hermes",
    });
  });

  it.each(["store-after-plan", "config-before-plan", "config-after-plan"])(
    "preserves existing credentials: %s",
    async (conflict) => {
      const h = makeCase();
      await h.write(".env", "OPENAI_API_KEY=sk-hermes\n");
      const auth = {
        profiles: { "openai:hermes-import": { provider: "anthropic", mode: "api_key" as const } },
      };
      if (conflict === "config-before-plan") {
        h.config.auth = auth;
      }
      const ctx = h.context({
        config: h.config,
        reportDir: h.reportDir,
        ...(conflict === "config-after-plan" ? { runtime: h.runtime } : {}),
      });
      const plan = await h.provider.plan(ctx);
      const expected = expect.objectContaining({
        id: "secret:openai",
        status: "conflict",
        reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
      });
      if (conflict === "config-before-plan") {
        expect(plan.items).toEqual([expected]);
      }
      if (conflict === "store-after-plan") {
        writeAuthProfileStore(h.agentDir, {
          version: 1,
          profiles: {
            "openai:hermes-import": { type: "api_key", provider: "openai", key: "sk-late" },
          },
        });
      } else if (conflict === "config-after-plan") {
        h.config.auth = auth;
      }
      const result = await h.provider.apply(ctx, plan);
      expect(result.summary.conflicts).toBe(1);
      if (conflict === "store-after-plan") {
        expect(result.items).toEqual([
          expectedSecret(h, h.agentDir, "conflict", HERMES_REASON_AUTH_PROFILE_EXISTS),
        ]);
        expect(h.profiles()["openai:hermes-import"]).toMatchObject({
          type: "api_key",
          provider: "openai",
          key: "sk-late",
        });
      } else {
        expect(result.items).toEqual([expected]);
        await missing(path.join(h.agentDir, "auth-profiles.json"));
      }
    },
  );

  it("imports supported OpenCode credentials next to the Hermes home", async () => {
    const h = makeCase(".hermes");
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
    const ctx = h.context({ config: h.config, reportDir: h.reportDir, runtime: h.runtime });
    const plan = await h.provider.plan(ctx);
    const expected = (provider: string, secretField = "key", mode?: string) => ({
      id: `secret:${provider}:opencode-auth-json`,
      status: "planned" as const,
      details: expect.objectContaining({
        provider,
        sourceKind: "opencode-auth-json",
        sourceProvider: provider,
        secretField,
        ...(mode ? { mode } : {}),
      }),
    });
    contains(
      plan.items,
      {
        ...expected("opencode"),
        source: path.join(h.root, ".local", "share", "opencode", "auth.json"),
      },
      expected("opencode-go"),
      expected("github-copilot", "refresh", "token"),
    );
    expect((await h.provider.apply(ctx, plan)).summary.errors).toBe(0);
    expect(h.profiles()).toMatchObject({
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

  it("does not import unsupported Copilot enterprise credentials", async () => {
    const h = makeCase(".hermes");
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
    const ctx = h.context({ config: h.config, reportDir: h.reportDir, runtime: h.runtime });
    const plan = await h.provider.plan(ctx);
    expect(item(plan, "secret:github-copilot:opencode-auth-json")).toBeUndefined();
    expect((await h.provider.apply(ctx, plan)).summary.errors).toBe(0);
    await missing(path.join(h.agentDir, "auth-profiles.json"));
  });

  it.each([false, true])(
    "imports OpenCode OAuth without collapsing existing identities (existing=%s)",
    async (existing) => {
      const h = makeCase(existing ? undefined : ".hermes");
      const config = h.config;
      const accountId = existing ? "acct_new" : "acct_opencode";
      const email = existing ? "shared@example.com" : "opencode-openai@example.test";
      const accessToken = existing
        ? expiringJwt(accountId, email)
        : fakeJwt({
            exp: Math.floor(Date.now() / 1000) + 3600,
            "https://api.openai.com/profile": { email },
            "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
          });
      const refresh = existing ? "refresh-new-token" : "openai-refresh-token";
      const savedModel = { primary: "anthropic/claude-opus-4-8", fallbacks: ["openai/gpt-5.5"] };
      const savedModels = {
        "openai/gpt-5.5": { alias: "existing-openai", params: { temperature: 0.2 } },
        "anthropic/claude-opus-4-8": { alias: "existing-claude" },
      };
      if (existing) {
        config.agents = {
          defaults: {
            workspace: h.workspaceDir,
            model: structuredClone(savedModel),
            models: structuredClone(savedModels),
          },
        };
        await h.write("config.yaml", "model: openai/gpt-5.5\n");
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
              email,
            },
          },
        });
      } else {
        await h.write("auth.json", {});
      }
      await h.openCode(
        oauth(accessToken, refresh, existing ? {} : { expires: Date.now() + 3600_000, accountId }),
      );
      const ctx = h.context({ config, reportDir: h.reportDir, runtime: h.runtime });
      const plan = await h.provider.plan(ctx);
      if (existing) {
        expect(item(plan, "auth:openai")).toMatchObject({
          status: "planned",
          details: expect.objectContaining({ profileId: "openai:account-acct_new" }),
        });
      } else {
        contains(plan.items, {
          id: "auth:openai",
          kind: "auth",
          status: "planned",
          source: path.join(h.root, ".local", "share", "opencode", "auth.json"),
          details: expect.objectContaining({
            provider: "openai",
            sourceKind: "opencode-auth-json",
            sourceLabel: "OpenCode OpenAI OAuth credential",
          }),
        });
      }
      expect((await h.provider.apply(ctx, plan)).summary.errors).toBe(0);
      expect(h.profiles()[`openai:account-${accountId}`]).toMatchObject({
        type: "oauth",
        provider: "openai",
        accountId,
        access: accessToken,
        refresh,
        ...(existing ? { email } : {}),
      });
      if (existing) {
        expect(h.profiles()["openai:account-acct_old"]).toMatchObject({
          access: "old-access-token",
          accountId: "acct_old",
          email,
        });
        expect(config.agents?.defaults?.model).toEqual(savedModel);
        expect(config.agents?.defaults?.models).toMatchObject(savedModels);
      } else {
        expect(config.agents?.defaults?.model).toEqual({ primary: "openai/gpt-6-astra" });
        expect(config.agents?.defaults?.models?.["openai/gpt-6-astra"]).toEqual({});
      }
    },
  );

  it("does not apply an OAuth credential after its source token changes", async () => {
    const h = makeCase(".hermes");
    await h.write("auth.json", {});
    await h.openCode(oauth("planned-opencode-access", "planned-opencode-refresh"));
    const ctx = h.context({ reportDir: h.reportDir });
    const plan = await h.provider.plan(ctx);
    contains(plan.items, {
      id: "auth:openai",
      details: expect.objectContaining({
        sourceCredentialFingerprint: expect.any(String),
        sourceCredentialIndex: 0,
        sourceKind: "opencode-auth-json",
      }),
    });
    await h.openCode(oauth("changed-opencode-access", "changed-opencode-refresh"));
    expect(item(await h.provider.apply(ctx, plan), "auth:openai")).toMatchObject({
      status: "skipped",
      reason: HERMES_REASON_SECRET_NO_LONGER_PRESENT,
    });
    await missing(path.join(h.agentDir, "auth-profiles.json"));
  });

  it("reports OAuth config profile conflicts during planning", async () => {
    const h = makeCase();
    h.config.auth = {
      profiles: { "openai:account-acct_conflict": { provider: "openai", mode: "api_key" } },
    };
    await h.write("auth.json", {});
    await h.openCode(
      oauth(expiringJwt("acct_conflict", "codex@example.test"), "refresh-test-token"),
    );
    expect(item(await h.plan({ config: h.config }), "auth:openai")).toMatchObject({
      status: "conflict",
      reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
      details: expect.objectContaining({ profileId: "openai:account-acct_conflict" }),
    });
  });
});
