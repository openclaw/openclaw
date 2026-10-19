import type { AuthProfileCredential, AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createCodexResponsesOAuth,
  resolveCodexResponsesOAuthProfileFingerprint,
} from "./responses-oauth.js";

const owner = vi.hoisted(() => ({
  credential: undefined as AuthProfileCredential | undefined,
  resolve: vi.fn(),
  readCurrent: vi.fn<() => AuthProfileCredential | undefined>(),
}));
vi.mock("openclaw/plugin-sdk/agent-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/agent-runtime")>()),
  findPersistedAuthProfileCredentialAsync: async () => owner.credential,
  resolveApiKeyForProfile: owner.resolve,
}));
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
  owner.readCurrent.mockReset().mockImplementation(() => owner.credential);
});
const storeWith = (
  value: AuthProfileCredential = credential(),
  persisted = true,
): AuthProfileStore => ({
  version: 1,
  profiles: { [profileId]: value },
  ...(persisted && { runtimePersistedProfileIds: [profileId] }),
});
const resolved = (
  value = credential(),
  readCurrentCredential: (() => AuthProfileCredential | undefined) | null = owner.readCurrent,
) => ({
  apiKey: value.access,
  profileId,
  credential: value,
  readCurrentCredential,
});
const fingerprint = (store: AuthProfileStore) =>
  resolveCodexResponsesOAuthProfileFingerprint({ profileId, store });
async function create(store = storeWith()) {
  return createCodexResponsesOAuth({
    profileId,
    store,
    fingerprint: await fingerprint(store),
  });
}

it("refreshes through the selected persisted OAuth owner and retains only same-subject authority", async () => {
  const auth = await create();
  expect(owner.readCurrent).not.toHaveBeenCalled();
  owner.resolve.mockImplementation(async (params) => {
    expect(params).toMatchObject({ forceRefresh: true, allowProfileFallback: false, profileId });
    const updated = { ...credential(), access: "rotated-access", refresh: "rotated-refresh" };
    params.validateOAuthCredential(updated);
    owner.credential = updated;
    return resolved(updated);
  });
  const prepared = await auth.resolve(true);
  expect(prepared.token).toBe("rotated-access");
  expect(() => prepared.assertCurrent()).not.toThrow();
  owner.credential = credential("different-subject");
  expect(() => prepared.assertCurrent()).toThrow("identity changed");
});

it.each(["deleted", "sharing-declined"])(
  "rejects a %s grant after the awaited OAuth resolution",
  async (change) => {
    const auth = await create();
    owner.resolve.mockImplementation(async () => {
      owner.credential =
        change === "deleted" ? undefined : { ...credential(), authFlow: "chatgpt-identity" };
      return resolved();
    });
    const prepared = await auth.resolve(false);
    expect(() => prepared.assertCurrent()).toThrow("subscription sharing is unavailable");
  },
);

it("does not revive a deleted persisted profile from its prepared snapshot", async () => {
  owner.credential = undefined;
  await expect((await create()).resolve(false)).rejects.toThrow(
    "subscription sharing is unavailable",
  );
  expect(owner.resolve).not.toHaveBeenCalled();
});

function pendingFence() {
  const { idToken: _idToken, ...rest } = credential();
  return {
    ...rest,
    access:
      "openclaw-oauth-refresh-fence:v1:0123456789abcdef0123456789abcdef:access:37a0fe0429d128e8102d651fb8c78266739a4cee85cb5f6f492ebd0994b2a013",
    refresh:
      "openclaw-oauth-refresh-fence:v1:0123456789abcdef0123456789abcdef:refresh:9414cbfe06eb993dafcd4864c92b06108e31361731dbabe2f382ef2d5124209a",
  };
}

it("joins the exact refresh generation at final I/O", async () => {
  const auth = await create();
  owner.credential = pendingFence();
  owner.resolve.mockImplementation(async () => {
    owner.credential = credential();
    return resolved();
  });
  const prepared = await auth.resolve(false);
  expect(owner.resolve).toHaveBeenCalledOnce();
  owner.credential = pendingFence();
  expect(() => prepared.assertCurrent()).not.toThrow();
  owner.credential = {
    ...pendingFence(),
    refresh: pendingFence().refresh.replace(/9414/, "ffff"),
  };
  expect(() => prepared.assertCurrent()).toThrow();
});

it("uses only the credential owner's retained capability after preparation", async () => {
  const auth = await create();
  let current = true;
  owner.resolve.mockResolvedValue(
    resolved(credential(), () => {
      if (!current) {
        throw new Error("revoked personal authority");
      }
      return credential();
    }),
  );
  const prepared = await auth.resolve(false);
  prepared.assertCurrent();
  current = false;
  expect(() => prepared.assertCurrent()).toThrow("revoked personal authority");
  expect(owner.readCurrent).not.toHaveBeenCalled();
});

it("materializes a pending cold-start snapshot from the existing refresh owner's result", async () => {
  const store = storeWith(pendingFence(), false);
  owner.resolve.mockResolvedValue({
    apiKey: "synthetic-access",
    profileId,
    credential: credential(),
  });
  expect(await fingerprint(store)).toBe(await fingerprint(storeWith(credential(), false)));
  expect(store.profiles[profileId]).toEqual(credential());
});

it("refuses a persisted credential without retained owner authority", async () => {
  const auth = await create();
  owner.resolve.mockResolvedValue(resolved(credential(), null));
  await expect(auth.resolve(false)).rejects.toThrow("credential authority is unavailable");
});

it("keeps runtime-only credentials in memory and observes their removal", async () => {
  owner.credential = undefined;
  const store = storeWith(credential(), false);
  const auth = await create(store);
  owner.resolve.mockResolvedValue(resolved(credential(), null));
  const prepared = await auth.resolve(false);
  expect(() => prepared.assertCurrent()).not.toThrow();
  delete store.profiles[profileId];
  expect(() => prepared.assertCurrent()).toThrow("subscription sharing is unavailable");
});
