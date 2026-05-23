import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it } from "vitest";
import { HERMES_REASON_AUTH_PROFILE_EXISTS } from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import {
  cleanupTempRoots,
  makeConfigRuntime,
  makeContext,
  makeTempRoot,
  writeFile,
} from "./test/provider-helpers.js";

async function expectMissingPath(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected missing path: ${filePath}`);
}

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("Hermes migration secret items", () => {
  afterEach(async () => {
    await cleanupTempRoots();
  });

  it("uses configured agentDir for secret planning and imports without runtime helpers", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const customAgentDir = path.join(root, "custom-agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        list: [
          {
            id: "custom",
            default: true,
            agentDir: customAgentDir,
          },
        ],
      },
    } as OpenClawConfig;

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        config,
        includeSecrets: true,
      }),
    );

    expect(plan.metadata?.agentDir).toBe(customAgentDir);
    expect(plan.items).toEqual([
      {
        id: "secret:openai",
        kind: "secret",
        action: "create",
        source: path.join(source, ".env"),
        target: `${customAgentDir}/auth-profiles.json#openai:hermes-import`,
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
      makeContext({
        source,
        stateDir,
        workspaceDir,
        config,
        includeSecrets: true,
        overwrite: true,
        reportDir: path.join(root, "report"),
      }),
    );

    expect(result.summary.errors).toBe(0);
    const authStore = JSON.parse(
      await fs.readFile(path.join(customAgentDir, "auth-profiles.json"), "utf8"),
    ) as {
      profiles?: Record<
        string,
        { displayName?: string; key?: string; provider?: string; type?: string }
      >;
    };
    expect(authStore.profiles?.["openai:hermes-import"]).toEqual({
      type: "api_key",
      provider: "openai",
      key: "sk-hermes",
      displayName: "Hermes import",
    });
    await expectMissingPath(path.join(stateDir, "agents", "custom", "agent", "auth-profiles.json"));
  });

  it("reports API key import when config update fails after profile write", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as OpenClawConfig;
    const runtime = {
      config: {
        current: () => config,
        mutateConfigFile: async () => {
          throw new Error("config write failed");
        },
      },
    } as unknown as MigrationProviderContext["runtime"];

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
      reportDir,
      runtime,
    });
    const plan = await provider.plan(ctx);

    const result = await provider.apply(ctx, plan);

    const item = result.items.find((entry) => entry.id === "secret:openai");
    expect(item).toEqual(
      expect.objectContaining({
        status: "migrated",
        details: expect.objectContaining({
          configUpdated: false,
        }),
      }),
    );
    const authStore = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as { profiles?: Record<string, { key?: string; provider?: string; type?: string }> };
    expect(authStore.profiles?.["openai:hermes-import"]).toEqual(
      expect.objectContaining({
        type: "api_key",
        provider: "openai",
        key: "sk-hermes",
      }),
    );
  });

  it("keeps secret conflict checks read-only during planning", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    await writeFile(
      path.join(agentDir, "auth.json"),
      JSON.stringify({
        openai: { type: "api_key", provider: "openai", key: "legacy-main-key" },
      }),
    );

    const provider = buildHermesMigrationProvider();
    await provider.plan(makeContext({ source, stateDir, workspaceDir, includeSecrets: true }));

    await expect(fs.access(path.join(agentDir, "auth.json"))).resolves.toBeUndefined();
    await expectMissingPath(path.join(agentDir, "auth-profiles.json"));
  });

  it("reports late-created auth profiles as conflicts without overwriting", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      includeSecrets: true,
      reportDir,
    });
    const plan = await provider.plan(ctx);
    await writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai:hermes-import": {
              type: "api_key",
              provider: "openai",
              key: "sk-late",
            },
          },
        },
        null,
        2,
      ),
    );

    const result = await provider.apply(ctx, plan);

    expect(result.items).toEqual([
      {
        id: "secret:openai",
        kind: "secret",
        action: "create",
        source: path.join(source, ".env"),
        target: `${agentDir}/auth-profiles.json#openai:hermes-import`,
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
    const authStore = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as { profiles?: Record<string, { key?: string }> };
    expect(authStore.profiles?.["openai:hermes-import"]?.key).toBe("sk-late");
  });

  it("reports API key config auth profile conflicts during planning", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
      auth: {
        profiles: {
          "openai:hermes-import": {
            provider: "anthropic",
            mode: "api_key",
          },
        },
      },
    } as OpenClawConfig;

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
    });
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
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as OpenClawConfig;

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
      runtime: makeConfigRuntime(config),
    });
    const plan = await provider.plan(ctx);
    config.auth = {
      profiles: {
        "openai:hermes-import": {
          provider: "anthropic",
          mode: "api_key",
        },
      },
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

  it("imports Hermes auth.json OpenAI Codex OAuth and configures models", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "codex@example.test" },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
        chatgpt_plan_type: "plus",
      },
    });
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as OpenClawConfig;
    await writeFile(
      path.join(source, "auth.json"),
      JSON.stringify({
        providers: {
          "openai-codex": {
            last_refresh: new Date().toISOString(),
            tokens: {
              access_token: accessToken,
              refresh_token: "refresh-test-token",
            },
          },
        },
      }),
    );

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
      reportDir,
      runtime: makeConfigRuntime(config),
    });
    const plan = await provider.plan(ctx);

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "auth:openai-codex",
          kind: "auth",
          status: "planned",
          sensitive: true,
        }),
      ]),
    );

    const result = await provider.apply(ctx, plan);

    expect(result.summary.errors).toBe(0);
    expect(result.summary.migrated).toBeGreaterThanOrEqual(1);
    const authStore = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as {
      profiles?: Record<
        string,
        { access?: string; provider?: string; refresh?: string; type?: string }
      >;
    };
    const profile = authStore.profiles?.["openai-codex:account-acct_test"];
    expect(profile).toEqual(
      expect.objectContaining({
        type: "oauth",
        provider: "openai-codex",
        access: accessToken,
        refresh: "refresh-test-token",
      }),
    );
    expect(config.auth?.profiles?.["openai-codex:account-acct_test"]).toEqual(
      expect.objectContaining({
        provider: "openai-codex",
        mode: "oauth",
      }),
    );
    expect(config.agents?.defaults?.models?.["openai/gpt-5.5"]).toEqual({});
  });

  it("reports Hermes OAuth config auth profile conflicts during planning", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "codex@example.test" },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_conflict",
        chatgpt_plan_type: "plus",
      },
    });
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
      auth: {
        profiles: {
          "openai-codex:account-acct_conflict": {
            provider: "openai-codex",
            mode: "api_key",
          },
        },
      },
    } as OpenClawConfig;
    await writeFile(
      path.join(source, "auth.json"),
      JSON.stringify({
        providers: {
          "openai-codex": {
            last_refresh: new Date().toISOString(),
            tokens: {
              access_token: accessToken,
              refresh_token: "refresh-test-token",
            },
          },
        },
      }),
    );

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        config,
        includeSecrets: true,
      }),
    );
    const authItem = plan.items.find((item) => item.id === "auth:openai-codex");

    expect(authItem).toEqual(
      expect.objectContaining({
        status: "conflict",
        reason: HERMES_REASON_AUTH_PROFILE_EXISTS,
        details: expect.objectContaining({
          profileId: "openai-codex:account-acct_conflict",
        }),
      }),
    );
  });

  it("imports every distinct Hermes auth.json OpenAI Codex OAuth credential", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const activeAccessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "active@example.test" },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_active",
        chatgpt_plan_type: "plus",
      },
    });
    const poolAccessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "pool@example.test" },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_pool",
        chatgpt_plan_type: "team",
      },
    });
    const secondPoolAccessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "second-pool@example.test" },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_second_pool",
        chatgpt_plan_type: "pro",
      },
    });
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as OpenClawConfig;
    await writeFile(
      path.join(source, "auth.json"),
      JSON.stringify({
        providers: {
          "openai-codex": {
            last_refresh: "2026-01-03T00:00:00.000Z",
            tokens: {
              access_token: activeAccessToken,
              refresh_token: "refresh-active-token",
            },
          },
        },
        credential_pool: {
          "openai-codex": [
            {
              label: "Pool account",
              last_refresh: "2026-01-02T00:00:00.000Z",
              access_token: poolAccessToken,
              refresh_token: "refresh-pool-token",
            },
            {
              label: "Second pool account",
              last_refresh: "2026-01-01T00:00:00.000Z",
              access_token: secondPoolAccessToken,
              refresh_token: "refresh-second-pool-token",
            },
          ],
        },
      }),
    );

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
      reportDir,
      runtime: makeConfigRuntime(config),
    });
    const plan = await provider.plan(ctx);
    const authItems = plan.items.filter((item) => item.kind === "auth");

    expect(authItems).toHaveLength(3);
    expect(
      authItems
        .map((item) => item.details?.profileId)
        .toSorted((left, right) => String(left).localeCompare(String(right))),
    ).toEqual([
      "openai-codex:account-acct_active",
      "openai-codex:account-acct_pool",
      "openai-codex:account-acct_second_pool",
    ]);

    const result = await provider.apply(ctx, plan);

    expect(result.summary.errors).toBe(0);
    const authStore = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as {
      profiles?: Record<
        string,
        { access?: string; provider?: string; refresh?: string; type?: string }
      >;
    };
    expect(authStore.profiles?.["openai-codex:account-acct_active"]).toEqual(
      expect.objectContaining({
        type: "oauth",
        provider: "openai-codex",
        access: activeAccessToken,
        refresh: "refresh-active-token",
      }),
    );
    expect(authStore.profiles?.["openai-codex:account-acct_pool"]).toEqual(
      expect.objectContaining({
        type: "oauth",
        provider: "openai-codex",
        access: poolAccessToken,
        refresh: "refresh-pool-token",
      }),
    );
    expect(authStore.profiles?.["openai-codex:account-acct_second_pool"]).toEqual(
      expect.objectContaining({
        type: "oauth",
        provider: "openai-codex",
        access: secondPoolAccessToken,
        refresh: "refresh-second-pool-token",
      }),
    );
    expect(
      Object.keys(config.auth?.profiles ?? {}).toSorted((left, right) => left.localeCompare(right)),
    ).toEqual([
      "openai-codex:account-acct_active",
      "openai-codex:account-acct_pool",
      "openai-codex:account-acct_second_pool",
    ]);
    expect(config.agents?.defaults?.models?.["openai/gpt-5.5"]).toEqual({});
  });

  it("does not collapse Hermes OAuth accounts that share an email", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const reportDir = path.join(root, "report");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const sharedEmail = "shared@example.com";
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: sharedEmail },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_new",
        chatgpt_plan_type: "plus",
      },
    });
    const config = {
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
      },
    } as OpenClawConfig;
    await writeFile(
      path.join(source, "auth.json"),
      JSON.stringify({
        providers: {
          "openai-codex": {
            last_refresh: new Date().toISOString(),
            tokens: {
              access_token: accessToken,
              refresh_token: "refresh-new-token",
            },
          },
        },
      }),
    );
    await writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        profiles: {
          "openai-codex:account-acct_old": {
            type: "oauth",
            provider: "openai-codex",
            access: "old-access-token",
            refresh: "old-refresh-token",
            accountId: "acct_old",
            email: sharedEmail,
          },
        },
      }),
    );

    const provider = buildHermesMigrationProvider();
    const ctx = makeContext({
      source,
      stateDir,
      workspaceDir,
      config,
      includeSecrets: true,
      reportDir,
      runtime: makeConfigRuntime(config),
    });
    const plan = await provider.plan(ctx);
    const authItem = plan.items.find((item) => item.id === "auth:openai-codex");

    expect(authItem).toEqual(
      expect.objectContaining({
        status: "planned",
        details: expect.objectContaining({
          profileId: "openai-codex:account-acct_new",
        }),
      }),
    );

    const result = await provider.apply(ctx, plan);

    expect(result.summary.errors).toBe(0);
    const authStore = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as {
      profiles?: Record<string, { access?: string; accountId?: string; email?: string }>;
    };
    expect(authStore.profiles?.["openai-codex:account-acct_old"]).toEqual(
      expect.objectContaining({
        access: "old-access-token",
        accountId: "acct_old",
        email: sharedEmail,
      }),
    );
    expect(authStore.profiles?.["openai-codex:account-acct_new"]).toEqual(
      expect.objectContaining({
        access: accessToken,
        accountId: "acct_new",
        email: sharedEmail,
      }),
    );
  });
});
