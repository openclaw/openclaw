import { describe, it } from "vitest";
import {
  ToolsGitHubAuthorizeCancelParamsSchema as CancelParams,
  ToolsGitHubAuthorizePollParamsSchema as PollParams,
  ToolsGitHubAuthorizePollResultSchema as PollResult,
  ToolsGitHubAuthorizeStartParamsSchema as StartParams,
  ToolsGitHubAuthorizeStartResultSchema as StartResult,
  ToolsGitHubConfigureParamsSchema as ConfigureParams,
  ToolsGitHubStatusResultSchema as StatusResult,
} from "./agents-models-skills.js";
import { accepts, rejects } from "./schema.test-support.js";

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
    accepts(ConfigureParams, {
      ...action,
      secretName: "github-setup-11111111111111111111111111111111",
    });
  });

  it("rejects impossible configure action", () => {
    rejects(ConfigureParams, { ...action, secretName: "ONE_USE_HANDOFF" });
  });

  it("separates the selected configuration scope from the effective identity", () => {
    const status = {
      agentId: "main",
      selectedScope: "system",
      selected: { scope: "system", configured: true, identity: identityFacts },
    };
    accepts(StatusResult, {
      ...status,
      effective: {
        ...identityFacts,
        source: "agent-override",
        account: { login: "agent-account" },
      },
    });
    rejects(StatusResult, {
      ...status,
      selectedScope: "agent",
      selected: { scope: "agent", configured: false, identity: null },
      effective: identityFacts,
      token: "not-allowed",
    });
  });

  it("accepts only the pinned device authorization URI and secret-free start response", () => {
    accepts(StartParams, { scope: "agent", agentId: "main" });
    const result = {
      requestId: "github-device-11111111111111111111111111111111",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresInMs: 900_000,
      pollAfterMs: 5_000,
    };
    accepts(StartResult, result);
    rejects(
      StartResult,
      { ...result, verificationUri: "https://example.com/login/device" },
      { ...result, deviceCode: "must-not-cross-the-wire" },
    );
  });

  it("rejects credentials and upstream diagnostics in device polling", () => {
    const retry = { retryAfterMs: 5_000 };
    rejects(
      PollResult,
      { ...retry, status: "pending", device_code: "not-allowed" },
      { ...retry, status: "network_error", message: "upstream diagnostic" },
    );
  });

  it("accepts only opaque authorization request ids for cancellation", () => {
    const params = { requestId: "github-device-22222222222222222222222222222222" };
    accepts(PollParams, params);
    accepts(CancelParams, params);
    rejects(CancelParams, { requestId: "device-code" });
  });
});
