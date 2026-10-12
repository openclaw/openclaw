import { describe, expect, it, vi } from "vitest";
import { classifyFailoverClassificationFromHttpStatus } from "./classification-rules.js";
import type { FailoverReason } from "./signal.js";

const hoisted = vi.hoisted(() => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn((): FailoverReason | null => null),
}));
vi.mock("../../plugins/provider-failover.js", () => hoisted);

import { classifyProviderRuntimeFailureKind } from "../embedded-agent-helpers/provider-runtime-failure.js";
import { classifyFailoverReason, isContextOverflowError } from "./classify.js";
import { isLikelyHttpErrorText, renderSanitizedUserFacingText } from "./user-copy.js";

it("renders task results and HTTP errors without activating provider hooks", () => {
  hoisted.classifyProviderFailoverSignalWithPlugin.mockClear();
  expect(renderSanitizedUserFacingText("Audit complete.", { errorContext: true })).toBe(
    "Audit complete.",
  );
  expect(isLikelyHttpErrorText("500 Internal Server Error")).toBe(true);
  expect(hoisted.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
});

it("skips provider hooks for unrelated context-overflow candidates", () => {
  hoisted.classifyProviderFailoverSignalWithPlugin.mockClear();
  expect(isContextOverflowError("Permission denied for /root/oc-acp-write-should-fail.txt.")).toBe(
    false,
  );
  expect(hoisted.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
});

it.each(["ValidationException: The input is too long for the model", "context length exceeded"])(
  "recognizes context overflow: %s",
  (message) => {
    expect(isContextOverflowError(message)).toBe(true);
  },
);

it("recognizes a deactivated model", () => {
  expect(classifyFailoverReason("model_is_deactivated: this model has been deactivated")).toBe(
    "model_not_found",
  );
});

it("prefers xAI billing evidence over resource-exhausted rate limits", () => {
  expect(
    classifyFailoverReason(
      '429 {"code":"Some resource has been exhausted","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}',
      { provider: "xai" },
    ),
  ).toBe("billing");
});

const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

describe("CDN HTML classification", () => {
  it.each([
    ["Error: 401", "Unauthorized", "auth"],
    ["403", "Forbidden", "auth"],
    ["402", "Payment Required. Your quota is exhausted.", "billing"],
    ["429", "Rate limit exceeded.", "rate_limit"],
    ["503", "Please try again. Rate limit exceeded.", "server_error"],
  ])("classifies %s HTML (%s) as %s", (prefix, body, reason) => {
    expect(classifyFailoverReason(`${prefix} ${html(body)}`)).toBe(reason);
  });

  it.each([
    { status: 502, body: "Bad Gateway", kind: "upstream_html" },
    { status: 403, body: "Enable JavaScript and cookies to continue.", kind: "upstream_html" },
    { status: 403, body: "Forbidden", kind: "auth_html" },
    { status: 407, body: "Proxy Authentication Required", kind: "proxy" },
  ])("distinguishes $status $body at the runtime boundary", ({ status, body, kind }) => {
    expect(classifyProviderRuntimeFailureKind({ status, message: html(body) })).toBe(kind);
  });

  it("recognizes an Error-prefixed proxy response", () => {
    expect(
      classifyProviderRuntimeFailureKind(`Error: 407 ${html("Proxy Authentication Required")}`),
    ).toBe("proxy");
  });
});

describe("context semantics through HTTP status mapping", () => {
  it("preserves context overflow ahead of generic server status mapping", () => {
    expect(
      classifyFailoverClassificationFromHttpStatus(
        500,
        "Context size has been exceeded.",
        { kind: "context_overflow" },
        500,
      ),
    ).toEqual({ kind: "context_overflow" });
  });

  it.each([
    { status: 401, reason: "auth" },
    { status: 403, reason: "auth" },
    { status: 429, reason: "rate_limit" },
  ])("preserves the HTTP $status access or quota boundary", ({ status, reason }) => {
    expect(
      classifyFailoverClassificationFromHttpStatus(
        status,
        "Context size has been exceeded.",
        { kind: "context_overflow" },
        status,
      ),
    ).toEqual({ kind: "reason", reason });
  });
});
