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
import { loadAuthProfileStoreForSecretsRuntime } from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it, vi } from "vitest";
import { readCodexCliCredentialsAsync } from "./cli-credentials.js";
import { buildCodexMigrationProvider } from "./provider.js";

describe("Codex migration credential inspection and persistence", () => {
  it.each(["oauth", "api_key"])(
    "does not open native credential storage when prompting is explicitly disabled for %s",
    async (credentialKind) => {
      const fixture = await createCodexFixture();
      await writeFile(
        path.join(fixture.codexHome, "auth.json"),
        JSON.stringify({
          OPENAI_API_KEY: "fixture-uninspected-key",
          tokens: {
            access_token: fakeJwt({ exp: 2_000_000_000 }),
            refresh_token: "fixture-refresh",
          },
        }),
      );
      credentialStorage.requiredMode = "keyring";
      const plan = await buildCodexMigrationProvider().plan(
        makeContext({
          source: fixture.codexHome,
          stateDir: fixture.stateDir,
          workspaceDir: fixture.workspaceDir,
          itemKinds: ["auth"],
          includeSecrets: true,
          providerOptions: { credentialKind, allowKeychainPrompt: false },
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
    },
  );

  it.each([
    { shape: "oauth", changed: "none" },
    { shape: "mixed", changed: "none" },
    { shape: "mixed", changed: "oauth" },
    { shape: "mixed", changed: "api_key" },
  ])(
    "offers uninspected auth and applies one fresh snapshot ($shape, changed=$changed)",
    async ({ shape, changed }) => {
      const fixture = await createCodexFixture();
      const authPath = path.join(fixture.codexHome, "auth.json");
      const auth = {
        ...(shape === "oauth"
          ? { auth_mode: "chatgpt" }
          : { OPENAI_API_KEY: "fixture-consented-key" }),
        tokens: {
          access_token: fakeJwt({ exp: 2_000_000_000 }),
          refresh_token: "fixture-consented-refresh",
          account_id: "read-once-account",
        },
      };
      await writeFile(authPath, JSON.stringify(auth));
      credentialStorage.accountType = shape === "oauth" ? "chatgpt" : "apiKey";
      const ctx = makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        itemKinds: ["auth"],
        includeSecrets: false,
        providerOptions: { configPatchMode: "none" },
      });
      const provider = buildCodexMigrationProvider();
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
      expect(plan.items.map((item) => item.id)).toEqual(
        shape === "oauth" ? ["auth:openai"] : ["auth:openai", "auth:openai:api-key"],
      );
      if (changed !== "none") {
        await writeFile(
          authPath,
          JSON.stringify({
            ...auth,
            ...(changed === "api_key" ? { OPENAI_API_KEY: "fixture-changed-key" } : {}),
            ...(changed === "oauth"
              ? { tokens: { ...auth.tokens, refresh_token: "fixture-changed-refresh" } }
              : {}),
          }),
        );
      }
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
      if (shape === "mixed") {
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
      }
      expect(nativeCredentialReaderStart).toHaveBeenCalledTimes(2);
    },
  );

  it("imports only the selected API key without changing configuration", async () => {
    const fixture = await createCodexFixture();
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: "fixture-selected-key",
      }),
    );
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      itemKinds: ["auth"],
      includeSecrets: true,
      providerOptions: { credentialKind: "api_key", configPatchMode: "none" },
      config: {
        agents: { defaults: { model: { primary: "other/model" }, models: { "other/model": {} } } },
      },
    });
    const before = structuredClone(ctx.config);
    const provider = buildCodexMigrationProvider();
    const plan = await provider.plan(ctx);
    expect(plan.items.map(({ id }) => id)).toEqual(["auth:openai:api-key"]);

    const result = await provider.apply(ctx, plan);

    expect(findItem(result.items, "auth:openai:api-key").status).toBe("migrated");
    expect(loadTargetAuthStore(fixture).profiles["openai:codex-import"]).toMatchObject({
      type: "api_key",
      provider: "openai",
      key: "fixture-selected-key",
    });
    expect(ctx.config).toEqual(before);
  });

  it.each([false, true])(
    "does not persist credentials after uncertain reader cleanup (exited=%s)",
    async (exited) => {
      const fixture = await createCodexFixture();
      await writeFile(
        path.join(fixture.codexHome, "auth.json"),
        JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-selected-key" }),
      );
      const ctx = makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        itemKinds: ["auth"],
        includeSecrets: true,
        providerOptions: { credentialKind: "api_key", configPatchMode: "none" },
      });
      const provider = buildCodexMigrationProvider();
      const plan = await provider.plan(ctx);
      closeCredentialReader.mockResolvedValue({ exited, cleanup: "uncertain" });

      await expect(provider.apply(ctx, plan)).rejects.toThrow(
        "The Codex credential reader could not stop. No credential was imported.",
      );

      expect(loadTargetAuthStore(fixture).profiles["openai:codex-import"]).toBeUndefined();
    },
  );

  it.each(["changed", "cancelled"])("does not persist a %s selected import", async (change) => {
    const fixture = await createCodexFixture();
    const authPath = path.join(fixture.codexHome, "auth.json");
    await writeFile(
      authPath,
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-first-key" }),
    );
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      itemKinds: ["auth"],
      includeSecrets: true,
      providerOptions: { credentialKind: "api_key", configPatchMode: "none" },
    });
    const provider = buildCodexMigrationProvider();
    const plan = await provider.plan(ctx);
    if (change === "changed") {
      await writeFile(
        authPath,
        JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-second-key" }),
      );
      const result = await provider.apply(ctx, plan);
      expect(findItem(result.items, "auth:openai:api-key").status).toBe("skipped");
    } else {
      ctx.signal = AbortSignal.abort(new Error("Sign-in cancelled"));
      await expect(provider.apply(ctx, plan)).rejects.toThrow("Sign-in cancelled");
    }
    expect(loadTargetAuthStore(fixture).profiles["openai:codex-import"]).toBeUndefined();
  });

  it.each(["keyring", "auto", "ephemeral"])(
    "does not borrow a file key when native requirements select %s storage",
    async (mode) => {
      const fixture = await createCodexFixture();
      await writeFile(
        path.join(fixture.codexHome, "auth.json"),
        JSON.stringify({
          auth_mode: "apikey",
          OPENAI_API_KEY: "fixture-stale-file-key",
        }),
      );
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
      const fixture = await createCodexFixture();
      const access = fakeJwt({ exp: 2_000_000_000 });
      await writeFile(
        path.join(fixture.codexHome, "auth.json"),
        JSON.stringify({
          OPENAI_API_KEY: "fixture-inactive-key",
          tokens: { access_token: access, refresh_token: "fixture-legacy-refresh" },
        }),
      );
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
    const fixture = await createCodexFixture();
    const effectiveHome = path.join(fixture.root, "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", effectiveHome);
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-selected-agent-key" }),
    );
    const config: MigrationProviderContext["config"] = {
      agents: {
        defaults: { workspace: fixture.workspaceDir },
        list: [{ id: "research", agentDir: "~/research-agent" }],
      },
    };
    const provider = buildCodexMigrationProvider();
    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config,
        targetAgentId: "research",
        itemKinds: ["auth"],
        includeSecrets: true,
        providerOptions: { credentialKind: "api_key", configPatchMode: "none" },
      }),
    );

    expectRecordFields(findItem(result.items, "auth:openai:api-key"), { status: "migrated" });
    expect(
      loadAuthProfileStoreForSecretsRuntime(path.join(effectiveHome, "research-agent")).profiles[
        "openai:codex-import"
      ],
    ).toMatchObject({ type: "api_key", key: "fixture-selected-agent-key" });
    await expect(fs.access(path.join(fixture.homeDir, "research-agent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports Codex OAuth config auth profile conflicts during planning", async () => {
    const fixture = await createCodexFixture();
    const accessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_conflict",
        chatgpt_plan_type: "plus",
      },
      "https://api.openai.com/profile": {
        email: "codex@example.test",
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-conflict-token",
          account_id: "acct_conflict",
        },
      }),
    );
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
        },
      },
      auth: {
        profiles: {
          "openai:account-acct_conflict": {
            provider: "openai",
            mode: "api_key",
          },
        },
      },
    };
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
        includeSecrets: true,
      }),
    );

    expect(findItem(plan.items, "auth:openai")).toEqual(
      expect.objectContaining({
        status: "conflict",
        reason: "auth profile exists",
        details: expect.objectContaining({
          profileId: "openai:account-acct_conflict",
        }),
      }),
    );
  });

  it("reports late-created Codex API key config auth profile conflicts before writing", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-codex" }),
    );
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
        },
      },
    };
    const provider = buildCodexMigrationProvider();
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      config: configState,
      runtime: createConfigRuntime(configState),
      reportDir,
      includeSecrets: true,
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

    expect(findItem(result.items, "auth:openai:api-key")).toEqual(
      expect.objectContaining({
        status: "conflict",
        reason: "auth profile exists",
      }),
    );
    expect(loadTargetAuthStore(fixture).profiles["openai:codex-import"]).toBeUndefined();
  });

  it("skips Codex OAuth import when the source account changes after planning", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const plannedAccessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_planned",
      },
      "https://api.openai.com/profile": {
        email: "planned@example.test",
      },
    });
    const changedAccessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_changed",
      },
      "https://api.openai.com/profile": {
        email: "changed@example.test",
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: plannedAccessToken,
          refresh_token: "refresh-planned-token",
          account_id: "acct_planned",
        },
      }),
    );
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
        },
      },
    };
    const provider = buildCodexMigrationProvider();
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      config: configState,
      runtime: createConfigRuntime(configState),
      reportDir,
      includeSecrets: true,
    });
    const plan = await provider.plan(ctx);
    expect(findItem(plan.items, "auth:openai").details).toEqual(
      expect.objectContaining({
        profileId: "openai:account-acct_planned",
        sourceProfileId: "openai:account-acct_planned",
      }),
    );
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: changedAccessToken,
          refresh_token: "refresh-changed-token",
          account_id: "acct_changed",
        },
      }),
    );

    const result = await provider.apply(ctx, plan);

    expect(findItem(result.items, "auth:openai")).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "auth credential no longer present",
      }),
    );
    const authStore = loadTargetAuthStore(fixture);
    expect(authStore.profiles["openai:account-acct_planned"]).toBeUndefined();
    expect(authStore.profiles["openai:account-acct_changed"]).toBeUndefined();
    expect(configState.auth).toBeUndefined();
  });

  it("does not collapse Codex OAuth accounts that share an email", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const sharedEmail = "shared@example.com";
    const accessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_new",
        chatgpt_plan_type: "plus",
      },
      "https://api.openai.com/profile": {
        email: sharedEmail,
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-new-token",
          account_id: "acct_new",
        },
      }),
    );
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
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
        },
      },
    };
    const provider = buildCodexMigrationProvider();
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      config: configState,
      runtime: createConfigRuntime(configState),
      reportDir,
      includeSecrets: true,
    });

    const plan = await provider.plan(ctx);
    expectRecordFields(findItem(plan.items, "auth:openai"), {
      status: "planned",
    });
    expect(findItem(plan.items, "auth:openai").details).toEqual(
      expect.objectContaining({
        profileId: "openai:account-acct_new",
      }),
    );

    const result = await provider.apply(ctx, plan);

    expectRecordFields(findItem(result.items, "auth:openai"), { status: "migrated" });
    const authStore = loadTargetAuthStore(fixture);
    expect(authStore.profiles?.["openai:account-acct_old"]).toEqual(
      expect.objectContaining({
        access: "old-access-token",
        accountId: "acct_old",
        email: sharedEmail,
      }),
    );
    expect(authStore.profiles?.["openai:account-acct_new"]).toEqual(
      expect.objectContaining({
        access: accessToken,
        accountId: "acct_new",
        email: sharedEmail,
      }),
    );
  });

  it("reports Codex auth import when config update fails after profile write", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const accessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
      },
      "https://api.openai.com/profile": {
        email: "codex@example.test",
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-test-token",
          account_id: "acct_test",
        },
      }),
    );
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
        },
      },
    };
    const provider = buildCodexMigrationProvider();
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      config: configState,
      runtime: createFailingConfigRuntime(configState),
      reportDir,
      includeSecrets: true,
    });
    const plan = await provider.plan(ctx);

    const result = await provider.apply(ctx, plan);

    expectRecordFields(findItem(result.items, "auth:openai"), { status: "migrated" });
    expect(findItem(result.items, "auth:openai").details).toEqual(
      expect.objectContaining({
        configUpdated: false,
      }),
    );
    const authStore = loadTargetAuthStore(fixture);
    expect(authStore.profiles?.["openai:account-acct_test"]).toEqual(
      expect.objectContaining({
        type: "oauth",
        provider: "openai",
        access: accessToken,
      }),
    );
  });
});
