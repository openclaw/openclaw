import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import {
  authStoreMocks,
  configureProviderRoutes,
  createAutomaticSessionEntry,
  prepareCooldownAuthState,
  resolveSession,
  TEST_PRIMARY_PROFILE_ID,
  TEST_SECONDARY_PROFILE_ID,
  withAuthState,
} from "./session-override.test-support.js";

const OPENAI_MODEL_ID = "gpt-5.6-sol";
const API_PRIMARY_PROFILE_ID = "openai:api-primary";
const API_BACKUP_PROFILE_ID = "openai:api-backup";
const OAUTH_PROFILE_ID = "openai:subscription";
const ANTHROPIC_API_PROFILE_ID = "anthropic:api";
const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";

type RotationTrigger = "compaction" | "cooldown";

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

function configureAnthropicFallbackStore(): void {
  authStoreMocks.state.hasSource = true;
  authStoreMocks.state.store = {
    version: 1,
    profiles: {
      [ANTHROPIC_API_PROFILE_ID]: createApiKeyCredential("anthropic", "sk-anthropic"),
      [CLAUDE_CLI_PROFILE_ID]: {
        type: "oauth",
        provider: "claude-cli",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 60_000,
      },
    },
    order: {
      anthropic: [ANTHROPIC_API_PROFILE_ID, CLAUDE_CLI_PROFILE_ID],
    },
  };
}

function createTriggeredSessionEntry(params: {
  profileId: string;
  model: string;
  trigger: RotationTrigger;
}): SessionEntry {
  if (params.trigger === "cooldown") {
    authStoreMocks.state.store.usageStats = {
      [params.profileId]: {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
      },
    };
  }
  return createAutomaticSessionEntry({
    model: params.model,
    authProfileOverride: params.profileId,
    compactionCount: params.trigger === "compaction" ? 1 : 0,
    authProfileOverrideCompactionCount: 0,
  });
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

  it("keeps a healthy automatic fallback across compaction without a retryable preference", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      configureMixedOpenAiAuthStore();
      authStoreMocks.state.store.order = undefined;
      const cfg = {
        auth: { order: { openai: [OAUTH_PROFILE_ID, API_PRIMARY_PROFILE_ID] } },
      };
      const sessionEntry = createAutomaticSessionEntry({
        model: OPENAI_MODEL_ID,
        authProfileOverride: API_PRIMARY_PROFILE_ID,
        compactionCount: 1,
        authProfileOverrideCompactionCount: 0,
      });
      const sessionStore = { "agent:main:main": sessionEntry };

      expect(await resolveSession({ agentDir, sessionEntry, sessionStore, cfg })).toBe(
        API_PRIMARY_PROFILE_ID,
      );
      expect(sessionEntry.authProfileOverride).toBe(API_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(0);
      expect(sessionEntry.updatedAt).toBe(1);
    });
  });

  it.each([
    { trigger: "compaction", expected: API_PRIMARY_PROFILE_ID },
    { trigger: "cooldown", expected: API_BACKUP_PROFILE_ID },
  ] as const)(
    "keeps a multi-route OpenAI session on the expected profile after $trigger",
    async ({ trigger, expected }) => {
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
        const sessionEntry = createTriggeredSessionEntry({
          profileId: API_PRIMARY_PROFILE_ID,
          model: OPENAI_MODEL_ID,
          trigger,
        });
        const sessionStore = { "agent:main:main": sessionEntry };

        const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

        expect(resolved).toBe(expected);
        expect(sessionEntry.authProfileOverride).toBe(expected);
        expect(sessionEntry.authProfileOverrideSource).toBe("auto");
        expect(sessionEntry.authProfileOverrideCompactionCount).toBe(0);
      });
    },
  );

  it.each([
    { trigger: "compaction", expected: ANTHROPIC_API_PROFILE_ID },
    { trigger: "cooldown", expected: CLAUDE_CLI_PROFILE_ID },
  ] as const)(
    "retains Anthropic fallback behavior after $trigger",
    async ({ trigger, expected }) => {
      await withAuthState(async (state) => {
        const agentDir = state.agentDir();
        await fs.mkdir(agentDir, { recursive: true });
        configureAnthropicFallbackStore();
        const sessionEntry = createTriggeredSessionEntry({
          profileId: ANTHROPIC_API_PROFILE_ID,
          model: "claude-sonnet-4-6",
          trigger,
        });
        const sessionStore = { "agent:main:main": sessionEntry };

        const resolved = await resolveSession({
          provider: "anthropic",
          agentDir,
          sessionEntry,
          sessionStore,
        });

        expect(resolved).toBe(expected);
        expect(sessionEntry.authProfileOverride).toBe(expected);
        expect(sessionEntry.authProfileOverrideCompactionCount).toBe(0);
      });
    },
  );

  it("keeps a healthy profile across compaction when the provider exposes one route", async () => {
    await withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      configureMixedOpenAiAuthStore();
      configureProviderRoutes({
        provider: "openai",
        modelId: OPENAI_MODEL_ID,
        requirements: ["api-key"],
      });
      const sessionEntry = createTriggeredSessionEntry({
        profileId: API_PRIMARY_PROFILE_ID,
        model: OPENAI_MODEL_ID,
        trigger: "compaction",
      });
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBe(API_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(API_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(0);
    });
  });

  it("rotates an implicit automatic override to an auth profile that is not in cooldown", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        profileIds: [TEST_PRIMARY_PROFILE_ID, TEST_SECONDARY_PROFILE_ID],
        usageStats: { [TEST_PRIMARY_PROFILE_ID]: { cooldownUntil: Date.now() + 60_000 } },
      });
      authStoreMocks.state.store.order = undefined;
      const sessionEntry = createAutomaticSessionEntry();
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(TEST_SECONDARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
    });
  });

  it("keeps an automatic override after its auth-profile cooldown expires", async () => {
    await withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        usageStats: { [TEST_PRIMARY_PROFILE_ID]: { cooldownUntil: Date.now() - 1 } },
      });
      const sessionEntry = createAutomaticSessionEntry({ authProfileOverrideCompactionCount: 0 });
      const sessionStore = { "agent:main:main": sessionEntry };

      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBe(TEST_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
      expect(sessionEntry.updatedAt).toBe(1);
    });
  });
});
