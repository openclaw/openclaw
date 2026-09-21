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
} from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
import { buildCodexMigrationProvider } from "./provider.js";

describe("Codex migration auth identity and inherited profiles", () => {
  it("does not reuse another user's OAuth profile in the same ChatGPT workspace", async () => {
    const fixture = await createCodexFixture();
    const jwt = (user: string) =>
      fakeJwt({
        exp: 2_000_000_000,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "shared-workspace",
          chatgpt_user_id: user,
        },
      });
    const existing = {
      type: "oauth" as const,
      provider: "openai",
      access: jwt("previous-user"),
      refresh: "previous-refresh",
      expires: 2_000_000_000_000,
      accountId: "shared-workspace",
    };
    upsertAuthProfile({
      profileId: "openai:account-shared-workspace",
      credential: existing,
      agentDir: targetAgentDir(fixture),
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: jwt("new-user"),
          refresh_token: "new-refresh",
          account_id: "shared-workspace",
        },
      }),
    );
    const provider = buildCodexMigrationProvider();
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      itemKinds: ["auth"],
      includeSecrets: true,
      providerOptions: { credentialKind: "oauth", configPatchMode: "none" },
    });
    const plan = await provider.plan(ctx);
    expect(findItem(plan.items, "auth:openai").status).toBe("conflict");
    await provider.apply(ctx, plan);
    expect(loadTargetAuthStore(fixture).profiles["openai:account-shared-workspace"]).toEqual(
      existing,
    );
  });

  it.each([
    {
      state: "expired",
      expires: 1_899_999_999_999,
      planStatus: "skipped",
      resultStatus: "skipped",
    },
    {
      state: "usable",
      expires: 2_000_000_000_000,
      planStatus: "planned",
      resultStatus: "migrated",
    },
    {
      state: "expires before apply",
      expires: 2_000_000_000_000,
      planStatus: "planned",
      resultStatus: "skipped",
    },
  ])(
    "preserves a same-account local OAuth profile that is $state",
    async ({ state, expires, planStatus, resultStatus }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
      try {
        const fixture = await createCodexFixture();
        credentialStorage.accountType = "chatgpt";
        const claims = {
          chatgpt_account_id: "same-account",
          chatgpt_user_id: "same-user",
        };
        const profileId = "openai:existing-account";
        const existing = {
          type: "oauth" as const,
          provider: "openai",
          access: fakeJwt({ exp: expires / 1000, "https://api.openai.com/auth": claims }),
          refresh: "old-refresh",
          expires,
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
        await writeFile(
          path.join(fixture.codexHome, "auth.json"),
          JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              access_token: fakeJwt({ exp: 2_100_000_000, "https://api.openai.com/auth": claims }),
              refresh_token: "new-native-refresh",
              account_id: "same-account",
            },
          }),
        );
        const ctx = makeContext({
          source: fixture.codexHome,
          stateDir: fixture.stateDir,
          workspaceDir: fixture.workspaceDir,
          itemKinds: ["auth"],
          includeSecrets: true,
          providerOptions: { credentialKind: "oauth", configPatchMode: "none" },
          config: {
            agents: { defaults: { model: "other/retained", workspace: fixture.workspaceDir } },
          },
        });
        const configBefore = structuredClone(ctx.config);
        const provider = buildCodexMigrationProvider();
        const plan = await provider.plan(ctx);
        expect(findItem(plan.items, "auth:openai").status).toBe(planStatus);
        if (state === "expired") {
          expect(findItem(plan.items, "auth:openai")).toMatchObject({
            reason: "existing OAuth profile requires sign-in",
            details: { credentialImportUnavailable: true },
          });
        }
        if (state === "expires before apply") {
          clock.mockReturnValue(2_000_000_000_001);
        }
        const result = await provider.apply(ctx, plan);
        expect(findItem(result.items, "auth:openai").status).toBe(resultStatus);
        expect(loadTargetAuthStore(fixture).profiles).toEqual({
          [profileId]: existing,
          "other:retained": unrelated,
        });
        expect(ctx.config).toEqual(configBefore);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(["user", "agent"] as const)(
    "preserves the configured CLI-backed profile during explicit import (homeScope=%s)",
    async (homeScope) => {
      const fixture = await createCodexFixture();
      vi.stubEnv("CODEX_HOME", fixture.codexHome);
      credentialStorage.accountType = "chatgpt";
      const access = fakeJwt({
        exp: 2_100_000_000,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "native-account",
          chatgpt_user_id: "native-user",
        },
      });
      const nativeAuth = JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: access,
          refresh_token: "native-refresh",
          account_id: "native-account",
        },
      });
      await writeFile(path.join(fixture.codexHome, "auth.json"), nativeAuth);
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
        plugins: { entries: { codex: { config: { appServer: { homeScope } } } } },
      };
      const before = structuredClone(config);
      const ctx = makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config,
        includeSecrets: true,
        itemKinds: ["auth"],
        providerOptions: { credentialKind: "oauth", configPatchMode: "none" },
      });
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
    },
  );

  it.each(["fresh install", "other source home", "missing user", "managed account"])(
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
      await writeFile(
        path.join(fixture.codexHome, "auth.json"),
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: access,
            refresh_token: "native-refresh",
            account_id: "native-account",
          },
        }),
      );
      if (scenario === "managed account") {
        upsertAuthProfile({
          profileId: "openai:managed",
          credential: {
            type: "oauth",
            provider: "openai",
            access: fakeJwt({
              exp: 2_100_000_000,
              "https://api.openai.com/auth": {
                chatgpt_account_id: "managed-account",
                chatgpt_user_id: "managed-user",
              },
            }),
            refresh: "managed-refresh",
            expires: 2_100_000_000_000,
          },
          agentDir: targetAgentDir(fixture),
        });
      }
      const ctx = makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        includeSecrets: true,
        itemKinds: ["auth"],
        providerOptions: { credentialKind: "oauth", configPatchMode: "none" },
        config: {
          agents: { defaults: { workspace: fixture.workspaceDir } },
          ...(scenario === "fresh install"
            ? {}
            : { auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } } }),
        },
      });
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
    const fixture = await createCodexFixture();
    vi.stubEnv("CODEX_HOME", fixture.codexHome);
    credentialStorage.accountType = "chatgpt";
    const access = fakeJwt({
      exp: 2_100_000_000,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "native-account",
        chatgpt_user_id: "native-user",
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: access,
          refresh_token: "native-refresh",
          account_id: "native-account",
        },
      }),
    );
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      includeSecrets: true,
      itemKinds: ["auth"],
      providerOptions: { credentialKind: "oauth", configPatchMode: "none" },
      config: {
        agents: { defaults: { workspace: fixture.workspaceDir } },
        auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
      },
    });
    const provider = buildCodexMigrationProvider();
    const plan = await provider.plan(ctx);
    expect(findItem(plan.items, "auth:openai")).toMatchObject({
      status: "planned",
      details: { profileId: "openai:default" },
    });
    const managed = {
      type: "oauth" as const,
      provider: "openai",
      access: "managed-access",
      refresh: "managed-refresh",
      expires: 2_100_000_000_000,
    };
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
    const fixture = await createCodexFixture();
    vi.stubEnv("CODEX_HOME", fixture.codexHome);
    credentialStorage.accountType = "chatgpt";
    const nativeAuth = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: fakeJwt({
          exp: 2_100_000_000,
          "https://api.openai.com/auth": {
            chatgpt_account_id: "native-account",
            chatgpt_user_id: "native-user",
          },
        }),
        refresh_token: "native-refresh",
        account_id: "native-account",
      },
    });
    await writeFile(path.join(fixture.codexHome, "auth.json"), nativeAuth);
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      includeSecrets: true,
      itemKinds: ["auth"],
      providerOptions: { credentialKind: "oauth", configPatchMode: "none" },
      config: {
        agents: { defaults: { workspace: fixture.workspaceDir } },
        auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
      },
    });
    const configBefore = structuredClone(ctx.config);
    const provider = buildCodexMigrationProvider();
    const plan = await provider.plan(ctx);
    expect(findItem(plan.items, "auth:openai")).toMatchObject({
      status: "planned",
      details: { profileId: "openai:default" },
    });
    const inherited = {
      type: "oauth" as const,
      provider: "openai",
      access: fakeJwt({
        exp: 2_100_000_000,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "shared-account",
          chatgpt_user_id: "shared-user",
        },
      }),
      refresh: "shared-refresh",
      expires: 2_100_000_000_000,
    };
    upsertAuthProfile({ profileId: "openai:default", credential: inherited });

    const result = await provider.apply(ctx, plan);

    expect(findItem(result.items, "auth:openai").status).toBe("conflict");
    clearRuntimeAuthProfileStoreSnapshots();
    expect(loadTargetAuthStore(fixture).profiles).toEqual({ "openai:default": inherited });
    await updateAuthProfileStoreWithLock({
      agentDir: targetAgentDir(fixture),
      stateDir: fixture.stateDir,
      updater: (localStore) => {
        expect(localStore.profiles).toEqual({});
        return false;
      },
    });
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
    const fixture = await createCodexFixture();
    vi.stubEnv("CODEX_HOME", fixture.codexHome);
    credentialStorage.accountType = "chatgpt";
    const access = fakeJwt({
      exp: 2_100_000_000,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "native-account",
        chatgpt_user_id: "native-user",
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: access,
          refresh_token: "native-refresh",
          account_id: "native-account",
        },
      }),
    );
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      includeSecrets: true,
      itemKinds: ["auth"],
      providerOptions: { credentialKind: "oauth", configPatchMode: "none" },
      config: {
        agents: { defaults: { workspace: fixture.workspaceDir } },
        auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
      },
    });
    const provider = buildCodexMigrationProvider();
    const plan = await provider.plan(ctx);
    expect(findItem(plan.items, "auth:openai").status).toBe("planned");
    const inherited = {
      type: "oauth" as const,
      provider: "openai",
      access,
      refresh: "shared-refresh",
      expires,
    };
    upsertAuthProfile({ profileId: "openai:default", credential: inherited });

    const result = await provider.apply(ctx, plan);

    expect(findItem(result.items, "auth:openai").status).toBe(status);
    await updateAuthProfileStoreWithLock({
      agentDir: targetAgentDir(fixture),
      stateDir: fixture.stateDir,
      updater: (localStore) => {
        expect(localStore.profiles).toEqual({});
        return false;
      },
    });
    clearRuntimeAuthProfileStoreSnapshots();
    expect(loadTargetAuthStore(fixture).profiles["openai:default"]).toMatchObject({ access });
    expect(loadAuthProfileStoreForSecretsRuntime().profiles).toEqual({
      "openai:default": inherited,
    });
  });
});
