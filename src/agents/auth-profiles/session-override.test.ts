import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createBedrockAwsSdkConfig } from "./config-fixtures.test-support.js";
import { authProfilesLog } from "./constants.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import {
  authStoreMocks,
  configureProviderRoutes,
  createAuthStoreWithProfiles,
  createAutomaticSessionEntry,
  prepareCooldownAuthState,
  resolveSession,
  TEST_PRIMARY_PROFILE_ID,
  TEST_SECONDARY_PROFILE_ID,
  withAuthState,
} from "./session-override.test-support.js";

describe("resolveSessionAuthProfileOverride", () => {
  it("returns early when no auth sources exist", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSession({
        cfg: {} as OpenClawConfig,
        provider: "openrouter",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBeUndefined();
      expect(authStoreMocks.ensureAuthProfileStore).not.toHaveBeenCalled();
      try {
        await fs.access(`${agentDir}/auth-profiles.json`);
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
        return;
      }
      throw new Error("Expected auth-profiles.json to be absent");
    });
  });

  it("keeps config-only aws-sdk user overrides", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = false;
      authStoreMocks.state.store = { version: 1, profiles: {} };

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "amazon-bedrock:default",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSession({
        cfg: createBedrockAwsSdkConfig(),
        provider: "amazon-bedrock",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBe("amazon-bedrock:default");
      expect(sessionEntry.authProfileOverride).toBe("amazon-bedrock:default");
    });
  });

  it("clears aws-sdk config override when stored profile drifted to another provider", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          "amazon-bedrock:default": createApiKeyCredential("openrouter", "sk-drifted"),
        },
      });

      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: Date.now(),
        authProfileOverride: "amazon-bedrock:default",
        authProfileOverrideSource: "user",
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSession({
        cfg: createBedrockAwsSdkConfig(),
        provider: "amazon-bedrock",
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:main",
        storePath: undefined,
        isNewSession: false,
      });

      expect(resolved).toBeUndefined();
      expect(sessionEntry.authProfileOverride).toBeUndefined();
      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    });
  });

  it("rotates unavailable auth state without restoring concurrent session management fields", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          [TEST_PRIMARY_PROFILE_ID]: createApiKeyCredential("openai", "sk-primary"),
          [TEST_SECONDARY_PROFILE_ID]: createApiKeyCredential("openai", "sk-secondary"),
        },
        order: {
          openai: [TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID],
        },
      });
      authStoreMocks.isProfileInCooldown.mockImplementation(
        (_store, profileId) => profileId === TEST_PRIMARY_PROFILE_ID,
      );

      const sessionKey = "agent:main:main";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { storePath, sessionKey };
      await replaceSessionEntry(scope, {
        sessionId: "s1",
        updatedAt: 1,
        label: "before",
        pinnedAt: 1,
        compactionCount: 1,
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 0,
      });
      const sessionEntry = loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(sessionEntry).toBeDefined();
      const sessionStore = { [sessionKey]: sessionEntry! };

      await patchSessionEntryCore(scope, () => ({ label: "renamed", pinnedAt: undefined }));
      const resolved = await resolveSession({
        agentDir,
        sessionEntry: sessionEntry!,
        sessionStore,
        sessionKey,
        storePath,
      });

      expect(resolved).toBe(TEST_SECONDARY_PROFILE_ID);
      const persisted = loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(persisted?.label).toBe("renamed");
      expect(persisted?.pinnedAt).toBeUndefined();
      expect(persisted?.authProfileOverride).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(persisted?.authProfileOverrideCompactionCount).toBe(1);
      expect(sessionStore[sessionKey]?.label).toBe("renamed");
      expect(sessionStore[sessionKey]?.pinnedAt).toBeUndefined();
    });
  });

  it("clears a persisted automatic override when every auth profile is in cooldown", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        profileIds: [TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID],
      });

      const sessionKey = "agent:main:main";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { storePath, sessionKey };
      await replaceSessionEntry(scope, {
        sessionId: "s1",
        updatedAt: 1,
        label: "before",
        pinnedAt: 1,
        authProfileOverride: TEST_PRIMARY_PROFILE_ID,
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 3,
      });
      const sessionEntry = loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(sessionEntry).toBeDefined();
      const sessionStore = { [sessionKey]: sessionEntry! };
      await patchSessionEntryCore(scope, () => ({ label: "renamed", pinnedAt: undefined }));

      const resolved = await resolveSession({
        agentDir,
        sessionEntry: sessionEntry!,
        sessionStore,
        sessionKey,
        storePath,
      });

      expect(resolved).toBeUndefined();
      for (const entry of [
        sessionEntry,
        sessionStore[sessionKey],
        loadSessionEntry({ ...scope, readConsistency: "latest" }),
      ]) {
        expect(entry?.authProfileOverride).toBeUndefined();
        expect(entry?.authProfileOverrideSource).toBeUndefined();
        expect(entry?.authProfileOverrideCompactionCount).toBeUndefined();
      }
      expect(sessionStore[sessionKey]?.label).toBe("renamed");
      expect(sessionStore[sessionKey]?.pinnedAt).toBeUndefined();
    });
  });

  it.each([
    ["persisted", true, false, "user"],
    ["in-memory", false, false, "user"],
    ["persisted cross-provider", true, true, "user"],
    ["persisted automatic", true, false, "auto"],
  ] as const)(
    "preserves a newer %s override against an obsolete automatic clear",
    async (_label, persisted, crossProvider, source) => {
      await withAuthState(async (state) => {
        const agentDir = await prepareCooldownAuthState(state, {
          profileIds: [TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID],
        });
        const latestProfileId = crossProvider ? "anthropic:manual" : TEST_SECONDARY_PROFILE_ID;
        if (crossProvider) {
          authStoreMocks.state.store.profiles[latestProfileId] = createApiKeyCredential(
            "anthropic",
            "sk-anthropic",
          );
        }
        const sessionKey = "agent:main:main";
        const scope = { storePath: path.join(state.sessionsDir(), "sessions.json"), sessionKey };
        let sessionEntry = createAutomaticSessionEntry({
          label: "before",
          pinnedAt: 1,
          authProfileOverrideCompactionCount: 3,
        });
        const latestEntry: SessionEntry = {
          sessionId: "s1",
          updatedAt: 2,
          label: "manually selected",
          authProfileOverride: latestProfileId,
          ...(source ? { authProfileOverrideSource: source } : {}),
        };
        if (persisted) {
          await replaceSessionEntry(scope, sessionEntry);
          sessionEntry = loadSessionEntry({ ...scope, readConsistency: "latest" })!;
          await patchSessionEntryCore(scope, () => ({
            ...latestEntry,
            authProfileOverrideSource: source,
            pinnedAt: undefined,
            authProfileOverrideCompactionCount: undefined,
          }));
        }
        const sessionStore = { [sessionKey]: persisted ? sessionEntry : latestEntry };
        const resolved = await resolveSession({
          agentDir,
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath: persisted ? scope.storePath : undefined,
        });

        expect(resolved).toBe(
          crossProvider || source === "auto" ? undefined : TEST_SECONDARY_PROFILE_ID,
        );
        const entries = [sessionEntry, sessionStore[sessionKey]];
        if (persisted) {
          entries.push(loadSessionEntry({ ...scope, readConsistency: "latest" })!);
        }
        latestEntry.updatedAt = sessionStore[sessionKey].updatedAt;
        for (const entry of entries) {
          expect(entry).toMatchObject(latestEntry);
          expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
          expect(entry.pinnedAt).toBeUndefined();
        }
      });
    },
  );

  it("preserves newer in-memory session metadata when an automatic override snapshot still matches", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);
      const sessionEntry = createAutomaticSessionEntry({ label: "stale", pinnedAt: 1 });
      const latestEntry = createAutomaticSessionEntry({ label: "latest", pinnedAt: 2 });
      const sessionStore = { "agent:main:main": latestEntry };

      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBeUndefined();
      expect(sessionStore["agent:main:main"]).toBe(latestEntry);
      for (const entry of [sessionEntry, latestEntry]) {
        expect(entry.label).toBe("latest");
        expect(entry.pinnedAt).toBe(2);
        expect(entry.authProfileOverride).toBeUndefined();
        expect(entry.authProfileOverrideSource).toBeUndefined();
      }
    });
  });

  it("does not recreate a concurrently deleted in-memory session", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);
      const sessionEntry = createAutomaticSessionEntry();
      const sessionStore: Record<string, SessionEntry> = {};

      expect(await resolveSession({ agentDir, sessionEntry, sessionStore })).toBeUndefined();
      expect(Object.hasOwn(sessionStore, "agent:main:main")).toBe(false);
      expect(sessionEntry.authProfileOverride).toBe(TEST_PRIMARY_PROFILE_ID);
    });
  });

  it("does not recreate a concurrently deleted session while clearing its automatic override", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);
      const sessionKey = "agent:main:main";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { storePath, sessionKey };
      await replaceSessionEntry(
        scope,
        createAutomaticSessionEntry({ sessionId: "deleted-session" }),
      );
      const sessionEntry = loadSessionEntry({ ...scope, readConsistency: "latest" })!;
      const sessionStore = { [sessionKey]: sessionEntry };
      await deleteSessionEntryLifecycle({
        archiveTranscript: false,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });

      const resolved = await resolveSession({
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });

      expect(resolved).toBeUndefined();
      expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toBeUndefined();
    });
  });

  it("clears an automatic override when a model-scoped cooldown also has a profile-wide disable", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        usageStats: {
          [TEST_PRIMARY_PROFILE_ID]: {
            cooldownUntil: Date.now() + 60_000,
            cooldownReason: "rate_limit",
            cooldownModel: "model-x",
            disabledUntil: Date.now() + 60_000,
            disabledReason: "billing",
          },
        },
      });

      const sessionEntry = createAutomaticSessionEntry({
        model: "model-y",
        authProfileOverrideCompactionCount: 0,
      });
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBeUndefined();
      expect(sessionEntry.authProfileOverride).toBeUndefined();
      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    });
  });

  it("does not persist an automatic override when every auth profile is in cooldown", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);

      const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1 };
      const sessionStore = { "agent:main:main": sessionEntry };
      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBeUndefined();
      expect(sessionEntry).toEqual({ sessionId: "s1", updatedAt: 1 });
      expect(sessionStore["agent:main:main"]).toBe(sessionEntry);
    });
  });

  it.each([
    { name: "missing", profile: undefined },
    {
      name: "provider-mismatched",
      profile: { type: "api_key" as const, provider: "anthropic", key: "sk-mismatched" },
    },
  ])(
    "does not replace a $name user override with an auth profile in cooldown",
    async ({ profile }) => {
      await withAuthState(async (state) => {
        const warn = profile
          ? undefined
          : vi.spyOn(authProfilesLog, "warn").mockImplementation(() => {});
        const agentDir = await prepareCooldownAuthState(state);
        if (profile) {
          authStoreMocks.state.store.profiles["anthropic:stale"] = profile;
        }

        const sessionEntry: SessionEntry = {
          sessionId: "s1",
          updatedAt: 1,
          authProfileOverride: profile ? "anthropic:stale" : "openai:missing",
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: 2,
        };
        const sessionStore = { "agent:main:main": sessionEntry };
        const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

        const expectedProfile = profile ? undefined : "openai:missing";
        expect(resolved).toBe(expectedProfile);
        expect(sessionEntry.authProfileOverride).toBe(expectedProfile);
        expect(sessionEntry.authProfileOverrideSource).toBe(profile ? undefined : "user");
        expect(sessionEntry.authProfileOverrideCompactionCount).toBe(profile ? undefined : 2);
        if (!profile) {
          expect(warn).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
              event: "session_auth_profile_unavailable",
              profileId: "openai:missing",
            }),
          );
        }
      });
    },
  );
});

