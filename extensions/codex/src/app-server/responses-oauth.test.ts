import type { AuthProfileCredential, AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createCodexResponsesOAuth,
  fingerprintCodexResponsesOAuth,
  materializeCodexResponsesOAuthProfile,
} from "./responses-oauth.js";

const owner = vi.hoisted(() => ({
  credential: undefined as AuthProfileCredential | undefined,
  resolve: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/agent-runtime")>();
  return {
    isPendingOAuthRefreshFence: actual.isPendingOAuthRefreshFence,
    isSameOAuthRefreshGeneration: actual.isSameOAuthRefreshGeneration,
    findPersistedAuthProfileCredential: () => owner.credential,
    resolveApiKeyForProfile: owner.resolve,
  };
});
const profileId = "openai:token-sharing:test";
function credential(subject = "subject") {
  return {
    type: "oauth" as const,
    provider: "openai",
    authFlow: "chatgpt-token-sharing",
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: 1,
    issuer: "https://auth.openai.com",
    clientId: "client",
    idToken: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`,
  };
}
beforeEach(() => {
  owner.credential = credential();
  owner.resolve.mockReset();
});
function create() {
  const store: AuthProfileStore = {
    version: 1,
    profiles: { [profileId]: credential() },
    runtimePersistedProfileIds: [profileId],
  };
  return createCodexResponsesOAuth({
    profileId,
    store,
    fingerprint: fingerprintCodexResponsesOAuth(credential()),
  });
}

it("refreshes through the selected persisted OAuth owner and retains only same-subject authority", async () => {
  const auth = create();
  owner.resolve.mockImplementation(async (params) => {
    expect(params.forceRefresh).toBe(true);
    expect(params.allowProfileFallback).toBe(false);
    expect(params.profileId).toBe(profileId);
    const updated = { ...credential(), access: "rotated-access", refresh: "rotated-refresh" };
    params.validateOAuthCredential(updated);
    owner.credential = updated;
    return { apiKey: updated.access, profileId, credential: updated };
  });
  const resolved = await auth.resolve(true);
  expect(resolved.token).toBe("rotated-access");
  expect(() => resolved.assertCurrent()).not.toThrow();
  owner.credential = credential("different-subject");
  expect(() => resolved.assertCurrent()).toThrow("identity changed");
});

it.each(["deleted", "sharing-declined"])(
  "rejects a %s grant after the awaited OAuth resolution",
  async (change) => {
    const auth = create();
    owner.resolve.mockImplementation(async () => {
      owner.credential =
        change === "deleted" ? undefined : { ...credential(), authFlow: "chatgpt-identity" };
      return { apiKey: "synthetic-access", profileId, credential: credential() };
    });
    await expect(auth.resolve(false)).rejects.toThrow("subscription sharing is unavailable");
  },
);

it("does not revive a deleted persisted profile from its prepared snapshot", async () => {
  owner.credential = undefined;
  await expect(create().resolve(false)).rejects.toThrow("subscription sharing is unavailable");
  expect(owner.resolve).not.toHaveBeenCalled();
});

function pendingFence() {
  const { idToken: _idToken, ...rest } = credential();
  // Canonical v1 marker for this synthetic profile/token generation.
  return {
    ...rest,
    access:
      "openclaw-oauth-refresh-fence:v1:0123456789abcdef0123456789abcdef:access:37a0fe0429d128e8102d651fb8c78266739a4cee85cb5f6f492ebd0994b2a013",
    refresh:
      "openclaw-oauth-refresh-fence:v1:0123456789abcdef0123456789abcdef:refresh:9414cbfe06eb993dafcd4864c92b06108e31361731dbabe2f382ef2d5124209a",
    expires: 1,
  };
}

it("joins the exact persisted refresh generation and accepts its pending marker at final I/O", async () => {
  const auth = create();
  owner.credential = pendingFence();
  owner.resolve.mockImplementation(async () => {
    owner.credential = credential();
    return { apiKey: "synthetic-access", profileId, credential: credential() };
  });
  const resolved = await auth.resolve(false);
  expect(owner.resolve).toHaveBeenCalledOnce();
  owner.credential = pendingFence();
  expect(() => resolved.assertCurrent()).not.toThrow();
  owner.credential = { ...pendingFence(), refresh: pendingFence().refresh.replace(/9414/, "ffff") };
  expect(() => resolved.assertCurrent()).toThrow();
});

it("materializes a pending cold-start snapshot from the existing refresh owner's result", async () => {
  const store: AuthProfileStore = { version: 1, profiles: { [profileId]: pendingFence() } };
  owner.resolve.mockResolvedValue({
    apiKey: "synthetic-access",
    profileId,
    credential: credential(),
  });
  const materialized = await materializeCodexResponsesOAuthProfile({ profileId, store });
  expect(fingerprintCodexResponsesOAuth(materialized)).toBe(
    fingerprintCodexResponsesOAuth(credential()),
  );
  expect(store.profiles[profileId]).toEqual(credential());
});
