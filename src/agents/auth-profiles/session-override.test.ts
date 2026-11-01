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
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createBedrockAwsSdkConfig } from "./config-fixtures.test-support.js";
import { authProfilesLog } from "./constants.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "./credential-fixtures.test-support.js";
import {
  authStoreMocks,
  configureProviderRoutes,
  createAutomaticSessionEntry as automaticSession,
  prepareCooldownAuthState,
  resolveSession,
  TEST_PRIMARY_PROFILE_ID as PRIMARY,
  TEST_SECONDARY_PROFILE_ID as SECONDARY,
  withAuthState,
} from "./session-override.test-support.js";

const sessionKey = "agent:main:main";
const readSession = (scope: { storePath: string }) =>
  loadSessionEntry({ ...scope, sessionKey, readConsistency: "latest" });

async function persistSession(state: OpenClawTestState, initial: SessionEntry) {
  const scope = { storePath: path.join(state.sessionsDir(), "sessions.json"), sessionKey };
  await replaceSessionEntry(scope, initial);
  const sessionEntry = readSession(scope)!;
  expect(sessionEntry).toBeDefined();
  return { ...scope, sessionEntry, sessionStore: { [sessionKey]: sessionEntry } };
}

describe("resolveSessionAuthProfileOverride", () => {
  it("returns early when no auth sources exist", () =>
    withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });

      const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1 };

      const resolved = await resolveSession({
        provider: "openrouter",
        agentDir,
        sessionEntry,
      });

      expect(resolved).toBeUndefined();
      expect(authStoreMocks.ensureAuthProfileStoreAsync).not.toHaveBeenCalled();
      await expect(fs.access(`${agentDir}/auth-profiles.json`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }));

  it.each([false, true])(
    "retains an aws-sdk pin unless its stored provider drifted: %s",
    (drifted) =>
      withAuthState(async (state) => {
        const agentDir = state.agentDir();
        await fs.mkdir(agentDir, { recursive: true });
        const profileId = "amazon-bedrock:default";
        if (drifted) {
          authStoreMocks.state.hasSource = true;
          authStoreMocks.state.store = {
            version: 1,
            profiles: { [profileId]: createApiKeyCredential("openrouter", "sk-drifted") },
          };
        }
        const sessionEntry = automaticSession({
          authProfileOverride: profileId,
          authProfileOverrideSource: "user",
        });
        const resolved = await resolveSession({
          cfg: createBedrockAwsSdkConfig(),
          provider: "amazon-bedrock",
          agentDir,
          sessionEntry,
        });
        expect(resolved).toBe(drifted ? undefined : profileId);
        expect(sessionEntry.authProfileOverride).toBe(drifted ? undefined : profileId);
        if (drifted) {
          expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
        }
      }),
  );

  it.each([
    ["rotates to an available profile", true],
    ["clears when all profiles are in cooldown", false],
  ] as const)("%s without restoring concurrent session metadata", (_label, rotates) =>
    withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        profileIds: [PRIMARY, SECONDARY],
        ...(rotates ? { usageStats: { [PRIMARY]: { cooldownUntil: Date.now() + 60_000 } } } : {}),
      });
      const session = await persistSession(
        state,
        automaticSession({
          label: "before",
          pinnedAt: 1,
          ...(rotates ? { compactionCount: 1 } : {}),
          authProfileOverrideCompactionCount: rotates ? 0 : 3,
        }),
      );
      await patchSessionEntryCore(session, () => ({ label: "renamed", pinnedAt: undefined }));
      expect(await resolveSession({ agentDir, ...session })).toBe(rotates ? SECONDARY : undefined);
      const persisted = readSession(session);
      if (rotates) {
        expect(persisted).toMatchObject({
          label: "renamed",
          authProfileOverride: SECONDARY,
          authProfileOverrideCompactionCount: 1,
        });
        expect(persisted?.pinnedAt).toBeUndefined();
      } else {
        for (const entry of [session.sessionEntry, session.sessionStore[sessionKey], persisted]) {
          expect([
            entry?.authProfileOverride,
            entry?.authProfileOverrideSource,
            entry?.authProfileOverrideCompactionCount,
          ]).toEqual([undefined, undefined, undefined]);
        }
      }
      expect(session.sessionStore[sessionKey]?.label).toBe("renamed");
      expect(session.sessionStore[sessionKey]?.pinnedAt).toBeUndefined();
    }),
  );

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
          profileIds: [PRIMARY, SECONDARY],
        });
        const latestProfileId = crossProvider ? "anthropic:manual" : SECONDARY;
        if (crossProvider) {
          authStoreMocks.state.store.profiles[latestProfileId] = createApiKeyCredential(
            "anthropic",
            "sk-anthropic",
          );
        }
        const scope = { storePath: path.join(state.sessionsDir(), "sessions.json"), sessionKey };
        let sessionEntry = automaticSession({
          label: "before",
          pinnedAt: 1,
          authProfileOverrideCompactionCount: 3,
        });
        const latestEntry: SessionEntry = {
          sessionId: "s1",
          updatedAt: 2,
          label: "manually selected",
          authProfileOverride: latestProfileId,
          authProfileOverrideSource: source,
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

        expect(resolved).toBe(crossProvider || source === "auto" ? undefined : SECONDARY);
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

  it("preserves newer in-memory session metadata when an automatic override snapshot still matches", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);
      const sessionEntry = automaticSession({ label: "stale", pinnedAt: 1 });
      const latestEntry = automaticSession({ label: "latest", pinnedAt: 2 });
      const sessionStore = { "agent:main:main": latestEntry };

      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBeUndefined();
      expect(sessionStore["agent:main:main"]).toBe(latestEntry);
      for (const entry of [sessionEntry, latestEntry]) {
        expect(entry).toMatchObject({ label: "latest", pinnedAt: 2 });
        expect(entry.authProfileOverride).toBeUndefined();
        expect(entry.authProfileOverrideSource).toBeUndefined();
      }
    }));

  it("does not recreate a concurrently deleted in-memory session", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);
      const sessionEntry = automaticSession();
      const sessionStore: Record<string, SessionEntry> = {};

      expect(await resolveSession({ agentDir, sessionEntry, sessionStore })).toBeUndefined();
      expect(Object.hasOwn(sessionStore, "agent:main:main")).toBe(false);
      expect(sessionEntry.authProfileOverride).toBe(PRIMARY);
    }));

  it("does not recreate a concurrently deleted session while clearing its automatic override", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);
      const session = await persistSession(
        state,
        automaticSession({ sessionId: "deleted-session" }),
      );
      await deleteSessionEntryLifecycle({
        archiveTranscript: false,
        storePath: session.storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });

      const resolved = await resolveSession({ agentDir, ...session });

      expect(resolved).toBeUndefined();
      expect(readSession(session)).toBeUndefined();
    }));

  it("clears an automatic override when a model-scoped cooldown also has a profile-wide disable", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        usageStats: {
          [PRIMARY]: {
            cooldownUntil: Date.now() + 60_000,
            cooldownReason: "rate_limit",
            cooldownModel: "model-x",
            disabledUntil: Date.now() + 60_000,
            disabledReason: "billing",
          },
        },
      });

      const sessionEntry = automaticSession({
        model: "model-y",
        authProfileOverrideCompactionCount: 0,
      });

      const resolved = await resolveSession({ agentDir, sessionEntry });

      expect(resolved).toBeUndefined();
      expect(sessionEntry.authProfileOverride).toBeUndefined();
      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    }));

  it("keeps an automatic pin for a sibling of a managed provider's blocked model", () =>
    withAuthState(async (state) => {
      const profileId = "openrouter:manual";
      const agentDir = await prepareCooldownAuthState(state, { profileIds: [profileId] });
      authStoreMocks.state.store = {
        version: 1,
        profiles: { [profileId]: createApiKeyCredential("openrouter", "sk-test") },
        order: { openrouter: [profileId] },
        usageStats: {
          [profileId]: {
            cooldownUntil: Date.now() + 60_000,
            cooldownReason: "rate_limit",
            blockedUntil: Date.now() + 60_000,
            blockedScope: "model",
            blockedModel: "model-x",
            blockedReason: "subscription_limit",
          },
        },
      };
      const sessionEntry = automaticSession({
        authProfileOverride: profileId,
        model: "model-y",
      });
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "openrouter", providers: ["openrouter"], managesOwnAvailability: true }],
      });
      const resolved = await withPluginMetadataSnapshotScope(
        snapshot,
        () =>
          resolveSession({
            agentDir,
            provider: "openrouter",
            sessionEntry,
            sessionStore: { "agent:main:main": sessionEntry },
          }),
        { trustConfigIdentity: true },
      );
      expect(resolved).toBe(profileId);
      expect(sessionEntry.authProfileOverride).toBe(profileId);
    }));

  it("does not persist an automatic override when every auth profile is in cooldown", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);

      const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1 };
      const sessionStore = { "agent:main:main": sessionEntry };
      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBeUndefined();
      expect(sessionEntry).toEqual({ sessionId: "s1", updatedAt: 1 });
      expect(sessionStore["agent:main:main"]).toBe(sessionEntry);
    }));

  it("does not replace a missing user override with an auth profile in cooldown", () =>
    withAuthState(async (state) => {
      const warn = vi.spyOn(authProfilesLog, "warn").mockImplementation(() => {});
      const agentDir = await prepareCooldownAuthState(state);

      const sessionEntry = automaticSession({
        authProfileOverride: "openai:missing",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 2,
      });
      const resolved = await resolveSession({ agentDir, sessionEntry });

      expect(resolved).toBe("openai:missing");
      expect(sessionEntry).toMatchObject({
        authProfileOverride: "openai:missing",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 2,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          event: "session_auth_profile_unavailable",
          profileId: "openai:missing",
        }),
      );
    }));
});

