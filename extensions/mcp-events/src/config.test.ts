import { describe, expect, it } from "vitest";
import { resolveMcpEventsConfig } from "./config.js";

const baseUrl = (config: Record<string, unknown>) => resolveMcpEventsConfig(config).callbackBaseUrl;

describe("MCP Events callback base URL", () => {
  it.each([
    ["https://proxy.example.com/some/prefix", "https://proxy.example.com/some/prefix"],
    ["https://proxy.example.com/some/prefix/", "https://proxy.example.com/some/prefix"],
    ["https://proxy.example.com/some/prefix//", "https://proxy.example.com/some/prefix"],
    ["https://proxy.example.com", "https://proxy.example.com"],
    ["https://proxy.example.com/", "https://proxy.example.com"],
    ["https://Proxy.Example.com:443/Tenant", "https://proxy.example.com/Tenant"],
  ])("keeps the path prefix of %s", (callbackBaseUrl, expected) => {
    expect(baseUrl({ callbackBaseUrl })).toBe(expected);
  });

  it.each([
    "http://proxy.example.com/prefix",
    "https://user@proxy.example.com/prefix",
    "https://proxy.example.com/prefix?tenant=a",
    "https://proxy.example.com/prefix#a",
    "proxy.example.com/prefix",
    42,
  ])("rejects callbackBaseUrl %j", (callbackBaseUrl) => {
    expect(() => resolveMcpEventsConfig({ callbackBaseUrl })).toThrow(
      "MCP Events callbackBaseUrl must be a public HTTPS URL without credentials, query, or fragment",
    );
  });

  it("requires callbackBaseUrl; Doctor owns the retired callbackOrigin", () => {
    for (const config of [{}, undefined, { callbackOrigin: "https://events.example.com" }]) {
      expect(() => resolveMcpEventsConfig(config)).toThrow("Configure mcp-events.callbackBaseUrl");
    }
  });
});