const OPENAI_MODEL_ID = "gpt-5.6-sol";
const API_PRIMARY_PROFILE_ID = "openai:api-primary";
const API_BACKUP_PROFILE_ID = "openai:api-backup";
const OAUTH_PROFILE_ID = "openai:subscription";

function configureMixedOpenAiAuthStore(): void {
  authStoreMocks.state.hasSource = true;
  authStoreMocks.state.store = {
    version: 1,
    profiles: {
      [API_PRIMARY_PROFILE_ID]: createApiKeyCredential("openai", "sk-primary"),
      [API_BACKUP_PROFILE_ID]: createApiKeyCredential("openai", "sk-backup"),
      [OAUTH_PROFILE_ID]: {
        type: "oauth",
        provider: "openai",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 60_000,
      },
    },
    order: {
      openai: [API_PRIMARY_PROFILE_ID, OAUTH_PROFILE_ID, API_BACKUP_PROFILE_ID],
    },
  };
}

describe("session auth-profile rotation", () => {
  it("retries preferred OAuth after cooldown when compaction also advanced", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      configureMixedOpenAiAuthStore();
      authStoreMocks.state.store.order = undefined;
      const cfg = {
        auth: { order: { openai: [OAUTH_PROFILE_ID, API_PRIMARY_PROFILE_ID] } },
      };
      configureProviderRoutes({
        provider: "openai",
        modelId: OPENAI_MODEL_ID,
        requirements: ["subscription", "api-key"],
      });
      authStoreMocks.state.store.usageStats = {
        [OAUTH_PROFILE_ID]: {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit",
          failureCounts: { rate_limit: 1 },
        },
      };
      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: 1,
        model: OPENAI_MODEL_ID,
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      expect(await resolveSession({ agentDir, sessionEntry, sessionStore, cfg })).toBe(
        API_PRIMARY_PROFILE_ID,
      );
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");

      authStoreMocks.state.store.usageStats[OAUTH_PROFILE_ID] = {
        cooldownUntil: Date.now() - 1,
        cooldownReason: "rate_limit",
        failureCounts: { rate_limit: 1 },
      };
      sessionEntry.compactionCount = 1;

      expect(await resolveSession({ agentDir, sessionEntry, sessionStore, cfg })).toBe(
        OAUTH_PROFILE_ID,
      );
      expect(sessionEntry.authProfileOverride).toBe(OAUTH_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(1);
    });
  });

  it("keeps a healthy automatic profile across compaction when auth order is implicit", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      configureMixedOpenAiAuthStore();
      authStoreMocks.state.store.order = undefined;
      const sessionEntry = createAutomaticSessionEntry({
        model: OPENAI_MODEL_ID,
        authProfileOverride: API_PRIMARY_PROFILE_ID,
        compactionCount: 1,
        authProfileOverrideCompactionCount: 0,
      });
      const sessionStore = { "agent:main:main": sessionEntry };

      expect(await resolveSession({ agentDir, sessionEntry, sessionStore })).toBe(
        API_PRIMARY_PROFILE_ID,
      );
      expect(sessionEntry.authProfileOverride).toBe(API_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(0);
      expect(sessionEntry.updatedAt).toBe(1);
    });
  });

  it("rotates a cooled multi-route OpenAI session within its physical route", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      configureMixedOpenAiAuthStore();
      authStoreMocks.state.store.order = {
        openai: [OAUTH_PROFILE_ID, API_PRIMARY_PROFILE_ID, API_BACKUP_PROFILE_ID],
      };
      configureProviderRoutes({
        provider: "openai",
        modelId: OPENAI_MODEL_ID,
        requirements: ["api-key", "subscription"],
      });
      authStoreMocks.state.store.usageStats = {
        [API_PRIMARY_PROFILE_ID]: {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit",
        },
      };
      authStoreMocks.isProfileInCooldown.mockImplementation(
        (_store, profileId) => profileId === API_PRIMARY_PROFILE_ID,
      );
      const sessionEntry = createAutomaticSessionEntry({
        authProfileOverride: API_PRIMARY_PROFILE_ID,
        model: OPENAI_MODEL_ID,
        compactionCount: 0,
        authProfileOverrideCompactionCount: 0,
      });
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBe(API_BACKUP_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(API_BACKUP_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(0);
    });
  });
});
