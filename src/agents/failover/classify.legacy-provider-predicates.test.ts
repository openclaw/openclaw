// Covers provider-specific error-pattern classification hooks.
import { describe, expect, it, vi } from "vitest";
import { classifyFailoverClassificationFromHttpStatus } from "./classification-rules.js";
import type { FailoverReason } from "./signal.js";

const hoisted = vi.hoisted(() => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn((): FailoverReason | null => null),
}));

vi.mock("../../plugins/provider-failover.js", () => hoisted);

import { classifyProviderRuntimeFailureKind } from "../embedded-agent-helpers/provider-runtime-failure.js";
import { isContextOverflowError } from "./classify.js";
import { isLikelyHttpErrorText, renderSanitizedUserFacingText } from "./user-copy.js";

it("renders task results and HTTP errors without activating provider hooks", () => {
  hoisted.classifyProviderFailoverSignalWithPlugin.mockClear();
  expect(renderSanitizedUserFacingText("Audit complete.", { errorContext: true })).toBe(
    "Audit complete.",
  );
  expect(isLikelyHttpErrorText("500 Internal Server Error")).toBe(true);
  expect(hoisted.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
});

describe("isContextOverflowError provider-hook gate", () => {
  it("skips provider hook dispatch for unrelated errors", () => {
    // Avoid calling plugin hooks for obviously unrelated text so classifier hot
    // paths stay cheap and side-effect free.
    hoisted.classifyProviderFailoverSignalWithPlugin.mockClear();

    expect(
      isContextOverflowError("Permission denied for /root/oc-acp-write-should-fail.txt."),
    ).toBe(false);
    expect(hoisted.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
  });
});

describe("Cloudflare / CDN HTML error page classification (#67517)", () => {
  const cloudflareHtml502 =
    "<!doctype html><html><head><title>502 Bad Gateway</title></head>" +
    "<body><h1>502 Bad Gateway</h1><p>cloudflare-nginx</p></body></html>";
  const cloudflareChallengeHtml =
    "<!doctype html><html><head><title>403 Forbidden</title></head>" +
    "<body>Enable JavaScript and cookies to continue." +
    "<p>Please stand by, while we are checking your browser...</p></body></html>";
  const cloudflareChallengeCdnCgiHtml =
    "<!doctype html><html><head><title>403 Forbidden</title></head>" +
    '<body><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page"></script>' +
    "<p>Checking your browser...</p></body></html>";
  const cloudflareChallengeErrorTextHtml =
    "<!doctype html><html><head><title>403 Forbidden</title></head>" +
    '<body><span id="challenge-error-text">Enable JavaScript and cookies to continue</span>' +
    "<p>Please stand by...</p></body></html>";
  const html403 =
    "<!doctype html><html><head><title>403 Forbidden</title></head>" +
    "<body><h1>Forbidden</h1></body></html>";
  const html407 =
    "<!doctype html><html><head><title>407 Proxy Authentication Required</title></head>" +
    "<body><h1>Proxy Authentication Required</h1></body></html>";
  const prefixedHtml407 = `Error: 407 ${html407}`;

  it("classifies Cloudflare HTML 502 as server_error", () => {
    expect(classifyFailoverReason(`502 ${cloudflareHtml502}`)).toBe("server_error");
  });

  it("classifies Cloudflare HTML 503 with rate-limit text as server_error", () => {
    // CDN HTML wrappers are upstream service failures even when the page body
    // contains generic rate-limit words. #67517 asked for them to read as
    // upstream HTTP/service errors rather than rate limits or DNS faults.
    expect(classifyFailoverReason(`503 ${cloudflareHtml503}`)).toBe("server_error");
  });

  it("classifies runtime failure kind as upstream_html for non-auth HTML", () => {
    expect(classifyProviderRuntimeFailureKind({ status: 502, message: cloudflareHtml502 })).toBe(
      "upstream_html",
    );
  });

  it("classifies Cloudflare challenge 403 as upstream_html", () => {
    // Cloudflare browser-challenge pages are CDN blocks, not auth failures.
    expect(
      classifyProviderRuntimeFailureKind({ status: 403, message: cloudflareChallengeHtml }),
    ).toBe("upstream_html");
  });
  it("classifies Cloudflare challenge 403 with cdn-cgi/challenge-platform as upstream_html", () => {
    // Challenge pages with the challenge platform script path are also CDN blocks.
    expect(
      classifyProviderRuntimeFailureKind({ status: 403, message: cloudflareChallengeCdnCgiHtml }),
    ).toBe("upstream_html");
  });

  it("classifies Cloudflare challenge 403 with challenge-error-text as upstream_html", () => {
    // Challenge pages with the challenge-error-text element are also CDN blocks.
    expect(
      classifyProviderRuntimeFailureKind({
        status: 403,
        message: cloudflareChallengeErrorTextHtml,
      }),
    ).toBe("upstream_html");
  });

  it("classifies generic 403 HTML runtime failures as auth_html", () => {
    expect(classifyProviderRuntimeFailureKind({ status: 403, message: html403 })).toBe("auth_html");
  });

  it("classifies 407 HTML runtime failures as proxy", () => {
    expect(classifyProviderRuntimeFailureKind({ status: 407, message: html407 })).toBe("proxy");
  });

  it("classifies Error-prefixed 407 HTML runtime failures as proxy", () => {
    expect(classifyProviderRuntimeFailureKind(prefixedHtml407)).toBe("proxy");
  });
});

describe("context semantics through HTTP status mapping", () => {
  it.each([400, 404, 499, 500, 529])(
    "preserves a classified context overflow through HTTP %i",
    (status) => {
      expect(
        classifyFailoverClassificationFromHttpStatus(
          status,
          "Context size has been exceeded.",
          { kind: "context_overflow" },
          status,
        ),
      ).toEqual({ kind: "context_overflow" });
    },
  );

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
