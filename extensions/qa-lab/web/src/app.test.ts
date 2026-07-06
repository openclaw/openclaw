// Qa Lab web app tests cover bounded HTTP helpers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "./app.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("QA Lab web app fetchJson", () => {
  it("rejects oversized JSON responses before buffering them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`{"x":"${"x".repeat(20 * 1024 * 1024)}"}`, {
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(fetchJson("/api/test")).rejects.toThrow(/qa-lab web: JSON response exceeds/);
  });

  it("surfaces server error payloads when available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "scenario failed" }), {
            status: 500,
            statusText: "Internal Server Error",
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(fetchJson("/api/test")).rejects.toThrow("scenario failed");
  });
});
