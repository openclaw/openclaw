import { describe, expect, it, vi } from "vitest";
import { runFirecrawlScrape } from "./firecrawl-client.js";
import { resolvePinnedHostnameWithPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: vi.fn(),
  };
});

describe("firecrawl dns pinning", () => {
  it("pins the hostname to the resolved IP in the scrape request", async () => {
    const mockIp = "93.184.216.34"; // example.com
    vi.mocked(resolvePinnedHostnameWithPolicy).mockResolvedValue({
      addresses: [mockIp],
      hostname: "example.com",
    });

    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { markdown: "# Mocked Content" },
          }),
        ),
    );
    global.fetch = fetchSpy as typeof fetch;

    await runFirecrawlScrape({
      cfg: {
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: "test-key",
                  baseUrl: "https://api.firecrawl.dev",
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      url: "https://example.com/page",
      extractMode: "markdown",
    });

    expect(resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("example.com");
    
    const fetchCall = fetchSpy.mock.calls[0];
    const fetchBody = JSON.parse(fetchCall[1].body as string);
    
    // The critical assertion: the URL sent to Firecrawl must use the IP, not the hostname.
    expect(fetchBody.url).toBe(`https://${mockIp}/page`);
  });
});
