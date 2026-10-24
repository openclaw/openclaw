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
import type { AuthProfileStore, OAuthCredential } from "./types.js";

type Profiles = AuthProfileStore["profiles"];
const refreshProfileId = "openai:oauth";
const secrets = (prefix: string) => ({
  access: `${prefix}-access`,
  refresh: `${prefix}-refresh`,
  idToken: `${prefix}-id-token`,
});
const stored = credential(secrets("store"));
const presentation = {
  errorType: "invalid_request_error",
  reason: "refresh_token_reused",
  status: 401,
  summary: "refresh rejected error-access",
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
function managerError(cred: OAuthCredential, cause: unknown, profiles: Profiles = {}) {
  return new OAuthManagerRefreshError({
    credential: cred,
    profileId: refreshProfileId,
    refreshedStore: { version: 1, profiles },
    cause,
  });
}

it.each<[string, OAuthCredential, Error, string[], number, Profiles?]>([
  [
    "stored and attempted secrets with structured diagnostics",
    credential(secrets("error")),
    Object.assign(
      new Error(
        "refresh rejected error-access error-refresh error-id-token store-access store-refresh store-id-token",
      ),
      { oauthRefreshFailure: presentation },
    ),
    [...Object.values(secrets("error")), ...Object.values(secrets("store"))],
    6,
    { [refreshProfileId]: stored },
  ],
  [
    "token-shaped secrets before generic masking, including nested causes",
    credential({ access, refresh }),
    new Error(`refresh rejected ${access} ${refresh}`, {
      cause: new Error(`nested failure ${access}`),
    }),
    [access, refresh, "sk-oau", "zzzz", "ya29.o", "yyyy"],
    3,
  ],
  [
    "overlapping secrets longest first",
    credential({ access: "abc123", refresh: "abc123456" }),
    new Error("refresh rejected abc123 abc123456"),
    ["abc123", "abc123456", "[redacted]456"],
    2,
  ],
])(
  "redacts %s from public errors and serialization",
  (_name, cred, cause, forbidden, redactions, profiles) => {
    const error = managerError(cred, cause, profiles);
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
  expect(managerError(stored, undefined).message).toContain("OAuth token refresh failed");
});

it.each([
  ["openai", "auth", "openai:default", reauth(openaiLogin)],
  ["openai", "auth_permanent", "openai:default", reauth(openaiLogin)],
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
const typed = (options: Partial<ConstructorParameters<typeof OAuthRefreshFailureError>[0]> = {}) =>
  new OAuthRefreshFailureError({ ...typedFailure, ...options });
const failover = (options: Partial<ConstructorParameters<typeof FailoverError>[1]>) =>
  new FailoverError("Authentication refresh failed", {
    reason: "auth_permanent",
    provider: "openai",
    ...options,
  });

const typedIdentity = { provider: typedFailure.provider, profileId: typedFailure.profileId };
it.each(
  Object.entries({
    "typed metadata": [typed(diagnostics), { ...typedIdentity, ...diagnostics }],
    "wrapped typed metadata": [
      new Error("wrapped", { cause: typed() }),
      { ...typedIdentity, reason: "invalid_grant" },
    ],
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
          provider: "openai",
          message: "wrapped provider failure",
          reason: "refresh_token_reused",
          summary: "Please sign in again.",
        }),
      }),
      { provider: "openai", reason: "refresh_token_reused", summary: "Please sign in again." },
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

it.each([
  [
    new Error('OAuth refresh call "refreshOAuthCredential(xai)" exceeded hard timeout (120000ms)'),
    false,
  ],
  [new Error("xAI OAuth refresh failed (503): unavailable"), false],
  [
    Object.assign(new Error("unavailable"), {
      oauthRefreshFailure: { status: 502, retryable: true },
    }),
    false,
  ],
  [
    Object.assign(new Error("reset before headers"), { oauthRefreshFailure: { retryable: true } }),
    false,
  ],
  [new Error("unclassified upstream failure"), false],
  [new Error("xAI OAuth token response is missing access_token"), false],
  [
    Object.assign(new Error("invalid_grant"), {
      oauthRefreshFailure: { status: 503, retryable: true },
    }),
    false,
  ],
  [
    Object.assign(new Error("unauthorized"), {
      oauthRefreshFailure: { status: 401, retryable: true },
    }),
    false,
  ],
  [
    Object.assign(new Error("forbidden"), {
      oauthRefreshFailure: { status: 403, retryable: true },
    }),
    false,
  ],
  [
    Object.assign(new Error("invalid response"), {
      oauthRefreshFailure: { status: 200, retryable: true },
    }),
    false,
  ],
  [
    Object.assign(new Error("rate limited"), {
      oauthRefreshFailure: { status: 429, retryable: true },
    }),
    false,
  ],
  [
    new Error("wrapped", {
      cause: Object.assign(new Error("reset"), { oauthRefreshFailure: { retryable: true } }),
    }),
    false,
  ],
  [Object.assign(new Error("revoked"), { oauthRefreshFailure: { retryable: true } }), false],
  [Object.assign(new Error("uncertain"), { oauthRefreshFailure: { retryable: false } }), false],
] as const)(
  "requires provider-owned retry admission without overriding rejection: %s",
  (error, expected) => {
    expect(isTransientOAuthRefreshFailure(error)).toBe(expected);
  },
);

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
it.each([
  ["actual non-dispatch evidence", withOutcome(notDispatched), true],
  [
    "documented reusable grant",
    withOutcome({
      ...documentedUnchanged,
      recovery: { kind: "later", evidence: "documented-reusable-grant" },
    }),
    true,
  ],
  [
    "owner-accepted provider retry",
    withOutcome({
      ...documentedUnchanged,
      status: 429,
      recovery: { kind: "later", evidence: "owner-accepted-provider-retry" },
    }),
    true,
  ],
  [
    "owner-accepted provider retry cannot admit a client rejection",
    withOutcome({
      ...documentedUnchanged,
      status: 401,
      recovery: { kind: "later", evidence: "owner-accepted-provider-retry" },
    }),
    false,
  ],
  [
    "verified intermediary challenge",
    withOutcome({
      ...documentedUnchanged,
      status: 403,
      recovery: { kind: "later", evidence: "verified-intermediary-challenge" },
    }),
    true,
  ],
  [
    "challenge evidence cannot admit ordinary forbidden responses",
    withOutcome({ ...documentedUnchanged, status: 403 }),
    false,
  ],
  [
    "challenge evidence cannot hide a terminal rejection",
    withOutcome(
      {
        ...documentedUnchanged,
        status: 403,
        recovery: { kind: "later", evidence: "verified-intermediary-challenge" },
      },
      { error: "invalid_grant" },
    ),
    false,
  ],
  ["documented nonconsuming response", withOutcome(documentedUnchanged), true],
  ["nested valid evidence", new Error("wrapper", { cause: withOutcome(notDispatched) }), true],
  ["unknown version", withOutcome({ ...notDispatched, version: 2 }), false],
  [
    "post-success evidence contradiction",
    withOutcome({ ...notDispatched, phase: "after-token-response" }),
    false,
  ],
  ["unknown outcome contradiction", withOutcome({ ...notDispatched, outcome: "unknown" }), false],
  ["malformed status", withOutcome({ ...notDispatched, status: "503" }), false],
  ["invalid status range", withOutcome({ ...notDispatched, status: 600 }), false],
  [
    "unknown recovery evidence",
    withOutcome({
      ...notDispatched,
      recovery: { kind: "later", evidence: "headers-not-received" },
    }),
    false,
  ],
  ["success status contradiction", withOutcome({ ...documentedUnchanged, status: 200 }), false],
  ["ordinary configuration rejection", withOutcome({ ...documentedUnchanged, status: 400 }), false],
  [
    "nested terminal OAuth error wins",
    withOutcome(notDispatched, { error: { code: "invalid_grant" }, reason: "provider_error" }),
    false,
  ],
  [
    "nested explicit veto wins",
    withOutcome(notDispatched, { oauthRefreshFailure: { retryable: false } }),
    false,
  ],
  [
    "nested post-success failure wins",
    withOutcome(
      notDispatched,
      withOutcome({ version: 1, phase: "after-token-response", outcome: "unknown" }),
    ),
    false,
  ],
] as const)("validates provider facts: %s", (_name, error, expected) => {
  expect(isTransientOAuthRefreshFailure(error)).toBe(expected);
});
