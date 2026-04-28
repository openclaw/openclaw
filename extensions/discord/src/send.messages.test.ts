import { describe, expect, it, vi } from "vitest";

const restMock = {
  get: vi.fn(),
};

vi.mock("./send.shared.js", () => ({
  resolveDiscordRest: () => restMock,
}));

const { readMessagesDiscord, searchMessagesDiscord, DISCORD_REST_ACTION_TIMEOUT_MS } =
  await import("./send.messages.js");

describe("readMessagesDiscord", () => {
  it("returns messages when the REST call resolves promptly", async () => {
    const messages = [{ id: "1", content: "hello" }];
    restMock.get.mockResolvedValueOnce(messages);

    const result = await readMessagesDiscord("C1", { limit: 5 }, { cfg: {} as never });

    expect(result).toEqual(messages);
    expect(restMock.get).toHaveBeenCalledWith(expect.stringContaining("C1"), { limit: 5 });
  });

  it(
    "rejects with a timeout error when the REST call hangs",
    async () => {
      restMock.get.mockReturnValueOnce(new Promise(() => {}));

      await expect(readMessagesDiscord("C1", {}, { cfg: {} as never })).rejects.toThrow(
        /Discord read timed out/,
      );
    },
    DISCORD_REST_ACTION_TIMEOUT_MS + 5_000,
  );
});

describe("searchMessagesDiscord", () => {
  it("returns results when the REST call resolves promptly", async () => {
    const results = { messages: [[{ id: "1" }]], total_results: 1 };
    restMock.get.mockResolvedValueOnce(results);

    const result = await searchMessagesDiscord(
      { guildId: "G1", content: "test", limit: 1 },
      { cfg: {} as never },
    );

    expect(result).toEqual(results);
  });

  it(
    "rejects with a timeout error when the REST call hangs",
    async () => {
      restMock.get.mockReturnValueOnce(new Promise(() => {}));

      await expect(
        searchMessagesDiscord({ guildId: "G1", content: "test" }, { cfg: {} as never }),
      ).rejects.toThrow(/Discord search timed out/);
    },
    DISCORD_REST_ACTION_TIMEOUT_MS + 5_000,
  );
});

describe("DISCORD_REST_ACTION_TIMEOUT_MS", () => {
  it("is a reasonable bounded value", () => {
    expect(DISCORD_REST_ACTION_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(DISCORD_REST_ACTION_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
