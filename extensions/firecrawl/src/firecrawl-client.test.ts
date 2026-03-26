import { describe, expect, it } from "vitest";
import { assertFirecrawlUrlAllowed } from "./firecrawl-client.js";

describe("assertFirecrawlUrlAllowed", () => {
  it("allows normal HTTPS URLs", () => {
    expect(() => assertFirecrawlUrlAllowed("https://example.com")).not.toThrow();
    expect(() => assertFirecrawlUrlAllowed("https://docs.github.com/en/rest")).not.toThrow();
  });

  it("allows normal HTTP URLs", () => {
    expect(() => assertFirecrawlUrlAllowed("http://example.com/page")).not.toThrow();
  });

  it("blocks non-HTTP protocols", () => {
    expect(() => assertFirecrawlUrlAllowed("ftp://example.com")).toThrow(/non-HTTP/i);
    expect(() => assertFirecrawlUrlAllowed("file:///etc/passwd")).toThrow(/non-HTTP/i);
    expect(() => assertFirecrawlUrlAllowed("javascript:void(0)")).toThrow(/non-HTTP/i);
  });

  it("blocks localhost hostnames", () => {
    expect(() => assertFirecrawlUrlAllowed("http://localhost")).toThrow(/Blocked hostname/);
    expect(() => assertFirecrawlUrlAllowed("http://localhost:8080/path")).toThrow(
      /Blocked hostname/,
    );
  });

  it("blocks metadata service endpoints", () => {
    expect(() => assertFirecrawlUrlAllowed("http://metadata.google.internal")).toThrow(
      /Blocked hostname/,
    );
    expect(() =>
      assertFirecrawlUrlAllowed("http://metadata.google.internal/computeMetadata/v1/"),
    ).toThrow(/Blocked hostname/);
  });

  it("blocks private/internal IP addresses", () => {
    expect(() => assertFirecrawlUrlAllowed("http://127.0.0.1")).toThrow(/Blocked hostname/);
    expect(() => assertFirecrawlUrlAllowed("http://10.0.0.1")).toThrow(/Blocked hostname/);
    expect(() => assertFirecrawlUrlAllowed("http://169.254.169.254")).toThrow(/Blocked hostname/);
    expect(() => assertFirecrawlUrlAllowed("http://192.168.1.1")).toThrow(/Blocked hostname/);
  });

  it("throws on malformed URLs without leaking the URL in the error", () => {
    try {
      assertFirecrawlUrlAllowed("not-a-valid-url");
      expect.fail("Expected an error to be thrown");
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).toContain("Invalid URL supplied to Firecrawl");
      // The error must NOT contain the original input to avoid credential leakage.
      expect(msg).not.toContain("not-a-valid-url");
    }
  });

  it("throws on empty string without leaking it", () => {
    expect(() => assertFirecrawlUrlAllowed("")).toThrow("Invalid URL supplied to Firecrawl");
  });
});
