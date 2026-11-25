import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "./credential-fixtures.test-support.js";
import {
  authStoreMocks,
  createAutomaticSessionEntry,
  resolveSession,
  resolveSessionSelection,
  TEST_PRIMARY_PROFILE_ID as PRIMARY,
  TEST_SECONDARY_PROFILE_ID as SECONDARY,
  withAuthState,
} from "./session-override.test-support.js";

const OAUTH_PROFILE_ID = "openai:subscription";

function withProfiles(run: (state: OpenClawTestState) => Promise<void>) {
  return withAuthState(async (state) => {
    authStoreMocks.state.hasSource = true;
    authStoreMocks.state.store = {
      version: 1,
      profiles: {
        [PRIMARY]: createApiKeyCredential("openai", "sk-primary"),
        [SECONDARY]: createApiKeyCredential("openai", "sk-secondary"),
        [OAUTH_PROFILE_ID]: createOAuthRefreshCredential(),
      },
      order: { openai: [PRIMARY, SECONDARY, OAUTH_PROFILE_ID] },
    };
    await run(state);
  });
}

function automatic(overrides: Partial<SessionEntry> = {}) {
  return createAutomaticSessionEntry({
    compactionCount: 0,
    authProfileOverrideCompactionCount: 0,
    ...overrides,
  });
}

async function select(
  state: OpenClawTestState,
  params: {
    sessionEntry?: SessionEntry;
    configuredProfileId?: string;
    modelId?: string;
    cfg?: OpenClawConfig;
  },
) {
  const sessionEntry = params.sessionEntry ?? { sessionId: "s1", updatedAt: 1 };
  return resolveSessionSelection({
    ...params,
    agentDir: state.agentDir(),
    sessionEntry,
    modelId: params.modelId ?? "gpt-5.6-sol",
  });
}

it("selects the configured profile after model activation", () =>
  withProfiles(async (state) => {
    await expect(
      select(state, {
        cfg: { agents: { entries: { main: { model: `openai/gpt-4.1@${SECONDARY}` } } } },
        modelId: "gpt-4.1",
        sessionEntry: automatic(),
      }),
    ).resolves.toMatchObject({ profileId: SECONDARY, source: "user" });
  }));

it("retains a removed explicit pin that also names the configured default", () =>
  withProfiles(async (state) => {
    const sessionEntry = createAutomaticSessionEntry({ authProfileOverrideSource: "user" });
    const params = { sessionEntry, configuredProfileId: PRIMARY };
    const expected = { profileId: PRIMARY, source: "user" };
    await expect(select(state, params)).resolves.toMatchObject(expected);
    delete authStoreMocks.state.store.profiles[PRIMARY];

    await expect(select(state, params)).resolves.toMatchObject(expected);
    expect(sessionEntry.authProfileOverride).toBe(PRIMARY);
  }));

it("uses only explicit configured-profile precedence", () =>
  withProfiles(async (state) => {
    const sessionEntry = automatic();

    await expect(
      select(state, { sessionEntry, modelId: `gpt-5.6-sol@${OAUTH_PROFILE_ID}` }),
    ).resolves.toMatchObject({ profileId: PRIMARY, source: "auto" });
    await expect(
      select(state, { sessionEntry, configuredProfileId: OAUTH_PROFILE_ID }),
    ).resolves.toEqual({
      profileId: OAUTH_PROFILE_ID,
      source: "user",
      routeRequirement: "subscription",
    });
  }));

it.each(["openai:removed", "amazon-bedrock:default"])(
  "rejects unavailable or incompatible selection %s",
  (profileId) =>
    withProfiles(async (state) => {
      const missing = profileId === "openai:removed";
      const cfg: OpenClawConfig = missing
        ? {}
        : {
            auth: { profiles: { [profileId]: { provider: "amazon-bedrock", mode: "aws-sdk" } } },
          };
      const expected = missing
        ? { code: "selected_auth_profile_unavailable", profileId }
        : { name: "Error", message: `Auth profile "${profileId}" is not configured for openai.` };
      await expect(select(state, { configuredProfileId: profileId, cfg })).rejects.toMatchObject(
        expected,
      );
    }),
);

it("still rotates a legacy source-less automatic pin on a new session", () =>
  withProfiles(async (state) => {
    const sessionEntry = automatic({ authProfileOverrideSource: undefined });

    const resolved = await resolveSession({
      agentDir: state.agentDir(),
      sessionEntry,
      isNewSession: true,
    });

    expect(resolved).toBe(SECONDARY);
    expect(sessionEntry).toMatchObject({
      authProfileOverride: SECONDARY,
      authProfileOverrideSource: "auto",
    });
  }));
it("clears an incompatible global pin only in the selected agent store", async () => {
  const sessionKey = "global";
  await withAuthState(async (state) => {
    const storePath = state.statePath("sessions.json");
    const mainScope = { agentId: "main", sessionKey, storePath };
    const opsScope = { agentId: "ops", sessionKey, storePath };
    await replaceSessionEntry(mainScope, {
      sessionId: "main-session",
      updatedAt: 1,
      authProfileOverride: "anthropic:main",
      authProfileOverrideSource: "user",
    });
    await replaceSessionEntry(opsScope, {
      sessionId: "ops-session",
      updatedAt: 1,
      authProfileOverride: "anthropic:ops",
      authProfileOverrideSource: "user",
    });
    const sessionEntry = expectDefined(loadSessionEntryReadOnly(opsScope), "ops session");
    const mainBefore = loadSessionEntryReadOnly(mainScope);
    authStoreMocks.state.store = {
      version: 1,
      profiles: { "anthropic:ops": createApiKeyCredential("anthropic", "sk-test") },
    };

    await resolveSessionSelection({
      agentId: "ops",
      agentDir: state.agentDir("ops"),
      provider: "openrouter",
      sessionEntry,
      sessionKey,
      storePath,
    });

    expect(loadSessionEntryReadOnly({ ...mainScope, readConsistency: "latest" })).toEqual(
      mainBefore,
    );
    const persisted = loadSessionEntryReadOnly({ ...opsScope, readConsistency: "latest" });
    expect(persisted).toMatchObject({ sessionId: "ops-session" });
    expect(persisted?.authProfileOverride).toBeUndefined();
    expect(persisted?.authProfileOverrideSource).toBeUndefined();
  });
});
