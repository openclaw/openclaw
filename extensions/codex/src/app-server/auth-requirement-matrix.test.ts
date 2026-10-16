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
  if (kind === "none") {
    return { version: 1, profiles: {} };
  }
  if (kind === "oauth") {
    return {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "matrix-access-token",
          refresh: "matrix-refresh-token",
          expires: Date.now() + 60 * 60_000,
          accountId: "matrix-account",
        },
      },
      order: { openai: ["openai:default"] },
    };
  }
  const key = kind === "unusable" ? "" : "matrix-api-key";
  return {
    version: 1,
    profiles: {
      "openai:default": { type: "api_key", provider: "openai", key },
    },
    order: { openai: ["openai:default"] },
  };
}

/**
 * Expected handoff per cell. `prepared` names the auth material OpenClaw hands to the
 * app-server; `native` means the connection keeps whatever account its Codex home owns.
 */
type ExpectedHandoff =
  | { outcome: "prepared-api-key" }
  | { outcome: "prepared-profile" }
  | { outcome: "native"; nativeAuthProfile: boolean }
  | { outcome: "throws"; message: string };

const HANDOFF_MATRIX: [
  homeScope: CodexAppServerHomeScope,
  authRequirement: AuthRequirement,
  storedProfile: StoredProfileKind,
  expected: ExpectedHandoff,
][] = [
  // Isolated homes use the prepared Platform key even with a stored subscription.
  ["agent", "api-key", "oauth", { outcome: "prepared-api-key" }],
  ["agent", "api-key", "none", { outcome: "prepared-api-key" }],
  ["agent", "subscription", "oauth", { outcome: "prepared-profile" }],
  // A subscription selection cannot quietly downgrade to Platform billing.
  ["agent", "subscription", "api_key", { outcome: "throws", message: SUBSCRIPTION_REQUIRED_ERROR }],
  ["agent", "subscription", "none", { outcome: "throws", message: SUBSCRIPTION_REQUIRED_ERROR }],
  ["agent", undefined, "oauth", { outcome: "native", nativeAuthProfile: true }],
  ["agent", undefined, "api_key", { outcome: "native", nativeAuthProfile: false }],
  ["agent", undefined, "none", { outcome: "native", nativeAuthProfile: false }],
  // Native homes retain their own account, including unusable or absent stored credentials.
  ["user", "api-key", "oauth", { outcome: "native", nativeAuthProfile: true }],
  ["user", "subscription", "unusable", { outcome: "native", nativeAuthProfile: true }],
  ["user", undefined, "none", { outcome: "native", nativeAuthProfile: true }],
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
        agentDir: AGENT_DIR,
        homeScope,
        subscriptionProfileRequiredError: SUBSCRIPTION_REQUIRED_ERROR,
        subscriptionProfileUnusableError: SUBSCRIPTION_UNUSABLE_ERROR,
      });

      if (expected.outcome === "throws") {
        await expect(handoff).rejects.toThrow(expected.message);
        return;
      }
      const resolved = await handoff;
      if (expected.outcome === "prepared-api-key") {
        expect(resolved).toEqual({
          nativeAuthProfile: false,
          preparedAuth: { kind: "api-key", apiKey: "prepared-platform-key" },
        });
        return;
      }
      if (expected.outcome === "prepared-profile") {
        expect(resolved).toMatchObject({
          authProfileId,
          nativeAuthProfile: true,
          preparedAuth: { kind: "profile", profileId: authProfileId },
        });
        return;
      }
      expect(resolved).toEqual(
        homeScope === "user"
          ? { nativeAuthProfile: true }
          : { authProfileId, nativeAuthProfile: expected.nativeAuthProfile },
      );
      expect(resolved).not.toHaveProperty("preparedAuth");
    },
  );

  it("fails a prepared Platform route that lost its resolved key", async () => {
    await expect(
      resolveCodexAppServerPreparedAuthHandoff({
        authRequirement: "api-key",
        authProfileStore: buildStore("none"),
        agentDir: AGENT_DIR,
        homeScope: "agent",
        subscriptionProfileRequiredError: SUBSCRIPTION_REQUIRED_ERROR,
        subscriptionProfileUnusableError: SUBSCRIPTION_UNUSABLE_ERROR,
      }),
    ).rejects.toThrow("Prepared Codex API-key route is missing its resolved API key.");
  });
});

/**
 * A native-home connection reaches `applyCodexAppServerAuthProfile` with a null profile:
 * OpenClaw verifies the account it found instead of logging in over it.
 */
describe("native Codex account verification", () => {
  const NATIVE_ACCOUNT_MATRIX: {
    authRequirement: AuthRequirement;
    account: Record<string, unknown> | null;
    expected: "accepts" | "rejects";
  }[] = [
    { authRequirement: "subscription", account: { type: "chatgpt" }, expected: "accepts" },
    { authRequirement: "subscription", account: { type: "apiKey" }, expected: "rejects" },
    { authRequirement: "subscription", account: { type: "amazonBedrock" }, expected: "rejects" },
    { authRequirement: "subscription", account: null, expected: "rejects" },
    { authRequirement: "api-key", account: { type: "apiKey" }, expected: "accepts" },
    { authRequirement: "api-key", account: { type: "chatgpt" }, expected: "rejects" },
    // A native home can serve a custom model provider that reports no OpenAI account.
    // Only a positively identified ChatGPT plan is refused for a Platform route.
    { authRequirement: "api-key", account: { type: "amazonBedrock" }, expected: "accepts" },
    { authRequirement: "api-key", account: null, expected: "accepts" },
    // No prepared route means no billing class to protect; the account is not read.
    { authRequirement: undefined, account: { type: "chatgpt" }, expected: "accepts" },
  ];

  it.each(NATIVE_ACCOUNT_MATRIX)(
    "$expected authRequirement=$authRequirement against native account $account",
    async ({ authRequirement, account, expected }) => {
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
