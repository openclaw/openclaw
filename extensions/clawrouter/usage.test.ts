import { describe, expect, it, vi } from "vitest";
import { fetchClawRouterUsage } from "./usage.js";

function oversizedJsonResponse(): {
  response: Response;
  state: { canceled: boolean; enqueuedBytes: number };
} {
  const state = { canceled: false, enqueuedBytes: 0 };
  const chunk = 1024 * 1024;
  const maxChunks = 64;
  let emitted = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (emitted >= maxChunks) {
          controller.close();
          return;
        }
        emitted += 1;
        state.enqueuedBytes += chunk;
        controller.enqueue(new Uint8Array(chunk));
      },
      cancel() {
        state.canceled = true;
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  return { response, state };
}

describe("ClawRouter usage", () => {
  it("maps the managed monthly budget and usage totals", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        budget: {
          configured: true,
          ledger: "durable_object",
          windowKey: "default/test-policy/2026-07",
          limitMicros: 100_000_000,
          spentMicros: 25_000_000,
          remainingMicros: 75_000_000,
        },
        usage: {
          summary: {
            requestCount: 12,
            totalTokens: 34_567,
            actualCostMicros: 25_000_000,
          },
        },
      }),
    );

    const snapshot = await fetchClawRouterUsage({
      token: "proxy-key",
      baseUrl: "https://clawrouter.example/v1",
      timeoutMs: 5000,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(snapshot).toEqual({
      provider: "clawrouter",
      displayName: "ClawRouter",
      windows: [
        {
          label: "Monthly budget",
          usedPercent: 25,
          resetAt: Date.UTC(2026, 7, 1),
        },
      ],
      summary: "12 requests · 34,567 tokens · $25.00 used",
      plan: "Managed monthly budget",
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://clawrouter.example/v1/usage",
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          Authorization: "Bearer proxy-key",
        },
      }),
    );
  });

  it("shows aggregate usage for an unmetered key", async () => {
    const snapshot = await fetchClawRouterUsage({
      token: "proxy-key",
      timeoutMs: 5000,
      fetchFn: vi.fn(async () =>
        Response.json({
          budget: { configured: false, ledger: "unmetered" },
          usage: { summary: { requestCount: 0, totalTokens: 0, actualCostMicros: 0 } },
        }),
      ) as unknown as typeof fetch,
    });

    expect(snapshot.windows).toEqual([]);
    expect(snapshot.summary).toBe("0 requests · 0 tokens · $0.00 used");
    expect(snapshot.plan).toBe("Unmetered proxy key");
  });

  it("rejects oversized successful JSON responses before buffering the whole body", async () => {
    const { response, state } = oversizedJsonResponse();

    await expect(
      fetchClawRouterUsage({
        token: "proxy-key",
        timeoutMs: 5000,
        fetchFn: vi.fn(async () => response) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("ClawRouter usage: JSON response exceeds 16777216 bytes");
    expect(state.canceled).toBe(true);
    expect(state.enqueuedBytes).toBeLessThan(64 * 1024 * 1024);
  });

  it("does not expose an upstream error body", async () => {
    await expect(
      fetchClawRouterUsage({
        token: "proxy-key",
        timeoutMs: 5000,
        fetchFn: vi.fn(
          async () => new Response("secret details", { status: 403 }),
        ) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("ClawRouter usage request failed (HTTP 403)");
  });
});
