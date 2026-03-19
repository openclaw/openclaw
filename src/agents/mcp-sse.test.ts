import { describe, expect, it } from "vitest";
import { describeSseMcpServerLaunchConfig, resolveSseMcpServerLaunchConfig } from "./mcp-sse.js";

describe("resolveSseMcpServerLaunchConfig", () => {
  it("resolves a valid https URL", () => {
    const result = resolveSseMcpServerLaunchConfig({
      url: "https://mcp.example.com/sse",
    });
    expect(result).toEqual({
      ok: true,
      config: {
        url: "https://mcp.example.com/sse",
        headers: undefined,
      },
    });
  });

  it("resolves a valid http URL", () => {
    const result = resolveSseMcpServerLaunchConfig({
      url: "http://localhost:3000/sse",
    });
    expect(result).toEqual({
      ok: true,
      config: {
        url: "http://localhost:3000/sse",
        headers: undefined,
      },
    });
  });

  it("includes headers when provided", () => {
    const result = resolveSseMcpServerLaunchConfig({
      url: "https://mcp.example.com/sse",
      headers: {
        Authorization: "Bearer token123",
        "X-Custom": "value",
      },
    });
    expect(result).toEqual({
      ok: true,
      config: {
        url: "https://mcp.example.com/sse",
        headers: {
          Authorization: "Bearer token123",
          "X-Custom": "value",
        },
      },
    });
  });

  it("coerces numeric and boolean header values to strings", () => {
    const result = resolveSseMcpServerLaunchConfig({
      url: "https://mcp.example.com/sse",
      headers: { "X-Count": 42, "X-Debug": true },
    });
    expect(result).toEqual({
      ok: true,
      config: {
        url: "https://mcp.example.com/sse",
        headers: { "X-Count": "42", "X-Debug": "true" },
      },
    });
  });

  it("rejects non-object input", () => {
    const result = resolveSseMcpServerLaunchConfig("not-an-object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("must be an object");
    }
  });

  it("rejects missing url", () => {
    const result = resolveSseMcpServerLaunchConfig({ command: "npx" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("url is missing");
    }
  });

  it("rejects empty url", () => {
    const result = resolveSseMcpServerLaunchConfig({ url: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("url is missing");
    }
  });

  it("rejects invalid URL format", () => {
    const result = resolveSseMcpServerLaunchConfig({ url: "not-a-url" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not a valid URL");
    }
  });

  it("rejects non-http protocols", () => {
    const result = resolveSseMcpServerLaunchConfig({ url: "ftp://example.com/sse" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("only http and https");
    }
  });

  it("trims whitespace from url", () => {
    const result = resolveSseMcpServerLaunchConfig({
      url: "  https://mcp.example.com/sse  ",
    });
    expect(result).toEqual({
      ok: true,
      config: {
        url: "https://mcp.example.com/sse",
        headers: undefined,
      },
    });
  });
});

describe("describeSseMcpServerLaunchConfig", () => {
  it("returns the url", () => {
    expect(describeSseMcpServerLaunchConfig({ url: "https://mcp.example.com/sse" })).toBe(
      "https://mcp.example.com/sse",
    );
  });
});
