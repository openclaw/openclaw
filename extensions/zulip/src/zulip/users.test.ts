import { describe, expect, it, vi } from "vitest";
import type { ZulipClient } from "./client.js";
import { resolveUserIdsForEmails } from "./users.js";

describe("resolveUserIdsForEmails", () => {
  it("resolves by delivery_email when email is redacted", async () => {
    const client: ZulipClient = {
      baseUrl: "https://zulip.example.com",
      email: "bot@example.com",
      apiKey: "x",
    };

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            result: "success",
            members: [
              { user_id: 1, delivery_email: "alice@example.com" },
              { user_id: 2, email: "bob@example.com" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveUserIdsForEmails(client, ["Alice@Example.com", "bob@example.com"]),
    ).resolves.toEqual([1, 2]);

    // should have fetched /api/v1/users exactly once
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/api/v1/users");
  });
});
