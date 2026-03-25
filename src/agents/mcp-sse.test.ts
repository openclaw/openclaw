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

  it("redacts sensitive query params in invalid URL errors", () => {
    const result = resolveSseMcpServerLaunchConfig({
      url: "mcp.example.com/sse?token=secret123&api_key=key456",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("token=***");
      expect(result.reason).toContain("api_key=***");
      expect(result.reason).not.toContain("secret123");
      expect(result.reason).not.toContain("key456");
    }
  });

  it("redacts embedded credentials in invalid URL errors", () => {
    const result = resolveSseMcpServerLaunchConfig({
      url: "//user:pass@mcp.example.com/sse",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("***:***@");
      expect(result.reason).not.toContain("user:pass");
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

  it("redacts embedded credentials", () => {
    const result = describeSseMcpServerLaunchConfig({
      url: "https://user:pass@mcp.example.com/sse",
    });
    expect(result).toContain("***:***@");
    expect(result).not.toContain("user");
    expect(result).not.toContain("pass@");
  });

  it("redacts all sensitive query params", () => {
    const sensitiveParams = [
      "token",
      "key",
      "api_key",
      "apikey",
      "secret",
      "access_token",
      "password",
      "pass",
      "auth",
      "client_secret",
      "refresh_token",
    ];
    for (const param of sensitiveParams) {
      const result = describeSseMcpServerLaunchConfig({
        url: `https://mcp.example.com/sse?${param}=supersecret`,
      });
      expect(result).toContain(`${param}=***`);
      expect(result).not.toContain("supersecret");
    }
  });
});
