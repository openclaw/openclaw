import { describe, expect, it, vi } from "vitest";
import { fetchOpenRouterUsage } from "./usage.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("openrouter usage", () => {
  it("reports account credits as native dollar labels", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/credits")) {
        return jsonResponse({
          data: {
            total_credits: 21.24,
            total_usage: 8.9,
          },
        });
      }
      if (href.endsWith("/key")) {
        return jsonResponse({
          data: {
            limit: 25,
            limit_remaining: 17.5,
            limit_reset: "monthly",
          },
        });
      }
      throw new Error(`Unexpected URL: ${href}`);
    });

    const snapshot = await fetchOpenRouterUsage("or-token", 1000, fetchFn as typeof fetch);

    expect(snapshot).toEqual({
      provider: "openrouter",
      displayName: "OpenRouter",
      windows: [
        {
          label: "Credits",
          usedPercent: expect.closeTo(41.902, 3),
          remainingLabel: "$12.34",
          usedLabel: "$8.90",
          totalLabel: "$21.24",
        },
        {
          label: "Key limit (monthly)",
          usedPercent: 30,
          remainingLabel: "$17.50",
          totalLabel: "$25.00",
        },
      ],
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/credits",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer or-token" }),
      }),
    );
  });

  it("uses key usage when account credits are not available", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith("/credits")) {
        return jsonResponse({ error: "forbidden" }, 403);
      }
      if (href.endsWith("/key")) {
        return jsonResponse({
          data: {
            usage: 1.23,
          },
        });
      }
      throw new Error(`Unexpected URL: ${href}`);
    });

    await expect(fetchOpenRouterUsage("or-token", 1000, fetchFn as typeof fetch)).resolves.toEqual({
      provider: "openrouter",
      displayName: "OpenRouter",
      windows: [
        {
          label: "Key usage",
          usedPercent: 0,
          usedLabel: "$1.23",
          remainingLabel: "unlimited",
        },
      ],
    });
  });
});
