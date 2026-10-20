// Codex tests protect native-home ownership and prepared billing routes.
import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  applyCodexAppServerAuthProfile,
  resolveCodexAppServerPreparedAuthHandoff,
} from "./auth-bridge.js";
import type { CodexAppServerHomeScope } from "./config-contracts.js";

const AGENT_DIR = "/tmp/openclaw-codex-auth-matrix";
const SUBSCRIPTION_REQUIRED_ERROR = "subscription profile required";
const SUBSCRIPTION_UNUSABLE_ERROR = "subscription profile unusable";

type StoredProfileKind = "oauth" | "api_key" | "unusable" | "none";
type AuthRequirement = "subscription" | "api-key" | undefined;

function buildStore(kind: StoredProfileKind): AuthProfileStore {
  const credential =
    kind === "oauth"
      ? {
          type: "oauth" as const,
          provider: "openai",
          access: "matrix-access-token",
          refresh: "matrix-refresh-token",
          expires: Date.now() + 60 * 60_000,
          accountId: "matrix-account",
        }
      : {
          type: "api_key" as const,
          provider: "openai",
          key: kind === "unusable" ? "" : "matrix-api-key",
        };
  return {
    version: 1,
    profiles: kind === "none" ? {} : { "openai:default": credential },
    ...(kind === "none" ? {} : { order: { openai: ["openai:default"] } }),
  };
}

const handoffDefaults = {
  agentDir: AGENT_DIR,
  subscriptionProfileRequiredError: SUBSCRIPTION_REQUIRED_ERROR,
  subscriptionProfileUnusableError: SUBSCRIPTION_UNUSABLE_ERROR,
};

const preparedKey = {
  nativeAuthProfile: false,
  preparedAuth: { kind: "api-key", apiKey: "prepared-platform-key" },
};
const preparedProfile = expect.objectContaining({
  authProfileId: "openai:default",
  nativeAuthProfile: true,
  preparedAuth: expect.objectContaining({ kind: "profile", profileId: "openai:default" }),
});
const nativeProfile = (nativeAuthProfile: boolean) => ({
  authProfileId: "openai:default",
  nativeAuthProfile,
});
const nativeHome = { nativeAuthProfile: true };
const HANDOFF_MATRIX: [
  CodexAppServerHomeScope,
  AuthRequirement,
  StoredProfileKind,
  Record<string, unknown> | string,
][] = [
  ["agent", "api-key", "oauth", preparedKey],
  ["agent", "api-key", "none", preparedKey],
  ["agent", "subscription", "oauth", preparedProfile],
  ["agent", "subscription", "api_key", SUBSCRIPTION_REQUIRED_ERROR],
  ["agent", "subscription", "none", SUBSCRIPTION_REQUIRED_ERROR],
  ["agent", undefined, "oauth", nativeProfile(true)],
  ["agent", undefined, "api_key", nativeProfile(false)],
  ["agent", undefined, "none", { authProfileId: undefined, nativeAuthProfile: false }],
  // Native homes retain their account even with unusable or absent stored credentials.
  ["user", "api-key", "oauth", nativeHome],
  ["user", "subscription", "unusable", nativeHome],
  ["user", undefined, "none", nativeHome],
];

describe("Codex app-server auth requirement matrix", () => {
  it.each(HANDOFF_MATRIX)(
    "resolves homeScope=%s authRequirement=%s storedProfile=%s",
    async (homeScope, authRequirement, storedProfile, expected) => {
      const authProfileStore = buildStore(storedProfile);
      const authProfileId = storedProfile === "none" ? undefined : "openai:default";
      const handoff = resolveCodexAppServerPreparedAuthHandoff({
        ...(authRequirement ? { authRequirement } : {}),
        resolvedApiKey: "prepared-platform-key",
        ...(authProfileId ? { authProfileId } : {}),
        authProfileStore,
        ...handoffDefaults,
        homeScope,
      });

      if (typeof expected === "string") {
        await expect(handoff).rejects.toThrow(expected);
      } else {
        const resolved = await handoff;
        expect(resolved).toEqual(expected);
        if (homeScope === "user" || authRequirement === undefined) {
          expect(resolved).not.toHaveProperty("preparedAuth");
        }
      }
    },
  );

  it("fails a prepared Platform route that lost its resolved key", async () => {
    await expect(
      resolveCodexAppServerPreparedAuthHandoff({
        authRequirement: "api-key",
        authProfileStore: buildStore("none"),
        ...handoffDefaults,
        homeScope: "agent",
      }),
    ).rejects.toThrow("Prepared Codex API-key route is missing its resolved API key.");
  });
});

// Native homes verify their existing account without logging in over it.
describe("native Codex account verification", () => {
  const NATIVE_ACCOUNT_MATRIX: [AuthRequirement, string | null, "accepts" | "rejects"][] = [
    ["subscription", "chatgpt", "accepts"],
    ["subscription", "apiKey", "rejects"],
    ["subscription", "amazonBedrock", "rejects"],
    ["subscription", null, "rejects"],
    ["api-key", "apiKey", "accepts"],
    ["api-key", "chatgpt", "rejects"],
    // Custom providers need not report an OpenAI account.
    ["api-key", "amazonBedrock", "accepts"],
    ["api-key", null, "accepts"],
    [undefined, "chatgpt", "accepts"],
  ];

  it.each(NATIVE_ACCOUNT_MATRIX)(
    "authRequirement=%s native account=%s %s",
    async (authRequirement, accountType, expected) => {
      const account = accountType === null ? null : { type: accountType };
      const request = vi.fn(async (_method: string, _params?: unknown) => ({ account }));
      const apply = applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir: AGENT_DIR,
        authProfileId: null,
        ...(authRequirement ? { authRequirement } : {}),
      });

      if (expected === "rejects") {
        await expect(apply).rejects.toMatchObject({ status: 401 });
      } else {
        await expect(apply).resolves.toBeUndefined();
      }
      expect(
        request.mock.calls.map(([method, requestParams]) => ({ method, params: requestParams })),
      ).toEqual(
        authRequirement ? [{ method: "account/read", params: { refreshToken: false } }] : [],
      );
    },
  );
});
