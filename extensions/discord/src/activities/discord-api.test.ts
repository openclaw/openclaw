import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDiscordJson } from "./discord-api.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", { spy: true });
afterEach(() => vi.mocked(fetchWithSsrFGuard).mockRestore());

describe("Discord Activity API", () => {
  it("cancels non-OK response bodies before releasing the dispatcher", async () => {
    const lifecycle: string[] = [];
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("unauthorized"));
        },
        cancel() {
          lifecycle.push("cancel");
        },
      }),
      { status: 401 },
    );
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response,
      finalUrl: "https://discord.com/api/v10/users/@me",
      release: async () => {
        lifecycle.push("release");
      },
    });

    await expect(
      fetchDiscordJson({
        url: "https://discord.com/api/v10/users/@me",
        init: { headers: { Authorization: "Bearer test-token" } },
        auditContext: "discord.activities.oauth.user",
      }),
    ).resolves.toEqual({ ok: false });
    expect(lifecycle).toEqual(["cancel", "release"]);
  });

  it("still releases a rejected response when cancellation fails", async () => {
    const response = new Response(
      new ReadableStream({
        cancel() {
          throw new Error("cancel failed");
        },
      }),
      { status: 429 },
    );
    const release = vi.fn(async () => undefined);
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response,
      finalUrl: "https://discord.com/api/v10/users/@me",
      release,
    });

    await expect(
      fetchDiscordJson({
        url: "https://discord.com/api/v10/users/@me",
        init: { headers: { Authorization: "Bearer test-token" } },
        auditContext: "discord.activities.oauth.user",
      }),
    ).resolves.toEqual({ ok: false });
    expect(release).toHaveBeenCalledOnce();
  });
});
