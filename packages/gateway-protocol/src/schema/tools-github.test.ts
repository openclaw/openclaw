import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ToolsGitHubAuthorizeCancelParamsSchema,
  ToolsGitHubAuthorizePollParamsSchema,
  ToolsGitHubAuthorizePollResultSchema,
  ToolsGitHubAuthorizeStartParamsSchema,
  ToolsGitHubAuthorizeStartResultSchema,
  ToolsGitHubConfigureParamsSchema,
  ToolsGitHubStatusResultSchema,
} from "./agents-models-skills.js";

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
  it.each([
    {
      scope: "system",
      agentId: "main",
      mode: "managed",
      secretName: "github-setup-11111111111111111111111111111111",
    },
  ])("accepts configure action %#", (action) => {
    expect(Value.Check(ToolsGitHubConfigureParamsSchema, action)).toBe(true);
  });

  it.each([{ scope: "system", agentId: "main", mode: "managed", secretName: "ONE_USE_HANDOFF" }])(
    "rejects impossible configure action %#",
    (action) => {
      expect(Value.Check(ToolsGitHubConfigureParamsSchema, action)).toBe(false);
    },
  );

  it("separates the selected configuration scope from the effective identity", () => {
    expect(
      Value.Check(ToolsGitHubStatusResultSchema, {
        agentId: "main",
        selectedScope: "system",
        selected: { scope: "system", configured: true, identity: identityFacts },
        effective: {
          ...identityFacts,
          source: "agent-override",
          account: { login: "agent-account" },
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(ToolsGitHubStatusResultSchema, {
        agentId: "main",
        selectedScope: "agent",
        selected: { scope: "agent", configured: false, identity: null },
        effective: identityFacts,
        token: "not-allowed",
      }),
    ).toBe(false);
  });

  it("accepts only the pinned device authorization URI and secret-free start response", () => {
    expect(
      Value.Check(ToolsGitHubAuthorizeStartParamsSchema, {
        scope: "agent",
        agentId: "main",
      }),
    ).toBe(true);
    const result = {
      requestId: "github-device-11111111111111111111111111111111",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresInMs: 900_000,
      pollAfterMs: 5_000,
    };
    expect(Value.Check(ToolsGitHubAuthorizeStartResultSchema, result)).toBe(true);
    expect(
      Value.Check(ToolsGitHubAuthorizeStartResultSchema, {
        ...result,
        verificationUri: "https://example.com/login/device",
      }),
    ).toBe(false);
    expect(
      Value.Check(ToolsGitHubAuthorizeStartResultSchema, {
        ...result,
        deviceCode: "must-not-cross-the-wire",
      }),
    ).toBe(false);
  });

  it("rejects credentials and upstream diagnostics in device polling", () => {
    expect(
      Value.Check(ToolsGitHubAuthorizePollResultSchema, {
        status: "pending",
        retryAfterMs: 5_000,
        device_code: "not-allowed",
      }),
    ).toBe(false);
    expect(
      Value.Check(ToolsGitHubAuthorizePollResultSchema, {
        status: "network_error",
        retryAfterMs: 5_000,
        message: "upstream diagnostic",
      }),
    ).toBe(false);
  });

  it("accepts only opaque authorization request ids for cancellation", () => {
    const params = { requestId: "github-device-22222222222222222222222222222222" };
    expect(Value.Check(ToolsGitHubAuthorizePollParamsSchema, params)).toBe(true);
    expect(Value.Check(ToolsGitHubAuthorizeCancelParamsSchema, params)).toBe(true);
    expect(Value.Check(ToolsGitHubAuthorizeCancelParamsSchema, { requestId: "device-code" })).toBe(
      false,
    );
  });
});
