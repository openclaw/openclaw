import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { expect, it } from "vitest";
import {
  fingerprintCodexAppServerAuthBinding as fingerprint,
  prepareCodexAppServerAuthBinding as prepareBinding,
} from "./auth-binding.js";
import { resolveCodexAppServerPreparedAuthProfileSnapshot as prepareSnapshot } from "./auth-bridge.js";

const profileId = "openai:work";
const storeWith = (credential: AuthProfileStore["profiles"][string]): AuthProfileStore => ({
  version: 1,
  profiles: { [profileId]: credential },
});
const bindingParams = (credential: AuthProfileStore["profiles"][string]) => ({
  authProfileId: profileId,
  authProfileStore: storeWith(credential),
  agentDir: "/tmp/openclaw-codex-auth-binding",
  config: {},
});
const authConfig = (provider: string, mode: "api_key" | "token") => ({
  auth: { profiles: { [profileId]: { provider, mode } } },
});
const accessToken = (accountId: string, signature: string) =>
  `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.${signature}`;

it.each([true, false])(
  "binds OAuth workspace identity with stored account ID=%s without token-refresh churn",
  async (storedAccountId) => {
    const credential = (accountId: string, rotation: string) => ({
      type: "oauth" as const,
      provider: "openai",
      email: "user@example.com",
      ...(storedAccountId ? { accountId } : {}),
      access: accessToken(accountId, rotation),
      refresh: `fake-refresh-${rotation}`,
      expires: Date.now() + 60_000,
    });
    const original = credential("workspace-a", "first");
    const params = bindingParams(original);
    const store = params.authProfileStore;
    const prepared = await prepareBinding(params);
    const first = prepared?.fingerprint;
    expect(first).toEqual(expect.any(String));
    store.profiles[profileId] = credential("workspace-a", "rotated");
    expect(await fingerprint(params)).toBe(first);
    store.profiles[profileId] = credential("workspace-b", "replacement");
    expect(await fingerprint(params)).not.toBe(first);
    expect(prepared?.authProfileStore.profiles[profileId]).toEqual(original);
  },
);

it("names a repair when a selected profile cannot resolve credentials", async () => {
  await expect(
    prepareBinding(bindingParams({ type: "api_key", provider: "openai" })),
  ).rejects.toThrow(/could not resolve.*[Rr]epair/);
});

it.each(["api_key", "token"] as const)(
  "prepares %s login only when the selected request config owns the profile",
  async (type) => {
    const token = accessToken("workspace-a", "signature");
    const params = bindingParams(
      type === "api_key"
        ? { type, provider: "openai", key: "work-key" }
        : { type, provider: "openai", token },
    );
    const snapshot = (provider: string) =>
      prepareSnapshot({
        ...params,
        config: authConfig(provider, type),
      });
    await expect(snapshot("anthropic")).rejects.toThrow("does not contain usable credentials");
    await expect(snapshot("openai")).resolves.toMatchObject({
      loginParams:
        type === "api_key"
          ? { type: "apiKey", apiKey: "work-key" }
          : { type: "chatgptAuthTokens", accessToken: token, chatgptAccountId: "workspace-a" },
    });
  },
);
