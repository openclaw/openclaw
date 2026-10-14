import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "../../infra/errors.js";
import { FailoverError } from "../failover-error.js";
import { createOAuthRefreshCredential as credential } from "./credential-fixtures.test-support.js";
import {
  buildAuthProfileUnusableHint,
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureError,
  formatOAuthRefreshFailureLoginCommandMarkdown,
  OAuthManagerRefreshError,
  OAuthRefreshFailureError,
} from "./oauth-refresh-failure.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const refreshProfileId = "openai:oauth";
const stored = credential({
  access: "store-access",
  refresh: "store-refresh",
  idToken: "store-id-token",
});
const presentation = {
  errorType: "invalid_request_error",
  reason: "refresh_token_reused",
  status: 401,
  summary: "refresh rejected error-access",
};
const access = "sk-oauthreviewredaction1234567890zzzz";
const refresh = "ya29.oauthreviewredaction1234567890yyyy";

describe("OAuthManagerRefreshError", () => {
  it.each<{
    name: string;
    cred: OAuthCredential;
    profiles: AuthProfileStore["profiles"];
    cause: Error;
    forbidden: string[];
    redactions: number;
  }>([
    {
      name: "stored and attempted secrets with structured diagnostics",
      cred: credential({
        access: "error-access",
        refresh: "error-refresh",
        idToken: "error-id-token",
      }),
      profiles: { [refreshProfileId]: stored },
      cause: Object.assign(
        new Error(
          "refresh rejected error-access error-refresh error-id-token store-access store-refresh store-id-token",
        ),
        { oauthRefreshFailure: presentation },
      ),
      forbidden: [
        "error-access",
        "error-refresh",
        "error-id-token",
        "store-access",
        "store-refresh",
        "store-id-token",
      ],
      redactions: 6,
    },
    {
      name: "token-shaped secrets before generic masking, including nested causes",
      cred: credential({ access, refresh }),
      profiles: {},
      cause: new Error(`refresh rejected ${access} ${refresh}`, {
        cause: new Error(`nested failure ${access}`),
      }),
      forbidden: [access, refresh, "sk-oau", "zzzz", "ya29.o", "yyyy"],
      redactions: 3,
    },
    {
      name: "overlapping secrets longest first",
      cred: credential({ access: "abc123", refresh: "abc123456" }),
      profiles: {},
      cause: new Error("refresh rejected abc123 abc123456"),
      forbidden: ["abc123", "abc123456", "[redacted]456"],
      redactions: 2,
    },
  ])(
    "redacts $name from public errors and serialization",
    ({ cred, profiles, cause, forbidden, redactions }) => {
      const error = new OAuthManagerRefreshError({
        credential: cred,
        profileId: refreshProfileId,
        refreshedStore: { version: 1, profiles },
        cause,
      });
      const serialized = JSON.stringify(error);
      expect(serialized).toContain("openai");
      expect(serialized).toContain(refreshProfileId);
      for (const message of [error.message, formatErrorMessage(error.cause), serialized]) {
        expect(message).toContain("refresh rejected");
        for (const secret of forbidden) {
          expect(message).not.toContain(secret);
        }
        expect(message.match(/\[redacted\]/g)?.length).toBe(redactions);
      }
      if ("oauthRefreshFailure" in cause) {
        expect(error).toMatchObject({ ...presentation, summary: "refresh rejected [redacted]" });
      }
    },
  );

  it("formats an undefined refresh failure without throwing", () => {
    const error = new OAuthManagerRefreshError({
      credential: credential({ access: "sk-nonjsonredaction1234567890zzzz" }),
      profileId: refreshProfileId,
      refreshedStore: { version: 1, profiles: {} },
      cause: undefined,
    });
    expect(error.message).toContain("OAuth token refresh failed");
  });
});

it.each([
  [
    "openai",
    "auth",
    "openai:default",
    "Re-authenticate with `openclaw models auth login --provider openai --profile-id 'openai:default'`.",
  ],
  [
    "openai",
    "auth_permanent",
    "openai:default",
    "Re-authenticate with `openclaw models auth login --provider openai --profile-id 'openai:default'`.",
  ],
  [
    "claude-cli",
    "session_expired",
    "anthropic:claude-cli",
    "Re-authenticate with `claude auth login && openclaw models auth login --provider anthropic --method cli --profile-id 'anthropic:claude-cli'`.",
  ],
  [
    "anthropic",
    "auth",
    "anthropic:api-key",
    "Re-authenticate with `openclaw models auth login --provider anthropic --profile-id 'anthropic:api-key'`.",
  ],
  [
    "google-gemini-cli",
    "session_expired",
    "google-gemini-cli:legacy",
    "Gemini CLI OAuth cannot be repaired by OpenClaw. Connect Google with an AI Studio API key using `openclaw models auth login --provider google`, then select that Google profile for the Gemini CLI runtime.",
  ],
] as const)(
  "gives provider-specific recovery guidance for %s / %s",
  (provider, reason, profileId, expected) => {
    expect(buildAuthProfileUnusableHint({ kind: "cooldown", reason, provider, profileId })).toBe(
      expected,
    );
  },
);

