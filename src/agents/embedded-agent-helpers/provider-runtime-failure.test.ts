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

  it("classifies complete HTML after an HTTP reason phrase as upstream_html", () => {
    expectKind("HTTP 502 Bad Gateway\n\n<!doctype html><html><body>down</body></html>").toBe(
      "upstream_html",
    );
  });

  it("classifies generic resource-exhausted codes as rate_limit", () => {
    expectKind({ provider: "openai", code: "RESOURCE_EXHAUSTED", message: "" }).toBe("rate_limit");
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
  it("classifies missing scope failures", () => {
    expectKind({
      provider: "openai",
      message:
        '401 {"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"}}',
    }).toBe("auth_scope");
  });

  it("classifies raw missing scope payloads without an HTTP prefix", () => {
    expectKind({
      provider: "openai",
      message:
        '{"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"},"code":401}',
    }).toBe("auth_scope");
  });

  it("does not classify other provider permission errors as OpenAI scope failures", () => {
    expectKind({
      provider: "anthropic",
      message:
        '401 {"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"}}',
    }).not.toBe("auth_scope");
  });

  it("does not treat generic OpenAI permission failures as missing scope failures", () => {
    expectKind({
      provider: "openai",
      message:
        '403 {"type":"error","error":{"type":"permission_error","message":"Insufficient permissions for this organization"}}',
    }).not.toBe("auth_scope");
  });

  it("classifies OAuth refresh failures", () => {
    const refreshFailures = [
      "OAuth token refresh failed for openai: invalid_grant. Please try again or re-authenticate.",
      "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
      "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
    ];
    for (const message of refreshFailures) {
      expectKind(message).toBe("auth_refresh");
      expect(classifyFailoverReason(message, { provider: "openai" })).toBe("auth_permanent");
    }
  });

  it("keeps Codex entitlement and usage-limit payloads out of terminal auth", () => {
    const entitlementMessages = [
      "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), try again after 11:34 AM.",
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits, try again later.",
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"You\\u0027ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), try again after 11:34 AM."}}',
    ];
    for (const message of entitlementMessages) {
      expectKind(message).not.toBe("auth_refresh");
      expect(classifyFailoverReason(message, { provider: "openai" })).toBe("rate_limit");
    }
  });

  it("classifies OAuth refresh timeouts and lock contention distinctly", () => {
    expectKind(
      'OAuth refresh call "refreshProviderOAuthCredentialWithPlugin(openai)" exceeded hard timeout (120000ms)',
    ).toBe("refresh_timeout");
    expectKind("file lock timeout for /tmp/openclaw-oauth-refresh.lock").toBe("refresh_contention");
    expectKind({
      code: "refresh_contention",
      message:
        "OAuth token refresh failed for openai: OAuth refresh failed (refresh_contention): another process is already refreshing openai for openai:default. Please wait for the in-flight refresh to finish and retry.",
    }).toBe("refresh_contention");
    expectKind(
      "OAuth token refresh failed for openai: file lock timeout for /tmp/agent/auth-profiles.json. Please try again or re-authenticate.",
    ).toBe("auth_refresh");
  });

  it("classifies HTML 403 auth failures", () => {
    expectKind("403 <!DOCTYPE html><html><body>Access denied</body></html>").toBe("auth_html");
  });

  it("classifies proxy, dns, timeout, schema, sandbox, and replay failures", () => {
    expectKind("407 Proxy Authentication Required").toBe("proxy");
    expectKind("dial tcp: lookup api.example.com: no such host").toBe("dns");
    expectKind("socket hang up").toBe("timeout");
    expectKind({ code: "CERT_HAS_EXPIRED", message: "certificate has expired" }).toBe(
      "tls_certificate",
    );
    expectKind({ code: "CERT_REVOKED", message: "TLS validation failed" }).toBe("tls_certificate");
    expectKind({
      status: 400,
      code: "CERT_HAS_EXPIRED",
      message: "certificate field rejected",
    }).toBe("unclassified");
    expectKind("INVALID_REQUEST_ERROR: string should match pattern").toBe("schema");
    expectKind("exec denied (allowlist-miss):").toBe("sandbox_blocked");
    expectKind("tool_use.input: Field required").toBe("replay_invalid");
    expectKind("401 input item ID does not belong to this connection").toBe("replay_invalid");
  });

  it("classifies expired Anthropic thinking signatures as replay invalid", () => {
    expectKind(
      '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.440: Invalid `signature` in `thinking` block"}}',
    ).toBe("replay_invalid");
    expectKind("ValidationException: invalid signature on thinking block").toBe("replay_invalid");
    expectKind("ValidationException: signature present in thinking block").not.toBe(
      "replay_invalid",
    );
    expectKind("Invalid signature").not.toBe("replay_invalid");
  });

  it("splits ambiguous provider runtime failures instead of collapsing to unknown", () => {
    expectKind({}).toBe("empty_response");
    expectKind("Unknown error (no error details in response)").toBe("no_error_details");
    expectKind("provider sent a strange opaque failure").toBe("unclassified");
  });

  it("does not classify generic config errors that mention proxy settings as proxy failures", () => {
    expectKind(
      'Model-provider request.proxy/request.tls is not yet supported for api "ollama"',
    ).not.toBe("proxy");
  });

  it("does not classify google-style INTERNAL payloads without a 500 code as timeout", () => {
    const sample =
      'got status: INTERNAL. {"error":{"code":400,"message":"Request malformed","status":"INTERNAL"}}';
    expect(isTimeoutErrorMessage(sample)).toBe(false);
    expect(classifyFailoverReason(sample)).toBeNull();
  });
});
