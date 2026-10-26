import { describe, expect, it } from "vitest";
import { isSelectableCdpBrowserTarget } from "./cdp-target-filter.js";

describe("CDP browser target filtering", () => {
  it.each([
    "chrome://newtab/",
    "chrome-search://most-visited/single.html",
    "chrome-extension://example/internal.html",
  ])("rejects browser-owned page URL %s", (url) => {
    expect(isSelectableCdpBrowserTarget({ type: "page", url })).toBe(false);
  });

  it("keeps ordinary pages selectable", () => {
    expect(
      isSelectableCdpBrowserTarget({ type: "page", url: "https://example.com/" }),
    ).toBe(true);
  });
});
