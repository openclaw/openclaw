import { afterEach, describe, expect, it } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/index.js";
import {
  MAX_SESSION_PARTICIPANTS,
  recordSessionParticipant,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { setUserPreferences } from "../state/user-preferences.js";
import { ensureProfileForEmail, linkEmail, syncGitHubIdentity } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGitCoauthorAttribution } from "./git-coauthor-attribution.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("Git co-author attribution", () => {
  it("resolves credit from the configured templated session store", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:custom-store-credit";
      const scope = { agentId: "main", env: state.env, sessionKey };
      const storePath = state.statePath("custom-store", "main", "sessions.json");
      const config = {
        session: { store: state.statePath("custom-store", "{agentId}", "sessions.json") },
      };
      const entry = { sessionId: "custom-store-credit", updatedAt: 1 };
      await upsertSessionEntryCore(scope, entry);
      await upsertSessionEntryCore({ ...scope, storePath }, entry);
      const profile = ensureProfileForEmail("ada@example.test", { env: state.env });
      syncGitHubIdentity(
        {
          identity: { accountId: 20, login: "ada" },
          authenticationAlias: { kind: "email", email: "ada@example.test" },
        },
        { env: state.env },
      );
      recordSessionParticipant(
        { ...scope, storePath },
        { identity: { type: "profile", id: profile.id }, promptedAt: 1, sessionAgentId: "main" },
      );

      expect(
        resolveGitCoauthorAttribution({
          ...scope,
          config,
          storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
        }),
      ).toBeUndefined();
      expect(resolveGitCoauthorAttribution({ ...scope, config })).toEqual({
        logins: ["ada"],
        trailers: ["Co-authored-by: ada <20+ada@users.noreply.github.com>"],
      });
    });
  });

  it.each(["unresolved", "opted-out", "primary-author"] as const)(
    "returns undefined when the only participant is %s",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const sessionKey = "agent:main:no-coauthors";
        const scope = { agentId: "main", env: state.env, sessionKey };
        await upsertSessionEntryCore(scope, { sessionId: "no-coauthors", updatedAt: 1 });
        const profile = ensureProfileForEmail("solo@example.test", { env: state.env });
        if (kind !== "unresolved") {
          syncGitHubIdentity(
            {
              identity: { accountId: 20, login: "solo" },
              authenticationAlias: { kind: "email", email: "solo@example.test" },
            },
            { env: state.env },
          );
        }
        if (kind === "opted-out") {
          setUserPreferences(
            profile.id,
            { [GIT_COAUTHOR_PREFERENCE_KEY]: false },
            { env: state.env },
          );
        }
        recordSessionParticipant(scope, {
          identity: { type: "profile", id: kind === "unresolved" ? "missing-profile" : profile.id },
          promptedAt: 1,
          sessionAgentId: "main",
        });

        expect(
          resolveGitCoauthorAttribution({
            ...scope,
            config: {
              tools: {
                github: {
                  profileId: "ghp_11111111111111111111111111111111",
                  gitAuthor: { email: "20+solo@users.noreply.github.com" },
                },
              },
            },
            storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
          }),
        ).toBeUndefined();
      });
    },
  );

  it("derives exact bounded trailers only from canonical profile-backed humans", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:coauthors";
      // "default" writes no preference row: credit is on unless the person opts out.
      const profile = (
        email: string,
        accountId?: number,
        login?: string,
        credit: "on" | "off" | "default" | "malformed" = "on",
      ) => {
        const value = ensureProfileForEmail(email, { env: state.env });
        if (accountId && login) {
          syncGitHubIdentity(
            {
              identity: { accountId, login },
              authenticationAlias: { kind: "email", email },
            },
            { env: state.env },
          );
          if (credit !== "default") {
            expect(
              setUserPreferences(
                value.id,
                // The preference API persists arbitrary JSON, so a non-boolean row is a
                // reachable state that must not read as consent to publish a trailer.
                { [GIT_COAUTHOR_PREFERENCE_KEY]: credit === "malformed" ? "yes" : credit === "on" },
                { env: state.env },
              ),
            ).toMatchObject({ ok: true });
          }
        }
        return value;
      };
      const ada = profile("ada@example.test", 20, "ada");
      const grace = profile("grace@example.test", 10, "grace");
      const sameTime = profile("same-time@example.test", 5, "same-time");
      const later = profile("later@example.test", 1, "later");
      const primary = profile("primary@example.test", 30, "primary");
      const current = profile("current@example.test", 15, "current");
      const optedOut = profile("opted-out@example.test", 25, "opted-out", "off");
      const defaulted = profile("defaulted@example.test", 35, "defaulted", "default");
      const malformed = profile("malformed@example.test", 45, "malformed", "malformed");
      const unlinked = profile("unlinked@example.test");
      const legacy = ensureProfileForEmail("legacy@example.test", { env: state.env });
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare(
          "INSERT INTO user_profile_identities (provider, subject, profile_id, canonical_login, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("github-attribution", "40", legacy.id, "legacy", Date.now());
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "coauthors", updatedAt: 1 });
      for (const [index, participant] of [
        ada,
        grace,
        sameTime,
        later,
        primary,
        optedOut,
        defaulted,
        malformed,
        unlinked,
        legacy,
      ].entries()) {
        recordSessionParticipant(scope, {
          identity: { type: "profile", id: participant.id },
          promptedAt: participant === grace || participant === sameTime ? 100 : 200 + index,
          sessionAgentId: "main",
        });
      }
      for (const participant of [ada, ada, grace, sameTime, later]) {
        recordSessionParticipant(scope, {
          identity: { type: "profile", id: participant.id },
          promptedAt: 400,
          sessionAgentId: "main",
        });
      }
      recordSessionParticipant(scope, {
        identity: {
          type: "observation",
          pluginId: "discord",
          accountId: null,
          senderKind: "unknown",
          id: current.id,
        },
        promptedAt: 1,
        sessionAgentId: "main",
      });
      recordSessionParticipant(scope, {
        identity: { type: "agent", id: "helper" },
        sessionAgentId: "main",
      });

      const attribution = resolveGitCoauthorAttribution({
        agentId: "main",
        config: {
          tools: {
            github: {
              profileId: "ghp_11111111111111111111111111111111",
              gitAuthor: {
                email: "30+primary@users.noreply.github.com",
              },
            },
          },
        },
        env: state.env,
        sessionKey,
        storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      });
      const structured = resolveGitCoauthorAttribution({
        agentId: "main",
        config: {
          tools: {
            github: {
              profileId: "ghp_11111111111111111111111111111111",
              gitAuthor: { email: "custom-author@example.test" },
            },
          },
        },
        excludeAccountId: 30,
        env: state.env,
        sessionKey,
        storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      });

      const personalPublisher = resolveGitCoauthorAttribution({
        agentId: "main",
        config: {
          tools: {
            github: {
              profileId: "ghp_11111111111111111111111111111111",
              gitAuthor: { email: "30+primary@users.noreply.github.com" },
            },
          },
        },
        excludeAccountId: 20,
        env: state.env,
        sessionKey,
        storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      });
      expect(personalPublisher?.trailers).toContain(
        "Co-authored-by: primary <30+primary@users.noreply.github.com>",
      );
      expect(personalPublisher?.trailers).not.toContain(
        "Co-authored-by: ada <20+ada@users.noreply.github.com>",
      );

      expect(attribution).toEqual(structured);
      expect(structured).toMatchObject({
        logins: ["ada", "same-time", "grace", "later", "defaulted"],
        trailers: [
          "Co-authored-by: ada <20+ada@users.noreply.github.com>",
          "Co-authored-by: same-time <5+same-time@users.noreply.github.com>",
          "Co-authored-by: grace <10+grace@users.noreply.github.com>",
          "Co-authored-by: later <1+later@users.noreply.github.com>",
          "Co-authored-by: defaulted <35+defaulted@users.noreply.github.com>",
        ],
      });
    });
  });

  it("combines historical profile contributions under one verified GitHub account", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:merged-coauthors";
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "merged-coauthors", updatedAt: 1 });
      const oldProfile = ensureProfileForEmail("old@example.test", { env: state.env });
      const mergedProfile = ensureProfileForEmail("merged@example.test", { env: state.env });
      const otherProfile = ensureProfileForEmail("other@example.test", { env: state.env });

      for (const [profile, accountId, login, email] of [
        [mergedProfile, 20, "merged", "merged@example.test"],
        [otherProfile, 10, "other", "other@example.test"],
      ] as const) {
        syncGitHubIdentity(
          { identity: { accountId, login }, authenticationAlias: { kind: "email", email } },
          { env: state.env },
        );
        setUserPreferences(profile.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: true }, { env: state.env });
      }
      for (const [profile, promptedAt] of [
        [oldProfile, 10],
        [oldProfile, 20],
        [mergedProfile, 30],
        [mergedProfile, 40],
        [otherProfile, 50],
        [otherProfile, 60],
        [otherProfile, 70],
      ] as const) {
        recordSessionParticipant(scope, {
          identity: { type: "profile", id: profile.id },
          promptedAt,
          sessionAgentId: "main",
        });
      }
      recordSessionParticipant(scope, {
        identity: { type: "profile", id: otherProfile.id },
        promptedAt: 80,
      });
      // A contaminated historical time stays unknown even after profile aliases merge.
      openOpenClawAgentDatabase({ agentId: "main", env: state.env })
        .db.prepare(
          "UPDATE session_participants SET first_prompted_at = NULL, last_prompted_at = NULL WHERE actor_id = ?",
        )
        .run(oldProfile.id);
      linkEmail("old@example.test", mergedProfile.id, { env: state.env });

      expect(
        resolveGitCoauthorAttribution({
          agentId: "main",
          config: {},
          env: state.env,
          sessionKey,
        }),
      ).toMatchObject({
        logins: ["other", "merged"],
        trailers: [
          "Co-authored-by: other <10+other@users.noreply.github.com>",
          "Co-authored-by: merged <20+merged@users.noreply.github.com>",
        ],
      });
    });
  });

  it("ignores legacy membership and credits only recorded profiles", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:legacy-coauthors";
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "legacy-coauthors", updatedAt: 1 });
      recordSessionParticipant(scope, {
        identity: { type: "legacy", actorType: "human", source: null, id: "unknown" },
      });
      const current = ensureProfileForEmail("current@example.test", { env: state.env });
      syncGitHubIdentity(
        {
          identity: { accountId: 99, login: "current" },
          authenticationAlias: { kind: "email", email: "current@example.test" },
        },
        { env: state.env },
      );
      expect(resolveGitCoauthorAttribution({ ...scope, config: {} })).toBeUndefined();

      recordSessionParticipant(scope, {
        identity: { type: "profile", id: current.id },
        promptedAt: 1,
        sessionAgentId: "main",
      });
      expect(resolveGitCoauthorAttribution({ ...scope, config: {} })).toEqual({
        logins: ["current"],
        trailers: ["Co-authored-by: current <99+current@users.noreply.github.com>"],
      });
    });
  });

  it("bounds credit to recorded participants", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:coauthor-cap";
      const scope = { agentId: "main", env: state.env, sessionKey };
      await upsertSessionEntryCore(scope, { sessionId: "coauthor-cap", updatedAt: 1 });
      for (let index = 0; index <= MAX_SESSION_PARTICIPANTS; index += 1) {
        const email = `person-${index}@example.test`;
        const profile = ensureProfileForEmail(email, { env: state.env });
        syncGitHubIdentity(
          {
            identity: { accountId: index + 1, login: `person-${index}` },
            authenticationAlias: { kind: "email", email },
          },
          { env: state.env },
        );
        recordSessionParticipant(scope, {
          identity: { type: "profile", id: profile.id },
          promptedAt: index + 1,
          sessionAgentId: "main",
        });
      }
      const attribution = resolveGitCoauthorAttribution({ ...scope, config: {} });

      expect(attribution?.trailers).toHaveLength(MAX_SESSION_PARTICIPANTS);
      expect(attribution?.logins).toHaveLength(MAX_SESSION_PARTICIPANTS);
      expect(attribution?.logins).not.toContain(`person-${MAX_SESSION_PARTICIPANTS}`);
    });
  });
});
