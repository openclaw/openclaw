import { describe, expect, it } from "vitest";
import { isAllowedConnectHost } from "./mitm-server.js";

describe("isAllowedConnectHost", () => {
  it("allows the MITM upstream host", () => {
    expect(isAllowedConnectHost("api.anthropic.com")).toBe(true);
  });

  it("allows other anthropic.com subdomains (pass-through, undecrypted)", () => {
    expect(isAllowedConnectHost("statsig.anthropic.com")).toBe(true);
    expect(isAllowedConnectHost("console.anthropic.com")).toBe(true);
  });

  it("is case-insensitive and trims", () => {
    expect(isAllowedConnectHost("  API.Anthropic.Com ")).toBe(true);
  });

  it("refuses unrelated hosts (fail closed)", () => {
    expect(isAllowedConnectHost("datadoghq.com")).toBe(false);
    expect(isAllowedConnectHost("sentry.io")).toBe(false);
    expect(isAllowedConnectHost("example.com")).toBe(false);
    expect(isAllowedConnectHost("")).toBe(false);
  });

  // Suffix matching is dot-anchored so look-alike hosts cannot impersonate an
  // anthropic.com subdomain.
  it("refuses look-alike hosts that only resemble anthropic.com", () => {
    expect(isAllowedConnectHost("evil-anthropic.com")).toBe(false);
    expect(isAllowedConnectHost("anthropic.com.evil.test")).toBe(false);
    expect(isAllowedConnectHost("notanthropic.com")).toBe(false);
    // bare apex (no subdomain) is not a host claude connects to → refused
    expect(isAllowedConnectHost("anthropic.com")).toBe(false);
  });
});