it.each([
  [
    "openai",
    "Work Profile",
    "openclaw models auth login --provider openai --profile-id 'Work Profile'",
  ],
  [
    "openai",
    "openai:work`slot",
    "openclaw models auth login --provider openai --profile-id 'openai:work`slot'",
  ],
] as const)("quotes recovery commands for %s / %s", (provider, profileId, expected) => {
  const command = buildOAuthRefreshFailureLoginCommand(provider, { profileId });
  expect(command).toBe(expected);
  if (profileId === "openai:work`slot") {
    expect(formatOAuthRefreshFailureLoginCommandMarkdown(command)).toBe(
      "``openclaw models auth login --provider openai --profile-id 'openai:work`slot'``",
    );
  }
});

it.each([
  [
    "OAuth token refresh failed for openai: invalid_grant",
    { provider: "openai", reason: "invalid_grant" },
    "openclaw models auth login --provider openai",
  ],
  [
    "OAuth token refresh failed for openai: token_invalidated. Please sign in again.",
    { provider: "openai", reason: "token_invalidated" },
    undefined,
  ],
  [
    "OAuth token refresh failed for openai: Your session ended. Please log in again.",
    { provider: "openai", reason: "sign_in_again" },
    undefined,
  ],
  [
    "Provider claude-cli failed: Failed to authenticate. API Error: 401 Invalid authentication credentials",
    { provider: "claude-cli", reason: "revoked" },
    "claude auth login && openclaw models auth login --provider anthropic --method cli",
  ],
  ["Provider openai failed: Failed to authenticate. API Error: 401 Unauthorized", null, undefined],
] as const)("classifies only OAuth refresh display messages: %s", (message, expected, login) => {
  expect(classifyOAuthRefreshFailure(message)).toEqual(expected);
  if (login) {
    expect(buildOAuthRefreshFailureLoginCommand(expected?.provider)).toBe(login);
  }
});

const typedFailure = {
  provider: "openai",
  profileId: "openai:user@example.com",
  message: "invalid_grant",
};
const diagnostics = {
  errorType: "invalid_grant",
  reason: "invalid_grant" as const,
  status: 401,
  summary: "Please sign in again.",
};
const cliFailure = {
  reason: "auth" as const,
  provider: "claude-cli",
  model: "claude-sonnet-4-20250514",
  status: 401,
};

it.each([
  {
    name: "typed metadata without display-message parsing",
    error: new OAuthRefreshFailureError({ ...typedFailure, ...diagnostics }),
    expected: {
      provider: typedFailure.provider,
      profileId: typedFailure.profileId,
      ...diagnostics,
    },
  },
  {
    name: "typed metadata through a wrapper cause",
    error: new Error("wrapped", { cause: new OAuthRefreshFailureError(typedFailure) }),
    expected: {
      provider: typedFailure.provider,
      profileId: typedFailure.profileId,
      reason: "invalid_grant",
    },
  },
  {
    name: "failover raw-error fallback",
    error: new FailoverError("Authentication refresh failed", {
      reason: "auth_permanent",
      provider: "openai",
      profileId: "openai:work",
      rawError: "OAuth token refresh failed for openai: refresh_token_invalidated",
    }),
    expected: { provider: "openai", profileId: "openai:work", reason: "token_invalidated" },
  },
  {
    name: "structured cause precedence over raw text",
    error: new FailoverError("Authentication refresh failed", {
      reason: "auth_permanent",
      provider: "openai",
      rawError: "OAuth token refresh failed for openai: refresh_token_reused",
      cause: new OAuthRefreshFailureError({
        provider: "openai",
        message: "wrapped provider failure",
        reason: "refresh_token_reused",
        summary: "Please sign in again.",
      }),
    }),
    expected: {
      provider: "openai",
      reason: "refresh_token_reused",
      summary: "Please sign in again.",
    },
  },
  {
    name: "structured Claude CLI 401 without a provider prefix",
    error: new FailoverError(
      "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      cliFailure,
    ),
    expected: { provider: "claude-cli", reason: "revoked" },
  },
  {
    name: "structured Claude CLI logout without a provider prefix",
    error: new FailoverError("Not logged in · Please run /login", cliFailure),
    expected: { provider: "claude-cli", reason: "sign_in_again" },
  },
])("classifies $name", ({ error, expected }) => {
  expect(classifyOAuthRefreshFailureError(error)).toEqual(expected);
});
