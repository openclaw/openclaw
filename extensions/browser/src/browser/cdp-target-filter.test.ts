// Browser tests cover CDP target filtering plugin behavior.
import { describe, expect, it } from "vitest";
import { isSelectableCdpBrowserTarget } from "./cdp-target-filter.js";

describe("isSelectableCdpBrowserTarget", () => {
  it("keeps page targets selectable", () => {
    expect(
      isSelectableCdpBrowserTarget({
        type: "page",
        url: "https://example.com",
      }),
    ).toBe(true);
  });

  it("filters non-page targets even when their URL is public", () => {
    expect(
      isSelectableCdpBrowserTarget({
        type: "service_worker",
        url: "https://example.com/sw.js",
      }),
    ).toBe(false);
    expect(
      isSelectableCdpBrowserTarget({
        type: "worker",
        url: "https://example.com/worker.js",
      }),
    ).toBe(false);
  });

  it("still filters browser-internal page targets", () => {
    expect(
      isSelectableCdpBrowserTarget({
        type: "page",
        url: "chrome://omnibox-popup.top-chrome/",
      }),
    ).toBe(false);
  });

  it("keeps legacy target records without type filtered by URL only", () => {
    expect(isSelectableCdpBrowserTarget({ url: "https://example.com" })).toBe(true);
  });
});
