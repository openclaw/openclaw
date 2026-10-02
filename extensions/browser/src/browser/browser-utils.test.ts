// Browser tests cover browser utils plugin behavior.
import { describe, expect, it } from "vitest";
import {
  appendCdpPath,
  getHeadersWithAuth,
  normalizeCdpHttpBaseForJsonEndpoints,
} from "./cdp.helpers.js";
import { toBoolean } from "./routes/utils.js";
import { resolveTargetIdFromTabs } from "./target-id.js";

describe("toBoolean", () => {
  it("parses yes/no and 1/0", () => {
    expect(toBoolean("yes")).toBe(true);
    expect(toBoolean("1")).toBe(true);
    expect(toBoolean("no")).toBe(false);
    expect(toBoolean("0")).toBe(false);
  });

  it("returns undefined for on/off strings", () => {
    expect(toBoolean("on")).toBeUndefined();
    expect(toBoolean("off")).toBeUndefined();
  });

  it("passes through boolean values", () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(false)).toBe(false);
  });
});

describe("browser target id resolution", () => {
  it("fails when no tab matches", () => {
    const res = resolveTargetIdFromTabs("NOPE", [{ targetId: "AAA" }]);
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("cdp.helpers", () => {
  it("preserves query params when appending CDP paths", () => {
    const url = appendCdpPath("https://example.com?token=abc", "/json/version");
    expect(url).toBe("https://example.com/json/version?token=abc");
  });

  it("appends paths under a base prefix", () => {
    const url = appendCdpPath("https://example.com/chrome/?token=abc", "json/list");
    expect(url).toBe("https://example.com/chrome/json/list?token=abc");
  });

  it("preserves auth and query params when normalizing secure loopback WebSocket CDP URLs", () => {
    const url = normalizeCdpHttpBaseForJsonEndpoints(
      "wss://user:pass@127.0.0.1:9222/devtools/browser/ABC?token=abc",
    );
    expect(url).toBe("https://user:pass@127.0.0.1:9222/?token=abc");
  });

  it("strips a trailing /cdp suffix when normalizing HTTP bases", () => {
    const url = normalizeCdpHttpBaseForJsonEndpoints("ws://127.0.0.1:9222/cdp?token=abc");
    expect(url).toBe("http://127.0.0.1:9222/?token=abc");
  });

  it("preserves base prefixes when stripping a trailing /cdp suffix", () => {
    const url = normalizeCdpHttpBaseForJsonEndpoints("ws://127.0.0.1:9222/browser/cdp?token=abc");
    expect(url).toBe("http://127.0.0.1:9222/browser?token=abc");
  });

  it("decodes percent-encoded basic auth credentials from URLs", () => {
    const headers = getHeadersWithAuth("https://alice:p%40ss%20word@example.com");
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("alice:p@ss word").toString("base64")}`,
    );
  });

  it("keeps preexisting authorization headers", () => {
    const headers = getHeadersWithAuth("https://user:pass@example.com", {
      Authorization: "Bearer token",
    });
    expect(headers.Authorization).toBe("Bearer token");
  });

  it("does not add custom headers when none are required", () => {
    expect(getHeadersWithAuth("http://127.0.0.1:19444/json/version")).toStrictEqual({});
  });
});
