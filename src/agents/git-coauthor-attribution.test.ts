import { afterAll, beforeAll, expect, it } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/index.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { setUserPreferences } from "../state/user-preferences.test-support.js";
import { linkEmail, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveGitCoauthorAttribution } from "./git-coauthor-attribution.js";

let sharedState: OpenClawTestState;

beforeAll(async () => {
  sharedState = await createOpenClawTestState({ scenario: "minimal" });
  await captureRuntimeConfigAsyncReader()();
});

afterAll(async () => {
  await sharedState.cleanup();
});

function sessionScope(sessionKey: string) {
  return { agentId: "main", env: sharedState.env, sessionKey };
}
async function withSession<T>(
  sessionId: string,
  fn: (scope: ReturnType<typeof sessionScope>, state: OpenClawTestState) => Promise<T>,
): Promise<T> {
  const work = new AsyncWorkScope();
  try {
    const scope = sessionScope(`agent:main:${sessionId}`);
    return await work.track(() => fn(scope, sharedState));
  } finally {
    await work.drain();
  }
}

const stateOptions = () => ({ env: sharedState.env });
function setCredit(profileId: string, value: unknown) {
  return setUserPreferences(profileId, { [GIT_COAUTHOR_PREFERENCE_KEY]: value }, stateOptions());
}

function linkedProfile(email: string, accountId: number, login: string) {
  const options = stateOptions();
  const profile = ensureProfileForEmail(email, options);
  syncGitHubIdentity(
    { identity: { accountId, login }, authenticationAlias: { kind: "email", email } },
    options,
  );
  return profile;
}

function participant(
  scope: Parameters<typeof recordSessionParticipant>[0],
  profile: { id: string },
  promptedAt: number,
) {
  recordSessionParticipant(scope, {
    identity: { type: "profile", id: profile.id },
    promptedAt,
    sessionAgentId: "main",
  });
}

function expectedCredit(...accounts: [number, string][]) {
  return {
    logins: accounts.map(([, login]) => login),
    trailers: accounts.map(
      ([id, login]) => `Co-authored-by: ${login} <${id}+${login}@users.noreply.github.com>`,
    ),
  };
}

it("does not export unrelated shared-main participants into a Discord task's commit", async () => {
  await withSession("main", async (scope) => {
    await upsertSessionEntryCore(scope, { sessionId: "shared-discord-credit", updatedAt: 1 });
    const profiles = [
      { email: "task-requester@example.test", accountId: 9101, login: "task-requester" },
      { email: "unrelated-a@example.test", accountId: 9102, login: "unrelated-a" },
      { email: "unrelated-b@example.test", accountId: 9103, login: "unrelated-b" },
    ].map(({ email, accountId, login }) => linkedProfile(email, accountId, login));
    for (const profile of profiles.slice(1)) {
      participant(scope, profile, 1);
    }
    const attribution = await resolveGitCoauthorAttribution({
      ...scope,
      config: { session: { groupScope: "main" } },
      requesterProfileId: profiles[0]!.id,
    });
    expect(attribution).toMatchObject(expectedCredit([9101, "task-requester"]));
    expect(await resolveGitCoauthorAttribution({ ...scope, config: {} })).toBeUndefined();
  });
});
it("resolves credit from the configured templated session store", async () => {
  await withSession("custom-store-credit", async (scope, state) => {
    const storePath = state.statePath("custom-store", "main", "sessions.json");
    const config = {
      session: { store: state.statePath("custom-store", "{agentId}", "sessions.json") },
    };
    const entry = { sessionId: "custom-store-credit", updatedAt: 1 };
    await upsertSessionEntryCore(scope, entry);
    await upsertSessionEntryCore({ ...scope, storePath }, entry);
    const profile = linkedProfile("ada@example.test", 20, "ada");
    participant({ ...scope, storePath }, profile, 1);

    expect(
      await resolveGitCoauthorAttribution({
        ...scope,
        config,
        storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      }),
    ).toBeUndefined();
    expect(await resolveGitCoauthorAttribution({ ...scope, config })).toEqual(
      expectedCredit([20, "ada"]),
    );
  });
});

it("returns undefined when the only participant has opted out", async () => {
  await withSession("no-coauthors-opted-out", async (scope) => {
    await upsertSessionEntryCore(scope, { sessionId: "no-coauthors-opted-out", updatedAt: 1 });
    const email = "solo-opted-out@example.test";
    const profile = linkedProfile(email, 201, "solo-opted-out");
    setCredit(profile.id, false);
    participant(scope, profile, 1);

    expect(await resolveGitCoauthorAttribution({ ...scope, config: {} })).toBeUndefined();
  });
});

