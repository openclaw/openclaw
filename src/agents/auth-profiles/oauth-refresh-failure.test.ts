import { expect, it } from "vitest";
import { formatErrorMessage } from "../../infra/errors.js";
import { formatInlineCodeSpan } from "../../shared/markdown-code.js";
import { FailoverError } from "../failover-error.js";
import { createOAuthRefreshCredential as credential } from "./credential-fixtures.test-support.js";
import {
  buildAuthProfileUnusableHint,
  buildOAuthRefreshFailureLoginCommand,
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureError,
  isTransientOAuthRefreshFailure,
  OAuthManagerRefreshError,
  OAuthRefreshFailureError,
} from "./oauth-refresh-failure.js";
const refreshProfileId = "openai:oauth";
const secrets = (prefix: string) => ({
  access: `${prefix}-access`,
  refresh: `${prefix}-refresh`,
  idToken: `${prefix}-id-token`,
});
const presentation = {
  errorType: "invalid_request_error",
  reason: "refresh_token_reused",
  status: 401,
  summary: "refresh rejected abc123456",
};
const access = "sk-oauthreviewredaction1234567890zzzz";
const refresh = "ya29.oauthreviewredaction1234567890yyyy";
const login = "openclaw models auth login --provider";
const claudeLogin = `claude auth login && ${login} anthropic --method cli`;
const reauth = (command: string) => `Re-authenticate with \`${command}\`.`;
const openaiLogin = `${login} openai --profile-id 'openai:default'`;
const claudeProfileLogin = `${claudeLogin} --profile-id 'anthropic:claude-cli'`;
const anthropicLogin = `${login} anthropic --profile-id 'anthropic:api-key'`;
const geminiRecovery =
  "Gemini CLI OAuth cannot be repaired by OpenClaw. Connect Google with an AI Studio API key using `openclaw models auth login --provider google`, then select that Google profile for the Gemini CLI runtime.";
const refreshMessage = (message: string) => `OAuth token refresh failed for openai: ${message}`;
const oauthMessageCase = (message: string, reason: string, command?: string) =>
  [refreshMessage(message), { provider: "openai", reason }, command] as const;
it("redacts stored, attempted, overlapping and token-shaped secrets before public serialization", () => {
  const attempted = { ...secrets("attempt"), access: "abc123" };
  const stored = secrets("store");
  const tokens = [
    access,
    refresh,
    "abc123456",
    ...Object.values(attempted),
    ...Object.values(stored),
  ];
  const cause = Object.assign(
    new Error(`refresh rejected ${tokens.join(" ")}`, {
      cause: new Error(`nested failure ${access}`),
    }),
    { oauthRefreshFailure: presentation },
  );
  const error = new OAuthManagerRefreshError({
    credential: credential({ access, refresh, idToken: "abc123456" }),
    attemptedCredentials: [credential(attempted)],
    profileId: refreshProfileId,
    refreshedStore: { version: 1, profiles: { [refreshProfileId]: credential(stored) } },
    cause,
  });
  const serialized = JSON.stringify(error);
  expect(serialized).toContain("openai");
  expect(serialized).toContain(refreshProfileId);
  for (const message of [error.message, formatErrorMessage(error.cause), serialized]) {
    expect(message).toContain("refresh rejected");
    for (const secret of [...tokens, "sk-oau", "zzzz", "ya29.o", "yyyy", "[redacted]456"]) {
      expect(message).not.toContain(secret);
    }
    expect(message.match(/\[redacted\]/g)?.length).toBe(10);
  }
  expect(error).toMatchObject({ ...presentation, summary: "refresh rejected [redacted]" });
});

it.each([
  ["openai", "auth", "openai:default", reauth(openaiLogin)],
  ["claude-cli", "session_expired", "anthropic:claude-cli", reauth(claudeProfileLogin)],
  ["anthropic", "auth", "anthropic:api-key", reauth(anthropicLogin)],
  ["google-gemini-cli", "session_expired", "google-gemini-cli:legacy", geminiRecovery],
] as const)(
  "gives provider-specific recovery guidance for %s / %s",
  (provider, reason, profileId, expected) => {
    expect(buildAuthProfileUnusableHint({ kind: "cooldown", reason, provider, profileId })).toBe(
      expected,
    );
  },
);

it.each([
  ["openai", "Work Profile", `${login} openai --profile-id 'Work Profile'`],
  ["openai", "openai:work`slot", `${login} openai --profile-id 'openai:work\`slot'`],
] as const)("quotes recovery commands for %s / %s", (provider, profileId, expected) => {
  const command = buildOAuthRefreshFailureLoginCommand(provider, { profileId });
  expect(command).toBe(expected);
  if (profileId === "openai:work`slot") {
    expect(formatInlineCodeSpan(command)).toBe(
      "``openclaw models auth login --provider openai --profile-id 'openai:work`slot'``",
    );
  }
});

