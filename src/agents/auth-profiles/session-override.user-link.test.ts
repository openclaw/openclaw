import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { applyMixedDirectives } from "../../auto-reply/reply/directive-handling.mixed-inline.test-helpers.js";
import { createModelSelectionState } from "../../auto-reply/reply/model-selection.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
  setUserProfileAuthLink,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "./credential-fixtures.test-support.js";
import { resolveSessionAuthSelection, resolveUserLinkedAuthProfile } from "./session-override.js";

// Runtime eligibility has separate owner coverage; account ownership stays real here.
vi.mock("../model-runtime-choice.js", () => ({
  preparePublishedModelRuntimeChoice: vi.fn<
    typeof import("../model-runtime-choice.js").preparePublishedModelRuntimeChoice
  >(async ({ runtimeId, preferredRuntimeId }) => ({
    kind: "ready",
    runtimeId: runtimeId ?? preferredRuntimeId ?? "codex",
    validate: () => undefined,
  })),
}));

const SHARED = "openai:shared";
const SESSION_KEY = "agent:main:main";
const modelId = "gpt-5.6-luna";
const modelSelection = () => ({ cfg: {}, agentId: "main", provider: "openai" });
const sharedSelection = { profileId: SHARED, source: "auto" };
const subscription = (profileId: string) => ({
  profileId,
  source: "user",
  routeRequirement: "subscription",
});

function session(sessionId: string, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId, updatedAt: 1, ...overrides };
}

function personal(label: string) {
  const owner = ensureProfileForEmail(`${label}@example.test`);
  return { id: owner.id, authProfileId: connectAccount(owner.id) };
}

function writeSharedAuth(state: OpenClawTestState) {
  return state.writeAuthProfiles({
    version: 1,
    profiles: { [SHARED]: createApiKeyCredential("openai", "synthetic-shared-key") },
  });
}

function connectAccount(profileId: string): string {
  return connectUserModelAccount({
    ownerProfileId: profileId,
    credential: createOAuthRefreshCredential({ expires: Date.now() + 600_000 }),
    assertCurrent() {},
  }).authProfileId;
}

async function select(
  state: OpenClawTestState,
  sessionEntry: SessionEntry,
  requesterProfileId?: string,
  isNewSession = true,
) {
  const shared = selectionParams(state, sessionEntry);
  const model = await createModelSelectionState({
    ...shared,
    agentCfg: undefined,
    defaultProvider: "openai",
    defaultModel: modelId,
    model: modelId,
    hasModelDirective: false,
  });
  return resolveSessionAuthSelection({
    ...shared,
    provider: model.provider,
    modelId: model.model,
    isNewSession,
    requesterProfileId,
  });
}

function selectionParams(state: OpenClawTestState, sessionEntry: SessionEntry) {
  return {
    ...modelSelection(),
    agentDir: state.agentDir(),
    sessionEntry,
    sessionStore: { [SESSION_KEY]: sessionEntry },
    sessionKey: SESSION_KEY,
  };
}

function withAuthState(run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ layout: "state-only", prefix: "personal-session-auth-" }, run);
}

