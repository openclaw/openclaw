import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/index.js";
import { gitCoauthorOrganizationPolicy } from "../../packages/gateway-protocol/src/schema/git-coauthor-identity.js";
import {
  captureRuntimeConfigAsyncReader,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { setUserPreferences } from "../state/user-preferences.test-support.js";
import { ensureEnterpriseGitHubProfile } from "../state/user-profile-enterprise-github-write.worker.js";
import { linkEmail, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  prepareGitCoauthorAttribution,
  resolveGitCoauthorAttribution,
} from "./git-coauthor-attribution.js";

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
const proxyCreditConfig = {
  gateway: {
    auth: {
      mode: "trusted-proxy" as const,
      trustedProxy: {
        userHeader: "x-occ-identity",
        gitCoauthor: { nameHeader: "x-coauthor-name", emailHeader: "x-coauthor-email" },
      },
    },
  },
};
const proxyCreditPolicy = gitCoauthorOrganizationPolicy(
  proxyCreditConfig.gateway.auth.trustedProxy.userHeader,
  proxyCreditConfig.gateway.auth.trustedProxy.gitCoauthor,
);
function readCredit(
  scope: ReturnType<typeof sessionScope>,
  overrides: Partial<Parameters<typeof resolveGitCoauthorAttribution>[0]> = {},
) {
  return resolveGitCoauthorAttribution({ ...scope, config: {}, ...overrides });
}
function setCredit(profileId: string, value: unknown) {
  return setUserPreferences(profileId, { [GIT_COAUTHOR_PREFERENCE_KEY]: value }, stateOptions());
}

function linkedProfile(login: string, accountId: number) {
  const email = `${login}@example.test`;
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

it("credits a non-GitHub participant's proxy pair only after saved consent", async () => {
  await withSession("proxy-pair", async (scope) => {
    const original = getRuntimeConfig();
    setRuntimeConfigSnapshot(proxyCreditConfig);
    onTestFinished(() => setRuntimeConfigSnapshot(original));
    await upsertSessionEntryCore(scope, { sessionId: "proxy-pair", updatedAt: 1 });
    const profile = ensureProfileForEmail("oidc:alice-subject", stateOptions());
    participant(scope, profile, 1);
    expect(
      setUserPreferences(
        profile.id,
        {
          "git.coauthor.organization": {
            name: "Alice Example",
            email: "alice@example.test",
            policy: proxyCreditPolicy,
          },
        },
        { ...stateOptions(), trustedProxyGitCoauthor: true },
      ),
    ).toMatchObject({ ok: true });
    expect(await readCredit(scope, { config: proxyCreditConfig })).toBeUndefined();
    setCredit(profile.id, true);
    expect(await readCredit(scope, { config: proxyCreditConfig })).toEqual({
      logins: [],
      trailers: ["Co-authored-by: Alice Example <alice@example.test>"],
    });
    const prepared = await prepareGitCoauthorAttribution({ ...scope, config: proxyCreditConfig });
    expect(prepared.isCurrent()).toBe(true);
    setUserPreferences(
      profile.id,
      {
        "git.coauthor.organization": {
          name: "Alice Example",
          email: "new@example.test",
          policy: proxyCreditPolicy,
        },
      },
      { ...stateOptions(), trustedProxyGitCoauthor: true },
    );
    expect(prepared.isCurrent()).toBe(false);
    setCredit(profile.id, false);
    expect(await readCredit(scope, { config: proxyCreditConfig })).toBeUndefined();
  });
});

it("uses configured proxy credit with GitHub fallback, ignoring arbitrary manual preferences", async () => {
  await withSession("credit-precedence", async (scope) => {
    await upsertSessionEntryCore(scope, { sessionId: "credit-precedence", updatedAt: 1 });
    const profile = linkedProfile("credit-precedence", 9537);
    participant(scope, profile, 1);
    setUserPreferences(
      profile.id,
      { "git.coauthor.identity": { name: "Personal Alice", email: "personal@example.test" } },
      stateOptions(),
    );
    expect(await readCredit(scope)).toEqual(expectedCredit([9537, "credit-precedence"]));
    const config = proxyCreditConfig;
    setUserPreferences(
      profile.id,
      {
        "git.coauthor.organization": {
          name: "Organization Alice",
          email: "work@example.test",
          policy: proxyCreditPolicy,
        },
      },
      { ...stateOptions(), trustedProxyGitCoauthor: true },
    );
    // Imported addresses never inherit GitHub's default-on consent.
    expect(await readCredit(scope, { config })).toBeUndefined();
    setCredit(profile.id, true);
    expect((await readCredit(scope, { config }))?.logins).toEqual(["credit-precedence"]);
    expect((await readCredit(scope, { config }))?.trailers).toEqual([
      "Co-authored-by: Organization Alice <work@example.test>",
    ]);
    expect(await readCredit(scope)).toEqual(expectedCredit([9537, "credit-precedence"]));
    const prepared = await prepareGitCoauthorAttribution({ ...scope, config });
    setUserPreferences(
      profile.id,
      { "git.coauthor.organization": null },
      { ...stateOptions(), trustedProxyGitCoauthor: true },
    );
    expect(prepared.isCurrent()).toBe(false);
    expect(await readCredit(scope, { config })).toEqual(
      expectedCredit([9537, "credit-precedence"]),
    );
  });
});

it.each(["removed", "changed", "auth-mode"] as const)(
  "invalidates prepared organization credit when its proxy mapping is %s",
  async (change) => {
    await withSession(`organization-policy-${change}`, async (scope) => {
      await upsertSessionEntryCore(scope, {
        sessionId: `organization-policy-${change}`,
        updatedAt: 1,
      });
      const profile = ensureProfileForEmail(`oidc:policy-${change}`, stateOptions());
      participant(scope, profile, 1);
      setUserPreferences(
        profile.id,
        {
          "git.coauthor.organization": {
            name: "Organization Alice",
            email: "work@example.test",
            policy: proxyCreditPolicy,
          },
          "git.coauthor.enabled": true,
        },
        { ...stateOptions(), trustedProxyGitCoauthor: true },
      );
      const config = proxyCreditConfig;
      const original = getRuntimeConfig();
      try {
        setRuntimeConfigSnapshot(config);
        const prepared = await prepareGitCoauthorAttribution({ ...scope, config });
        expect(prepared.attribution?.trailers).toEqual([
          "Co-authored-by: Organization Alice <work@example.test>",
        ]);
        expect(prepared.isCurrent()).toBe(true);
        setRuntimeConfigSnapshot(
          change === "auth-mode"
            ? { gateway: { auth: { mode: "token" } } }
            : {
                gateway: {
                  auth: {
                    mode: "trusted-proxy",
                    trustedProxy: {
                      userHeader: "x-occ-identity",
                      ...(change === "changed"
                        ? {
                            gitCoauthor: {
                              nameHeader: "x-new-name",
                              emailHeader: "x-new-email",
                            },
                          }
                        : {}),
                    },
                  },
                },
              },
        );
        expect(prepared.isCurrent()).toBe(false);
        const refreshed = await prepareGitCoauthorAttribution({
          ...scope,
          config: getRuntimeConfig(),
        });
        expect(refreshed.attribution).toBeUndefined();
      } finally {
        setRuntimeConfigSnapshot(original);
      }
    });
  },
);

it("does not export unrelated shared-main participants into a Discord task's commit", async () => {
  await withSession("main", async (scope) => {
    await upsertSessionEntryCore(scope, { sessionId: "shared-discord-credit", updatedAt: 1 });
    const profiles = [
      [9101, "task-requester"],
      [9102, "unrelated-a"],
      [9103, "unrelated-b"],
    ] as const;
    const linked = profiles.map(([id, login]) => linkedProfile(login, id));
    for (const profile of linked.slice(1)) {
      participant(scope, profile, 1);
    }
    const attribution = await readCredit(scope, {
      config: { session: { groupScope: "main" } },
      requesterProfileId: linked[0]!.id,
    });
    expect(attribution).toMatchObject(expectedCredit([9101, "task-requester"]));
    expect(await readCredit(scope)).toBeUndefined();
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
    const profile = linkedProfile("ada", 20);
    participant({ ...scope, storePath }, profile, 1);

    expect(
      await readCredit(scope, {
        config,
        storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
      }),
    ).toBeUndefined();
    expect(await readCredit(scope, { config })).toEqual(expectedCredit([20, "ada"]));
  });
});

it("derives exact bounded trailers only from canonical profile-backed humans", async () => {
  await withSession("coauthors", async (scope, state) => {
    await upsertSessionEntryCore(scope, { sessionId: "coauthors", updatedAt: 1 });
    // Undefined leaves consent at its default; malformed persisted consent must not publish credit.
    for (const [login, accountId, credit, firstPrompt, repeats] of [
      ["ada", 20, true, 200, 2],
      ["grace", 10, true, 100, 1],
      ["same-time", 5, true, 100, 1],
      ["later", 1, true, 203, 1],
      ["primary", 30, true, 204, 0],
      ["opted-out", 25, false, 205, 0],
      ["defaulted", 35, undefined, 206, 0],
      ["malformed", 45, "yes", 207, 0],
    ] as const) {
      const profile = linkedProfile(login, accountId);
      if (credit !== undefined) {
        expect(setCredit(profile.id, credit)).toMatchObject({ ok: true });
      }
      participant(scope, profile, firstPrompt);
      for (let index = 0; index < repeats; index++) {
        participant(scope, profile, 400);
      }
    }
    const current = linkedProfile("current", 15);
    expect(setCredit(current.id, true)).toMatchObject({ ok: true });
    participant(scope, ensureProfileForEmail("unlinked@example.test", stateOptions()), 208);
    const legacy = ensureProfileForEmail("legacy@example.test", stateOptions());
    openOpenClawStateDatabase({ env: state.env })
      .db.prepare(
        "INSERT INTO user_profile_identities (provider, subject, profile_id, canonical_login, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("github-attribution", "40", legacy.id, "legacy", Date.now());
    participant(scope, legacy, 209);
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
      readCredit(scope, {
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
    const mergedProfile = linkedProfile("merged", 20);
    const otherProfile = linkedProfile("other", 10);
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

    expect(await readCredit(scope)).toMatchObject(expectedCredit([10, "other"], [20, "merged"]));
  });
});

it("uses current identity and consent for inherited credit without counting it twice", async () => {
  await withSession("delegated-credit", async (scope, state) => {
    const original = ensureProfileForEmail("delegation-original@example.test", stateOptions());
    const current = linkedProfile("current-contributor", 901);
    const later = linkedProfile("later-contributor", 902);
    await upsertSessionEntryCore(scope, {
      sessionId: "delegated-credit",
      updatedAt: 1,
      createdVia: "spawn",
      inheritedGitContributorProfileIds: [original.id, later.id],
    });
    participant(scope, current, 1);
    linkEmail("delegation-original@example.test", current.id, { env: state.env });
    const read = () => readCredit(scope);

    expect(await read()).toEqual(
      expectedCredit([901, "current-contributor"], [902, "later-contributor"]),
    );
    setCredit(later.id, false);
    expect((await read())?.logins).toEqual(["current-contributor"]);
    setCredit(later.id, true);
    expect((await read())?.logins).toEqual(["current-contributor", "later-contributor"]);
    expect(await readCredit(scope, { sessionId: "replaced-child" })).toBeUndefined();
  });
});

it("retains verified Enterprise account metadata when proxy credit supplies its missing email", async () => {
  await withSession("enterprise-proxy-credit", async (scope) => {
    await upsertSessionEntryCore(scope, { sessionId: "enterprise-proxy-credit", updatedAt: 1 });
    const host = "git.enterprise.example";
    const profile = ensureEnterpriseGitHubProfile(
      `github:${host}:101`,
      "Enterprise Alice",
      { login: "enterprise-alice" },
      stateOptions(),
    );
    participant(scope, profile, 1);
    setUserPreferences(
      profile.id,
      {
        "git.coauthor.organization": {
          name: "Organization Alice",
          email: "work@example.test",
          policy: proxyCreditPolicy,
        },
        "git.coauthor.enabled": true,
      },
      { ...stateOptions(), trustedProxyGitCoauthor: true },
    );
    expect(await readCredit(scope, { config: proxyCreditConfig, host })).toEqual({
      logins: ["enterprise-alice"],
      trailers: ["Co-authored-by: Organization Alice <work@example.test>"],
    });
    expect(
      await readCredit(scope, { config: proxyCreditConfig, host, excludeAccountId: 101 }),
    ).toBeUndefined();
    expect(await readCredit(scope, { host })).toBeUndefined();
  });
});
