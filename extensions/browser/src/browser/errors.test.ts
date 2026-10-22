import { expect, it } from "vitest";
import {
  BROWSER_ACT_ERROR_CODES,
  BROWSER_ERROR_REASONS,
  BrowserProfileUnavailableError,
  BrowserTabNotFoundError,
  parseBrowserErrorPayload,
  toBrowserErrorResponse,
} from "./errors.js";

it("preserves known codes and drops unknown route metadata", () => {
  const payload = {
    error: "evaluation disabled",
    code: BROWSER_ACT_ERROR_CODES.evaluateDisabled,
  };
  expect(parseBrowserErrorPayload({ ...payload, untrusted: "drop me" })).toEqual(payload);
  expect(parseBrowserErrorPayload({ error: "failure", code: "UNTRUSTED_CODE" })).toEqual({
    error: "failure",
    unrecognizedCode: true,
  });
});

it("preserves the navigation reason without forwarding policy details", () => {
  const payload = { error: "browser navigation blocked by policy", reason: "navigation_blocked" };
  expect(
    parseBrowserErrorPayload({
      ...payload,
      details: { url: "http://internal.example/admin", address: "10.0.0.1" },
      cause: "private lookup details",
    }),
  ).toEqual(payload);
  expect(
    parseBrowserErrorPayload({ error: "failure", reason: "untrusted_reason", details: {} }),
  ).toEqual({ error: "failure" });
});
it("teaches agents that bare numbers are not stable tab targets", () => {
  expect(new BrowserTabNotFoundError({ input: "2" }).message).toBe(
    'tab not found: browser tab "2" not found. Numeric values are not tab targets; use a stable tab id like "t1", a label, or a raw targetId. For positional selection, use "openclaw browser tab select 2".',
  );
});
const details = {
  profile: "openclaw",
  requestedHeadless: false,
  headlessSource: "profile",
  displayPresent: false,
} as const;
const metadata = { reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile, details };

it("maps a closed no-display reason and typed details to an HTTP conflict", () => {
  expect(
    toBrowserErrorResponse(new BrowserProfileUnavailableError("display required", { metadata })),
  ).toEqual({ status: 409, message: "display required", ...metadata });
});

it("accepts only valid no-display metadata from route payloads", () => {
  const payload = { error: "display required", ...metadata };
  expect(parseBrowserErrorPayload(payload)).toEqual(payload);
  expect(
    parseBrowserErrorPayload({
      ...payload,
      details: { ...details, requestedHeadless: true, remediation: "untrusted" },
    }),
  ).toEqual({ error: "display required" });
});
