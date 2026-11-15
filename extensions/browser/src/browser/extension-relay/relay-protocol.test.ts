import { describe, expect, it } from "vitest";
import { parseExtensionMessage } from "./relay-protocol.js";

const parse = (frame: unknown) => parseExtensionMessage(JSON.stringify(frame));
const accepts = (frame: unknown) => expect(parse(frame)).toEqual(frame);
const tab = { tabId: 1, url: "https://example.com", title: "Example", active: true };

describe("parseExtensionMessage", () => {
  const validHello = {
    type: "hello",
    userAgent: "Mozilla/5.0 Chrome/144.0.0.0",
    browserVersion: "Chrome/144.0.0.0",
    extensionVersion: "2.0.0",
    tabs: [tab],
  };

  it("accepts known frame types", () => {
    accepts(validHello);
    accepts({ type: "pong" });
    accepts({ type: "result", seq: 3, result: { ok: true } });
    accepts({ type: "tabs", tabs: [{ ...tab, tabId: 2 }] });
    accepts({ type: "cdpEvent", tabId: 1, method: "Page.load" });
    accepts({ type: "detached", tabId: 1, reason: "cancel" });
  });

  it.each([
    ["missing identity", { ...validHello, userAgent: undefined }],
    ["empty browser version", { ...validHello, browserVersion: "" }],
    ["oversized user agent", { ...validHello, userAgent: "x".repeat(2_049) }],
    ["an extra hello field", { ...validHello, extra: true }],
    ["non-array tabs", { ...validHello, tabs: {} }],
    ["a fractional tab id", { ...validHello, tabs: [{ ...tab, tabId: 1.5 }] }],
    ["an extra tab field", { ...validHello, tabs: [{ ...tab, incognito: false }] }],
    ["duplicate tab ids", { ...validHello, tabs: [tab, { ...tab, active: false }] }],
  ])("rejects a hello with %s", (_label, hello) => {
    expect(parse(hello)).toBeNull();
  });

  it("rejects malformed or unknown frames", () => {
    expect(parseExtensionMessage("not json")).toBeNull();
    expect(parse({ type: "evil" })).toBeNull();
    expect(parse({ noType: true })).toBeNull();
    expect(parse(42)).toBeNull();
  });

  // Reject malformed fields before the bridge's synchronous dispatch dereferences them.
  it("rejects frames with malformed payload fields", () => {
    const cases: unknown[] = [
      { ...validHello, tabs: null },
      { ...validHello, tabs: [null] },
      { ...validHello, tabs: [{ tabId: "1", url: "u", title: "t", active: true }] },
      { ...validHello, userAgent: 42 },
      { type: "tabs", tabs: {} },
      { type: "tabs", tabs: null },
      { type: "tabs", tabs: [null] },
      { type: "tabs", tabs: [{ tabId: 1, url: "u", title: "t" }] },
      { type: "tabs", tabs: [{ tabId: 1.5, url: "u", title: "t", active: true }] },
      { type: "tabs", tabs: [tab, { ...tab, active: false }] },
      { type: "cdpEvent", tabId: "1", method: "Page.load" },
      { type: "cdpEvent", tabId: 1.5, method: "Page.load" },
      { type: "cdpEvent", tabId: 1 },
      { type: "cdpEvent", tabId: 1, sessionId: 2, method: "Page.load" },
      { type: "result", seq: "3" },
      { type: "result", seq: -1 },
      { type: "result", seq: 1.5 },
      { type: "error", seq: null, message: "boom" },
      { type: "error", seq: 3, message: {} },
      { type: "detached", tabId: "1", reason: "cancel" },
      { type: "detached", tabId: 1, reason: null },
    ];
    for (const frame of cases) {
      expect(parse(frame)).toBeNull();
    }
  });
});
