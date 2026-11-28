import { aroundEach, describe, expect, it } from "vitest";
import { classifyFailoverReason, isTimeoutErrorMessage } from "../failover/classify.js";
import { withPreparedFailoverProviders } from "../test-helpers/provider-failover-generation.js";
import { classifyProviderRuntimeFailureKind } from "./provider-runtime-failure.js";

const expectKind = (signal: Parameters<typeof classifyProviderRuntimeFailureKind>[0]) =>
  expect(classifyProviderRuntimeFailureKind(signal));

describe("classifyProviderRuntimeFailureKind", () => {
  aroundEach((runTest) =>
    withPreparedFailoverProviders(["openai", "google", "anthropic"], runTest),
  );

  it.each([
    ["HTTP 502 Bad Gateway\n\n<!doctype html><html><body>down</body></html>", "upstream_html"],
    [{ provider: "openai", code: "RESOURCE_EXHAUSTED", message: "" }, "rate_limit"],
    ["403 <!DOCTYPE html><html><body>Access denied</body></html>", "auth_html"],
    ["407 Proxy Authentication Required", "proxy"],
    ["dial tcp: lookup api.example.com: no such host", "dns"],
    ["socket hang up", "timeout"],
    [{ code: "CERT_HAS_EXPIRED", message: "certificate has expired" }, "tls_certificate"],
    [{ code: "CERT_REVOKED", message: "TLS validation failed" }, "tls_certificate"],
    [
      { status: 400, code: "CERT_HAS_EXPIRED", message: "certificate field rejected" },
      "unclassified",
    ],
    ["INVALID_REQUEST_ERROR: string should match pattern", "schema"],
    ["exec denied (allowlist-miss):", "sandbox_blocked"],
    ["tool_use.input: Field required", "replay_invalid"],
    ["401 input item ID does not belong to this connection", "replay_invalid"],
    [{}, "empty_response"],
    ["Unknown error (no error details in response)", "no_error_details"],
    ["provider sent a strange opaque failure", "unclassified"],
    [
      'OAuth refresh call "refreshProviderOAuthCredentialWithPlugin(openai)" exceeded hard timeout (120000ms)',
      "refresh_timeout",
    ],
    ["file lock timeout for /tmp/openclaw-oauth-refresh.lock", "refresh_contention"],
    [
      {
        code: "refresh_contention",
        message:
          "OAuth token refresh failed for openai: OAuth refresh failed (refresh_contention): another process is already refreshing openai for openai:default. Please wait for the in-flight refresh to finish and retry.",
      },
      "refresh_contention",
    ],
    [
      "OAuth token refresh failed for openai: file lock timeout for /tmp/agent/auth-profiles.json. Please try again or re-authenticate.",
      "auth_refresh",
    ],
    ["ValidationException: invalid signature on thinking block", "replay_invalid"],
  ] as const)("classifies %j as %s", (signal, kind) => {
    expectKind(signal).toBe(kind);
  });
  it.each(["EACCES", "EPERM", "EROFS"])(
    "does not classify a provider transport %s as Gateway storage",
    (code) => {
      expectKind({ code, message: `connect ${code} /synthetic/model.sock` }).toBe("unclassified");
    },
  );
  it.each(["EIO", "ENOSPC"])("preserves shared storage classification for %s", (code) => {
    expectKind({ code, message: `connect ${code} /synthetic/model.sock` }).toBe("gateway_storage");
  });
  const missingScope =
    '{"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"}}';
  it.each([`401 ${missingScope}`, `${missingScope.slice(0, -1)},"code":401}`])(
    "classifies missing scopes with or without an HTTP prefix: %s",
    (message) => expectKind({ provider: "openai", message }).toBe("auth_scope"),
  );

  it.each([
    [{ provider: "anthropic", message: `401 ${missingScope}` }, "auth_scope"],
    [
      {
        provider: "openai",
        message:
          '403 {"type":"error","error":{"type":"permission_error","message":"Insufficient permissions for this organization"}}',
      },
      "auth_scope",
    ],
    ["ValidationException: signature present in thinking block", "replay_invalid"],
    ["Invalid signature", "replay_invalid"],
    ['Model-provider request.proxy/request.tls is not yet supported for api "ollama"', "proxy"],
  ] as const)("does not misclassify %j as %s", (signal, kind) => {
    expectKind(signal).not.toBe(kind);
  });

  it.each([
    "OAuth token refresh failed for openai: invalid_grant. Please try again or re-authenticate.",
    "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
    "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
  ])("classifies OAuth refresh failure: %s", (message) => {
    expectKind(message).toBe("auth_refresh");
    expect(classifyFailoverReason(message, { provider: "openai" })).toBe("auth_permanent");
  });

  it.each([
    "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), try again after 11:34 AM.",
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits, try again later.",
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"You\\u0027ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), try again after 11:34 AM."}}',
  ])("keeps usage limits out of terminal auth: %s", (message) => {
    expectKind(message).not.toBe("auth_refresh");
    expect(classifyFailoverReason(message, { provider: "openai" })).toBe("rate_limit");
  });

  it("does not classify google-style INTERNAL payloads without a 500 code as timeout", () => {
    const sample =
      'got status: INTERNAL. {"error":{"code":400,"message":"Request malformed","status":"INTERNAL"}}';
    expect(isTimeoutErrorMessage(sample)).toBe(false);
    expect(classifyFailoverReason(sample)).toBeNull();
  });
});
