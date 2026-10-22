import { expect, it } from "vitest";
import {
  BROWSER_ERROR_REASONS,
  BrowserTabNotFoundError,
  parseBrowserErrorPayload,
} from "./errors.js";

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
