import { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { resolveSlackWebClientOptions, type SlackProxyDispatcher } from "./client-options.js";

const mocks = vi.hoisted(() => ({
  fetchWithRuntimeDispatcher: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-fetch")>();
  return { ...actual, fetchWithRuntimeDispatcher: mocks.fetchWithRuntimeDispatcher };
});

describe("Slack built-in fetch options", () => {
  it("omits the SDK's explicit empty body while preserving its request dispatcher", async () => {
    mocks.fetchWithRuntimeDispatcher.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, team_id: "TMOCK", user_id: "UMOCK" }), {
        status: 200,
      }),
    );
    const dispatcher = {} as SlackProxyDispatcher;
    const client = new WebClient(
      "xoxb-built-in-empty-body-proof",
      resolveSlackWebClientOptions({}, dispatcher),
    );

    await expect(client.auth.test()).resolves.toMatchObject({ ok: true });
    expect(mocks.fetchWithRuntimeDispatcher).toHaveBeenCalledOnce();
    const [, init] = mocks.fetchWithRuntimeDispatcher.mock.calls[0] ?? [];
    expect(init).toMatchObject({ method: "POST", dispatcher });
    expect(init).not.toHaveProperty("body");
  });
});