it("derives exact bounded trailers only from canonical profile-backed humans", async () => {
  await withSession("coauthors", async (scope, state) => {
    // "default" writes no preference row: credit is on unless the person opts out.
    const profile = (
      email: string,
      accountId?: number,
      login?: string,
      credit: "on" | "off" | "default" | "malformed" = "on",
    ) => {
      const value =
        accountId && login
          ? linkedProfile(email, accountId, login)
          : ensureProfileForEmail(email, { env: state.env });
      if (accountId && login && credit !== "default") {
        // Persisted non-booleans must not become consent to publish a trailer.
        expect(setCredit(value.id, credit === "malformed" ? "yes" : credit === "on")).toMatchObject(
          { ok: true },
        );
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
    await upsertSessionEntryCore(scope, { sessionId: "coauthors", updatedAt: 1 });
    for (const [index, contributor] of [
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
      participant(
        scope,
        contributor,
        contributor === grace || contributor === sameTime ? 100 : 200 + index,
      );
    }
    for (const contributor of [ada, ada, grace, sameTime, later]) {
      participant(scope, contributor, 400);
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

    const read = (email: string, excludeAccountId?: number) =>
      resolveGitCoauthorAttribution({
        ...scope,
        config: {
          tools: {
            github: {
              profileId: "ghp_11111111111111111111111111111111",
              gitAuthor: { email },
            },
          },
        },
        excludeAccountId,
        storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      });
    const attribution = await read("30+primary@users.noreply.github.com");
    const structured = await read("custom-author@example.test", 30);
    const personalPublisher = await read("30+primary@users.noreply.github.com", 20);
    expect(personalPublisher?.trailers).toContain(
      "Co-authored-by: primary <30+primary@users.noreply.github.com>",
    );
    expect(personalPublisher?.trailers).not.toContain(
      "Co-authored-by: ada <20+ada@users.noreply.github.com>",
    );

    expect(attribution).toEqual(structured);
    expect(structured).toMatchObject(
      expectedCredit([20, "ada"], [5, "same-time"], [10, "grace"], [1, "later"], [35, "defaulted"]),
    );
  });
});

it("combines historical profile contributions under one verified GitHub account", async () => {
  await withSession("merged-coauthors", async (scope, state) => {
    await upsertSessionEntryCore(scope, { sessionId: "merged-coauthors", updatedAt: 1 });
    const oldProfile = ensureProfileForEmail("old@example.test", { env: state.env });
    const mergedProfile = linkedProfile("merged@example.test", 20, "merged");
    const otherProfile = linkedProfile("other@example.test", 10, "other");
    setCredit(mergedProfile.id, true);
    setCredit(otherProfile.id, true);
    for (const [profile, promptedAt] of [
      [oldProfile, 10],
      [oldProfile, 20],
      [mergedProfile, 30],
      [mergedProfile, 40],
      [otherProfile, 50],
      [otherProfile, 60],
      [otherProfile, 70],
    ] as const) {
      participant(scope, profile, promptedAt);
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

    expect(await resolveGitCoauthorAttribution({ ...scope, config: {} })).toMatchObject(
      expectedCredit([10, "other"], [20, "merged"]),
    );
  });
});

it("uses current identity and consent for inherited credit without counting it twice", async () => {
  await withSession("delegated-credit", async (scope, state) => {
    const original = ensureProfileForEmail("delegation-original@example.test", {
      env: state.env,
    });
    const current = linkedProfile("delegation-current@example.test", 901, "current-contributor");
    const later = linkedProfile("delegation-later@example.test", 902, "later-contributor");
    await upsertSessionEntryCore(scope, {
      sessionId: "delegated-credit",
      updatedAt: 1,
      createdVia: "spawn",
      inheritedGitContributorProfileIds: [original.id, later.id],
    });
    participant(scope, current, 1);
    linkEmail("delegation-original@example.test", current.id, { env: state.env });
    const read = () => resolveGitCoauthorAttribution({ ...scope, config: {} });

    expect(await read()).toEqual(
      expectedCredit([901, "current-contributor"], [902, "later-contributor"]),
    );
    setCredit(later.id, false);
    expect((await read())?.logins).toEqual(["current-contributor"]);
    setCredit(later.id, true);
    expect((await read())?.logins).toEqual(["current-contributor", "later-contributor"]);
    expect(
      await resolveGitCoauthorAttribution({ ...scope, config: {}, sessionId: "replaced-child" }),
    ).toBeUndefined();
  });
});