const MODEL = "gpt-5.6-sol";
const API_PRIMARY = "openai:api-primary";
const API_BACKUP = "openai:api-backup";
const OAUTH = "openai:subscription";

async function prepareMixedAuth(state: OpenClawTestState): Promise<string> {
  const agentDir = state.agentDir();
  await fs.mkdir(agentDir, { recursive: true });
  authStoreMocks.state.hasSource = true;
  authStoreMocks.state.store = {
    version: 1,
    profiles: {
      [API_PRIMARY]: createApiKeyCredential("openai", "sk-primary"),
      [API_BACKUP]: createApiKeyCredential("openai", "sk-backup"),
      [OAUTH]: createOAuthRefreshCredential(),
    },
  };
  return agentDir;
}

describe("session auth-profile rotation", () => {
  it("retries preferred OAuth after cooldown when compaction also advanced", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareMixedAuth(state);
      const cfg = { auth: { order: { openai: [OAUTH, API_PRIMARY] } } };
      configureProviderRoutes(["subscription", "api-key"]);
      authStoreMocks.state.store.usageStats = {
        [OAUTH]: {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit",
          lastRateLimitAt: Date.now(),
        },
      };
      const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1, model: MODEL };
      const sessionStore = { "agent:main:main": sessionEntry };

      expect(await resolveSession({ agentDir, sessionEntry, sessionStore, cfg })).toBe(API_PRIMARY);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");

      authStoreMocks.state.store.usageStats[OAUTH]!.cooldownUntil = Date.now() - 1;
      sessionEntry.compactionCount = 1;

      expect(await resolveSession({ agentDir, sessionEntry, sessionStore, cfg })).toBe(OAUTH);
      expect(sessionEntry.authProfileOverride).toBe(OAUTH);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(1);
    }));

  it("keeps a healthy automatic profile across compaction when auth order is implicit", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareMixedAuth(state);
      const sessionEntry = automaticSession({
        model: MODEL,
        authProfileOverride: API_PRIMARY,
        compactionCount: 1,
        authProfileOverrideCompactionCount: 0,
      });

      expect(await resolveSession({ agentDir, sessionEntry })).toBe(API_PRIMARY);
      expect(sessionEntry.authProfileOverride).toBe(API_PRIMARY);
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(0);
      expect(sessionEntry.updatedAt).toBe(1);
    }));

  it("rotates a cooled multi-route OpenAI session within its physical route", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareMixedAuth(state);
      authStoreMocks.state.store.order = { openai: [OAUTH, API_PRIMARY, API_BACKUP] };
      configureProviderRoutes(["api-key", "subscription"]);
      authStoreMocks.state.store.usageStats = {
        [API_PRIMARY]: { cooldownUntil: Date.now() + 60_000, cooldownReason: "rate_limit" },
      };
      const sessionEntry = automaticSession({
        authProfileOverride: API_PRIMARY,
        model: MODEL,
        compactionCount: 0,
        authProfileOverrideCompactionCount: 0,
      });

      const resolved = await resolveSession({ agentDir, sessionEntry });

      expect(resolved).toBe(API_BACKUP);
      expect(sessionEntry.authProfileOverride).toBe(API_BACKUP);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(0);
    }));
});
