import { describe, expect, it, vi } from "vitest";
import { lookupTelegramChatId } from "./api-fetch.js";
import { telegramPlugin } from "./channel.js";

vi.mock("./api-fetch.js", () => ({
  lookupTelegramChatId: vi.fn(),
}));

describe("telegram resolveTargets integration", () => {
  it("passes proxy and apiRoot config parameters to lookupTelegramChatId", async () => {
    const lookupMock = vi.mocked(lookupTelegramChatId);
    lookupMock.mockResolvedValue("99999");

    const cfg = {
      channels: {
        telegram: {
          botToken: "123456:ABC-DEF",
          proxy: "http://my-proxy",
          apiRoot: "https://my-api-root",
        },
      },
    } as any;

    const resolveTargets = telegramPlugin.resolver?.resolveTargets;
    expect(resolveTargets).toBeDefined();

    const results = await resolveTargets!({
      cfg,
      accountId: "default",
      inputs: ["@testuser"],
      kind: "user",
      runtime: { log: vi.fn(), error: vi.fn() } as any,
    });

    expect(results).toEqual([
      {
        input: "@testuser",
        resolved: true,
        id: "99999",
        name: "@testuser",
      },
    ]);

    expect(lookupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        proxyUrl: "http://my-proxy",
        apiRoot: "https://my-api-root",
      }),
    );
  });
});
