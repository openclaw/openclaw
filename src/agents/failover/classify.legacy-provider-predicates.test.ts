import { describe, expect, it, vi } from "vitest";
import type { FailoverReason } from "./signal.js";

const hoisted = vi.hoisted(() => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn((): FailoverReason | null => null),
}));
vi.mock("../../plugins/provider-failover.js", () => hoisted);

import { classifyProviderRuntimeFailureKind } from "../embedded-agent-helpers/provider-runtime-failure.js";
import { isContextOverflowError } from "./context-overflow.js";
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

const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

describe("CDN HTML classification", () => {
  it.each([
    { status: 502, body: "Bad Gateway", kind: "upstream_html" },
    { status: 403, body: "Enable JavaScript and cookies to continue.", kind: "upstream_html" },
    { status: 403, body: "Forbidden", kind: "auth_html" },
  ])("distinguishes $status $body at the runtime boundary", ({ status, body, kind }) => {
    expect(classifyProviderRuntimeFailureKind({ status, message: html(body) })).toBe(kind);
  });

  it("recognizes an Error-prefixed proxy response", () => {
    expect(
      classifyProviderRuntimeFailureKind(`Error: 407 ${html("Proxy Authentication Required")}`),
    ).toBe("proxy");
  });
});
