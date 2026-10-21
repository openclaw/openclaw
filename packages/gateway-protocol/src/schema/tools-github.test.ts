import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ToolsGitHubAuthorizeCancelParamsSchema as CancelParams,
  ToolsGitHubAuthorizePollParamsSchema as PollParams,
  ToolsGitHubAuthorizePollResultSchema as PollResult,
  ToolsGitHubAuthorizeStartParamsSchema as StartParams,
  ToolsGitHubAuthorizeStartResultSchema as StartResult,
  ToolsGitHubConfigureParamsSchema as ConfigureParams,
  ToolsGitHubStatusResultSchema as StatusResult,
} from "./agents-models-skills.js";

function check(schema: TSchema, expected: boolean, value: unknown) {
  expect(Value.Check(schema, value)).toBe(expected);
}

const identityFacts = {
  source: "system-configured",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "octocat" },
  gitAuthor: { name: "octocat", email: "1+octocat@users.noreply.github.com" },
  evidence: "github-api",
  accessExpiresAtMs: 1_800_000_000_000,
  refreshState: "available",
  oauthScopes: ["repo", "workflow"],
  repositoryGrants: "unknown",
} as const;

describe("GitHub tools protocol", () => {
  const action = { scope: "system", agentId: "main", mode: "managed" };

  it("accepts configure action", () => {
    check(ConfigureParams, true, {
      ...action,
      secretName: "github-setup-11111111111111111111111111111111",
    });
  });

  it("rejects impossible configure action", () => {
    check(ConfigureParams, false, { ...action, secretName: "ONE_USE_HANDOFF" });
  });

  it("separates the selected configuration scope from the effective identity", () => {
    const status = {
      agentId: "main",
      selectedScope: "system",
      selected: { scope: "system", configured: true, identity: identityFacts },
    };
    check(StatusResult, true, {
      ...status,
      effective: {
        ...identityFacts,
        source: "agent-override",
        account: { login: "agent-account" },
      },
    });
    check(StatusResult, false, {
      ...status,
      selectedScope: "agent",
      selected: { scope: "agent", configured: false, identity: null },
      effective: identityFacts,
      token: "not-allowed",
    });
  });

  it("accepts only the pinned device authorization URI and secret-free start response", () => {
    check(StartParams, true, { scope: "agent", agentId: "main" });
    const result = {
      requestId: "github-device-11111111111111111111111111111111",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresInMs: 900_000,
      pollAfterMs: 5_000,
    };
    check(StartResult, true, result);
    check(StartResult, false, {
      ...result,
      verificationUri: "https://example.com/login/device",
    });
    check(StartResult, false, { ...result, deviceCode: "must-not-cross-the-wire" });
  });

  it("rejects credentials and upstream diagnostics in device polling", () => {
    check(PollResult, false, {
      status: "pending",
      retryAfterMs: 5_000,
      device_code: "not-allowed",
    });
    check(PollResult, false, {
      status: "network_error",
      retryAfterMs: 5_000,
      message: "upstream diagnostic",
    });
  });

  it("accepts only opaque authorization request ids for cancellation", () => {
    const params = { requestId: "github-device-22222222222222222222222222222222" };
    check(PollParams, true, params);
    check(CancelParams, true, params);
    check(CancelParams, false, { requestId: "device-code" });
  });
});
