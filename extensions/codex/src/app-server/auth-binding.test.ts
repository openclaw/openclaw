import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  fingerprintCodexAppServerAuthBinding,
  prepareCodexAppServerAuthBinding,
} from "./auth-binding.js";
import { resolveCodexAppServerPreparedAuthProfileSnapshot } from "./auth-bridge.js";

const profileId = "openai:work";
const keyRef = { source: "env", provider: "default", id: "OPENAI_WORK_KEY" } as const;
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

describe("Codex app-server auth binding", () => {
  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
  });

  it.each([true, false])(
    "binds OAuth workspace identity with stored account ID=%s without token-refresh churn",
    async (storedAccountId) => {
      const credential = (accountId: string, rotation: string) => ({
        type: "oauth" as const,
        provider: "openai",
        email: "user@example.com",
        ...(storedAccountId ? { accountId } : {}),
        access: `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.${rotation}`,
        refresh: `fake-refresh-${rotation}`,
        expires: Date.now() + 60_000,
      });
      const params = bindingParams(credential("workspace-a", "first"));
      const store = params.authProfileStore;
      const prepared = await prepareCodexAppServerAuthBinding(params);
      const first = prepared?.fingerprint;
      expect(first).toEqual(expect.any(String));
      store.profiles[profileId] = credential("workspace-a", "rotated");
      expect(await fingerprintCodexAppServerAuthBinding(params)).toBe(first);
      store.profiles[profileId] = credential("workspace-b", "replacement");
      expect(await fingerprintCodexAppServerAuthBinding(params)).not.toBe(first);
      expect(
        await fingerprintCodexAppServerAuthBinding({
          ...params,
          authProfileStore: prepared!.authProfileStore,
        }),
      ).toBe(first);
    },
  );

  it("names a repair when a selected profile cannot resolve credentials", async () => {
    await expect(
      prepareCodexAppServerAuthBinding(bindingParams({ type: "api_key", provider: "openai" })),
    ).rejects.toThrow(/could not resolve.*[Rr]epair/);
  });

  it.each(["api_key", "token"] as const)(
    "prepares %s login only when the selected request config owns the profile",
    async (type) => {
      const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "workspace-a" } })).toString("base64url")}.signature`;
      const params = bindingParams(
        type === "api_key"
          ? { type, provider: "openai", key: "work-key" }
          : { type, provider: "openai", token },
      );
      const snapshot = (provider: string) =>
        resolveCodexAppServerPreparedAuthProfileSnapshot({
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

  it("uses the materialized runtime SecretRef snapshot and fingerprints the executed store", async () => {
    const params = {
      ...bindingParams({ type: "api_key", provider: "openai", keyRef }),
      config: authConfig("openai", "api_key"),
    };
    const store = params.authProfileStore;
    const publishRuntimeKey = (key: string) =>
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir: params.agentDir,
          store: storeWith({ type: "api_key", provider: "openai", keyRef, key }),
        },
      ]);
    publishRuntimeKey("work-key-a");

    const prepared = await prepareCodexAppServerAuthBinding(params);
    expect(prepared?.authProfileStore).not.toBe(store);
    expect(prepared?.authProfileStore.profiles[profileId]).toEqual({
      type: "api_key",
      provider: "openai",
      key: "work-key-a",
    });
    expect(store.profiles[profileId]).toEqual({
      type: "api_key",
      provider: "openai",
      keyRef,
    });
    expect(await fingerprintCodexAppServerAuthBinding(params)).toBe(prepared?.fingerprint);

    publishRuntimeKey("work-key-b");
    expect(await fingerprintCodexAppServerAuthBinding(params)).not.toBe(prepared?.fingerprint);
  });
});