it.each([
  oauthMessageCase("invalid_grant", "invalid_grant", `${login} openai`),
  oauthMessageCase("token_invalidated. Please sign in again.", "token_invalidated"),
  oauthMessageCase("Your session ended. Please log in again.", "sign_in_again"),
  [
    "Provider claude-cli failed: Failed to authenticate. API Error: 401 Invalid authentication credentials",
    { provider: "claude-cli", reason: "revoked" },
    claudeLogin,
  ],
  ["Provider openai failed: Failed to authenticate. API Error: 401 Unauthorized", null, undefined],
] as const)("classifies only OAuth refresh display messages: %s", (message, expected, command) => {
  expect(classifyOAuthRefreshFailure(message)).toEqual(expected);
  if (command) {
    expect(buildOAuthRefreshFailureLoginCommand(expected?.provider)).toBe(command);
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
const cliError = (message: string) => new FailoverError(message, cliFailure);
const failover = (options: Partial<ConstructorParameters<typeof FailoverError>[1]>) =>
  new FailoverError("Authentication refresh failed", {
    reason: "auth_permanent",
    provider: "openai",
    ...options,
  });
const retryPresentation = (message: string, status?: number, retryable = true) =>
  Object.assign(new Error(message), { oauthRefreshFailure: { status, retryable } });

const typedIdentity = { provider: typedFailure.provider, profileId: typedFailure.profileId };
it.each(
  Object.entries({
    "failover raw-error fallback": [
      failover({
        profileId: "openai:work",
        rawError: refreshMessage("refresh_token_invalidated"),
      }),
      { provider: "openai", profileId: "openai:work", reason: "token_invalidated" },
    ],
    "structured cause before raw text": [
      failover({
        rawError: refreshMessage("refresh_token_reused"),
        cause: new OAuthRefreshFailureError({
          ...typedFailure,
          ...diagnostics,
          message: "wrapped provider failure",
        }),
      }),
      { ...typedIdentity, ...diagnostics },
    ],
    "Claude CLI 401 without provider prefix": [
      cliError("Failed to authenticate. API Error: 401 Invalid authentication credentials"),
      { provider: "claude-cli", reason: "revoked" },
    ],
    "Claude CLI logout without provider prefix": [
      cliError("Not logged in · Please run /login"),
      { provider: "claude-cli", reason: "sign_in_again" },
    ],
  } as const),
)("classifies %s", (_name, [error, expected]) => {
  expect(classifyOAuthRefreshFailureError(error)).toEqual(expected);
});

it("does not treat legacy retryable presentation as provider evidence", () => {
  expect(isTransientOAuthRefreshFailure(retryPresentation("unavailable", 503))).toBe(false);
});

const notDispatched = {
  version: 1,
  phase: "before-dispatch",
  outcome: "not-attempted",
  recovery: { kind: "later", evidence: "dispatch-not-started" },
};
const documentedUnchanged = {
  version: 1,
  phase: "token-response",
  outcome: "unchanged",
  status: 503,
  recovery: { kind: "later", evidence: "documented-nonconsuming-rejection" },
};
const withOutcome = (facts: unknown, cause?: unknown) =>
  Object.assign(new Error("synthetic provider failure", { cause }), { oauthRefreshOutcome: facts });
const unchanged = (evidence: string, status = 503) => ({
  ...documentedUnchanged,
  status,
  recovery: { kind: "later", evidence },
});
it.each([
  ["documented nonconsuming response", withOutcome(documentedUnchanged)],
  ["nested valid evidence", new Error("wrapper", { cause: withOutcome(notDispatched) })],
] as const)("accepts provider facts: %s", (_name, error) => {
  expect(isTransientOAuthRefreshFailure(error)).toBe(true);
});

it.each([
  ["client rejection", unchanged("owner-accepted-provider-retry", 401)],
  ["ordinary forbidden response", { ...documentedUnchanged, status: 403 }],
  [
    "challenge evidence cannot hide a terminal rejection",
    unchanged("verified-intermediary-challenge", 403),
    { error: "invalid_grant" },
  ],
  ["unknown version", { ...notDispatched, version: 2 }],
  ["post-success phase", { ...notDispatched, phase: "after-token-response" }],
  ["unknown outcome", { ...notDispatched, outcome: "unknown" }],
  ["malformed status", { ...notDispatched, status: "503" }],
  ["invalid status range", { ...notDispatched, status: 600 }],
  [
    "unknown recovery evidence",
    {
      ...notDispatched,
      recovery: { kind: "later", evidence: "headers-not-received" },
    },
  ],
  ["success status", { ...documentedUnchanged, status: 200 }],
  ["configuration rejection", { ...documentedUnchanged, status: 400 }],
  [
    "nested terminal reason",
    notDispatched,
    { error: { code: "invalid_grant" }, reason: "provider_error" },
  ],
  ["nested explicit veto", notDispatched, { oauthRefreshFailure: { retryable: false } }],
  ["nested client rejection", notDispatched, retryPresentation("unauthorized", 401)],
  [
    "nested post-success failure wins",
    notDispatched,
    withOutcome({ version: 1, phase: "after-token-response", outcome: "unknown" }),
  ],
] as const)("rejects provider facts: %s", (_name, facts, cause?: unknown) => {
  expect(isTransientOAuthRefreshFailure(withOutcome(facts, cause))).toBe(false);
});
