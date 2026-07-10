// Browser tests cover CDP target selectability filtering.
import { describe, expect, it } from "vitest";
import { isSelectableCdpBrowserTarget } from "./cdp-target-filter.js";

describe("isSelectableCdpBrowserTarget", () => {
  it("keeps page targets", () => {
    expect(isSelectableCdpBrowserTarget({ url: "https://example.com", type: "page" })).toBe(true);
    expect(isSelectableCdpBrowserTarget({ url: "https://example.com", type: " Page " })).toBe(true);
  });

  it("keeps targets without a type for url-only discovery paths", () => {
    expect(isSelectableCdpBrowserTarget({ url: "https://example.com" })).toBe(true);
    expect(isSelectableCdpBrowserTarget({ url: "https://example.com", type: undefined })).toBe(
      true,
    );
    expect(isSelectableCdpBrowserTarget({ url: "https://example.com", type: null })).toBe(true);
    expect(isSelectableCdpBrowserTarget({ url: "https://example.com", type: "" })).toBe(true);
  });

  it("excludes non-page targets such as OOPIF iframes and workers", () => {
    for (const type of ["iframe", "worker", "service_worker", "shared_worker", "other"]) {
      expect(isSelectableCdpBrowserTarget({ url: "https://example.com", type })).toBe(false);
    }
  });

  it("excludes browser-internal URLs regardless of type", () => {
    expect(isSelectableCdpBrowserTarget({ url: "chrome://newtab/", type: "page" })).toBe(false);
    expect(isSelectableCdpBrowserTarget({ url: "devtools://devtools/inspector.html" })).toBe(false);
  });
});
