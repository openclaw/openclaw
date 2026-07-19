import { describe, expect, it, vi } from "vitest";
import { fetchAndExtractSandboxed } from "./sandboxed-fetch.js";

describe("fetchAndExtractSandboxed", () => {
  it("falls back to in-process fetch+extract when no sandboxExecKey is given", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response("<html><body><p>Hello from a fake page</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ) as unknown as typeof fetch;
    try {
      const result = await fetchAndExtractSandboxed({ url: "https://example.com", maxChars: 500 });
      expect("text" in result).toBe(true);
      if ("text" in result) {
        expect(result.text).toContain("Hello from a fake page");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a blocked error for a private-IP URL, without dispatching anywhere", async () => {
    const result = await fetchAndExtractSandboxed({ url: "http://192.168.1.1/", maxChars: 500 });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/blocked/i);
    }
  });
});