describe("person-linked session auth", () => {
  it("reads changed personal defaults through workers without querying on the host", () =>
    withAuthState(async (state) => {
      const alice = ensureProfileForEmail("alice@example.test");
      const first = connectAccount(alice.id);
      const readLink = () =>
        resolveUserLinkedAuthProfile({
          cfg: {},
          agentDir: state.agentDir(),
          provider: "openai",
          requesterProfileId: alice.id,
        });
      expect((await readLink())?.profileId).toBe(first);
      const second = connectAccount(alice.id);
      const sql = observeHostDataSql();
      try {
        expect((await readLink())?.profileId).toBe(second);
        expect(
          sql.queries.filter((query) => /\b(?:user_profiles|secret_store_entries)\b/i.test(query)),
        ).toEqual([]);
      } finally {
        sql.restore();
      }
      clearUserProfileAuthLink({ profileId: alice.id, provider: "openai" });
      expect(await readLink()).toBeUndefined();
    }));

  it.each(
    ["owner", "another person", "unidentified"].flatMap((requester) => [
      { requester, form: "model-only", prefix: "" },
      { requester, form: "mixed", prefix: "hello " },
    ]),
  )(
    "checks credential ownership for a fresh $form personal account directive from $requester",
    async ({ requester, prefix }) => {
      await withAuthState(async (state) => {
        const alice = personal("alice");
        const bob = ensureProfileForEmail("bob@example.test");
        const personalId = alice.authProfileId;
        clearUserProfileAuthLink({ profileId: alice.id, provider: "openai" });
        const requesterProfileId =
          requester === "owner" ? alice.id : requester === "another person" ? bob.id : undefined;
        const ctx: MsgContext = {};
        if (requesterProfileId) {
          prepareSessionParticipantInput(ctx, { type: "profile", id: requesterProfileId });
        }

        const { result, sessionEntry } = await applyMixedDirectives({
          body: `${prefix}/model openai/${modelId}@${personalId}`,
          ctx,
          agentDir: state.agentDir(),
          channel: "webchat",
          provider: "openai",
          model: modelId,
          allowedModels: [{ provider: "openai", id: modelId, name: "Luna", reasoning: true }],
        });

        if (requester === "owner") {
          expect(sessionEntry, JSON.stringify(result)).toMatchObject({
            authProfileOverride: personalId,
            authProfileOverrideSource: "user",
          });
        } else {
          expect(sessionEntry.authProfileOverride).toBeUndefined();
          expect(result).toMatchObject({ kind: "reply", reply: { isError: true } });
        }
      });
    },
  );

  it("applies a personal default only to new sessions when no shared auth store exists", () =>
    withAuthState(async (state) => {
      const alice = ensureProfileForEmail("alice@example.test");
      const existing = session("existing-session");
      await expect(select(state, existing, alice.id, false)).resolves.toBeUndefined();

      const personalId = connectAccount(alice.id);
      await expect(select(state, existing, alice.id, false)).resolves.toBeUndefined();
      expect(existing.authProfileOverride).toBeUndefined();
      const sessionEntry = session("alice-session");

      await expect(select(state, sessionEntry, alice.id)).resolves.toEqual(
        subscription(personalId),
      );
      expect(sessionEntry.authProfileOverrideSource).toBe("user-link");
    }));

  it.each([
    { label: "configured default", source: undefined },
    { label: "explicit session pin", source: "user" },
    { label: "person-linked session pin", source: "user-link" },
  ] as const)("selects the $label over other personal accounts", async ({ source }) => {
    await withAuthState(async (state) => {
      const configuredId = personal("configured").authProfileId;
      const pinnedId = personal("session").authProfileId;
      const sessionEntry = session(
        "configured-personal-session",
        source ? { authProfileOverride: pinnedId, authProfileOverrideSource: source } : {},
      );

      await expect(
        resolveSessionAuthSelection({
          ...selectionParams(state, sessionEntry),
          modelId,
          configuredProfileId: configuredId,
          isNewSession: false,
        }),
      ).resolves.toEqual(subscription(source ? pinnedId : configuredId));
    });
  });

  it("keeps personal accounts out of unrelated defaults and retains pins after unlinking", () =>
    withAuthState(async (state) => {
      await writeSharedAuth(state);
      const alice = personal("alice");
      const bob = personal("bob");
      const unlinked = ensureProfileForEmail("unlinked@example.test");

      for (const requester of [undefined, unlinked.id]) {
        await expect(select(state, session(randomUUID()), requester)).resolves.toMatchObject(
          sharedSelection,
        );
      }

      const sessionEntry = session("alice-session");
      await select(state, sessionEntry, alice.id);
      clearUserProfileAuthLink({ profileId: alice.id, provider: "openai" });

      await expect(select(state, sessionEntry, bob.id, false)).resolves.toMatchObject({
        profileId: alice.authProfileId,
        source: "user",
      });
      await expect(select(state, session("new-session"), alice.id)).resolves.toMatchObject(
        sharedSelection,
      );
    }));

  it("preserves explicit shared pins and ignores invalid shared account links", () =>
    withAuthState(async (state) => {
      await writeSharedAuth(state);
      const alice = personal("alice");
      const sessionEntry = session("explicit-session", {
        authProfileOverride: SHARED,
        authProfileOverrideSource: "user",
      });
      await expect(select(state, sessionEntry, alice.id, false)).resolves.toMatchObject({
        profileId: SHARED,
        source: "user",
      });

      setUserProfileAuthLink({
        profileId: alice.id,
        provider: "openai",
        authProfileId: "openai:missing",
      });
      await expect(select(state, session("invalid-link-session"), alice.id)).resolves.toMatchObject(
        sharedSelection,
      );
    }));

  it("does not replace a missing personal pin with the next participant's account", () =>
    withAuthState(async (state) => {
      const alice = ensureProfileForEmail("alice@example.test");
      const bob = personal("bob");
      const missingId = `personal:${alice.id}:${randomUUID()}`;
      const sessionEntry = session("missing-owner-session", {
        authProfileOverride: missingId,
        authProfileOverrideSource: "user-link",
      });

      await expect(select(state, sessionEntry, bob.id, false)).rejects.toThrow(
        "personal model account is unavailable",
      );
      expect(sessionEntry.authProfileOverride).toBe(missingId);
    }));
});
