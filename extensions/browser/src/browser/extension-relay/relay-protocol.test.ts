// Extension relay protocol frame parsing.
import { describe, expect, it } from "vitest";
import { parseExtensionMessage } from "./relay-protocol.js";

describe("parseExtensionMessage", () => {
  it("accepts known frame types", () => {
    expect(parseExtensionMessage(JSON.stringify({ type: "pong" }))).toEqual({ type: "pong" });
    expect(
      parseExtensionMessage(JSON.stringify({ type: "result", seq: 3, result: { ok: true } })),
    ).toMatchObject({ type: "result", seq: 3 });
    expect(
      parseExtensionMessage(
        JSON.stringify({
          type: "hello",
          userAgent: "agent",
          browserVersion: "Chrome/144.0.0.0",
          extensionVersion: "1.0.0",
          tabs: [{ tabId: 1, url: "https://example.com", title: "Example", active: true }],
        }),
      ),
    ).toMatchObject({ type: "hello", tabs: [{ tabId: 1 }] });
    expect(
      parseExtensionMessage(
        JSON.stringify({
          type: "tabs",
          tabs: [{ tabId: 2, url: "https://example.com/2", title: "Two", active: false }],
        }),
      ),
    ).toMatchObject({ type: "tabs", tabs: [{ tabId: 2 }] });
    expect(
      parseExtensionMessage(JSON.stringify({ type: "cdpEvent", tabId: 1, method: "Page.load" })),
    ).toMatchObject({ type: "cdpEvent", tabId: 1 });
    expect(
      parseExtensionMessage(JSON.stringify({ type: "detached", tabId: 1, reason: "cancel" })),
    ).toMatchObject({ type: "detached", tabId: 1 });
    expect(
      parseExtensionMessage(
        JSON.stringify({
          type: "pageShare",
          requestId: 7,
          payload: { url: "https://example.com", title: "Example", content: "Body" },
        }),
      ),
    ).toMatchObject({ type: "pageShare", requestId: 7 });
  });

  it("rejects malformed or unknown frames", () => {
    expect(parseExtensionMessage("not json")).toBeNull();
    expect(parseExtensionMessage(JSON.stringify({ type: "evil" }))).toBeNull();
    expect(parseExtensionMessage(JSON.stringify({ noType: true }))).toBeNull();
    expect(parseExtensionMessage(JSON.stringify(42))).toBeNull();
  });

  // The bridge dereferences frame fields without try/catch (bindSocket invokes
  // the handler straight from the ws "message" event), so parse must reject
  // frames whose payload shape would crash syncTabs/handleExtensionMessage.
  it("rejects frames with malformed payload fields", () => {
    const validHello = {
      type: "hello",
      userAgent: "agent",
      browserVersion: "Chrome/144.0.0.0",
      extensionVersion: "1.0.0",
      tabs: [{ tabId: 1, url: "https://example.com", title: "Example", active: true }],
    };
    const cases: unknown[] = [
      // hello: identity fields and tab list must be present and typed.
      { ...validHello, tabs: {} },
      { ...validHello, tabs: null },
      { ...validHello, tabs: [null] },
      { ...validHello, tabs: [{ tabId: "1", url: "u", title: "t", active: true }] },
      { ...validHello, userAgent: 42 },
      // tabs: same tab-list shape as hello.
      { type: "tabs", tabs: {} },
      { type: "tabs", tabs: null },
      { type: "tabs", tabs: [null] },
      { type: "tabs", tabs: [{ tabId: 1, url: "u", title: "t" }] },
      // cdpEvent: numeric tabId + string method.
      { type: "cdpEvent", tabId: "1", method: "Page.load" },
      { type: "cdpEvent", tabId: 1 },
      // result/error: numeric seq correlates the pending command.
      { type: "result", seq: "3" },
      { type: "error", seq: null, message: "boom" },
      // detached: numeric tabId.
      { type: "detached", tabId: "1", reason: "cancel" },
      // pageShare: requestId must correlate a pending page-share request.
      { type: "pageShare" },
      { type: "pageShare", requestId: 1.5, payload: {} },
    ];
    for (const frame of cases) {
      expect(parseExtensionMessage(JSON.stringify(frame))).toBeNull();
    }
  });
});
