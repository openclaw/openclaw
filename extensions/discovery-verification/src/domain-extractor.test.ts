import { describe, expect, it } from "vitest";
import { extractDomain, isNetworkTool } from "./domain-extractor.js";

describe("isNetworkTool", () => {
  it("recognizes web_fetch", () => {
    expect(isNetworkTool("web_fetch")).toBe(true);
  });
  it("recognizes web_search", () => {
    expect(isNetworkTool("web_search")).toBe(true);
  });
  it("rejects local tools", () => {
    expect(isNetworkTool("read_file")).toBe(false);
    expect(isNetworkTool("bash")).toBe(false);
  });
});

describe("extractDomain", () => {
  it("returns the host from a url param", () => {
    expect(extractDomain("web_fetch", { url: "https://example.com/foo" })).toBe("example.com");
  });

  it("lowercases the host", () => {
    expect(extractDomain("web_fetch", { url: "https://Example.COM/foo" })).toBe("example.com");
  });

  it("strips ports", () => {
    expect(extractDomain("web_fetch", { url: "https://example.com:8443/foo" })).toBe(
      "example.com",
    );
  });

  it("falls back to uri then endpoint then target", () => {
    expect(extractDomain("web_fetch", { uri: "https://a.example.com/" })).toBe("a.example.com");
    expect(extractDomain("web_fetch", { endpoint: "https://b.example.com/" })).toBe(
      "b.example.com",
    );
    expect(extractDomain("web_fetch", { target: "https://c.example.com/" })).toBe(
      "c.example.com",
    );
  });

  it("returns null for non-network tools", () => {
    expect(extractDomain("read_file", { url: "https://example.com" })).toBeNull();
  });

  it("returns null for missing url", () => {
    expect(extractDomain("web_fetch", {})).toBeNull();
  });

  it("returns null for malformed urls", () => {
    expect(extractDomain("web_fetch", { url: "not a url" })).toBeNull();
  });

  it("returns null for non-http(s) schemes", () => {
    expect(extractDomain("web_fetch", { url: "ftp://example.com/" })).toBeNull();
    expect(extractDomain("web_fetch", { url: "file:///etc/passwd" })).toBeNull();
  });

  it("returns null for localhost", () => {
    expect(extractDomain("web_fetch", { url: "https://localhost/foo" })).toBeNull();
  });

  it("returns null for IPv4 literals", () => {
    expect(extractDomain("web_fetch", { url: "https://192.168.1.1/foo" })).toBeNull();
    expect(extractDomain("web_fetch", { url: "https://1.2.3.4/" })).toBeNull();
  });

  it("returns null for IPv6 literals", () => {
    expect(extractDomain("web_fetch", { url: "https://[::1]/" })).toBeNull();
  });
});
