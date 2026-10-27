// Feishu tests cover bot sender name resolution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedFeishuAccount } from "./types.js";

const requestMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: vi.fn(() => ({ request: requestMock })),
}));

type ResolveFeishuBotName = typeof import("./bot-name.js").resolveFeishuBotName;

let resolveFeishuBotName: ResolveFeishuBotName;

const account = {
  accountId: "main",
  configured: true,
  config: {},
} as ResolvedFeishuAccount;
const log = vi.fn();

describe("resolveFeishuBotName", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ resolveFeishuBotName } = await import("./bot-name.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves and caches the bot display name", async () => {
    requestMock.mockResolvedValue({
      code: 0,
      data: { bots: { ou_peer: { name: "Peer Bot" } } },
    });

    await expect(resolveFeishuBotName({ account, openId: "ou_peer", log })).resolves.toBe(
      "Peer Bot",
    );
    await expect(resolveFeishuBotName({ account, openId: "ou_peer", log })).resolves.toBe(
      "Peer Bot",
    );

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["rejected missing-scope requests", true, 99991672],
    ["resolved missing-scope envelopes", false, 99991672],
    ["rejected provider failures", true, 999],
    ["resolved provider failures", false, 999],
  ] as const)("recovers after a short cooldown for repeated %s", async (_name, rejects, code) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    if (rejects) {
      const error = Object.assign(new Error("lookup unavailable"), {
        response: { data: { code } },
      });
      requestMock.mockRejectedValue(error);
    } else {
      requestMock.mockResolvedValue({ code, msg: "lookup unavailable" });
    }

    for (let index = 0; index < 10; index += 1) {
      await resolveFeishuBotName({ account, openId: `ou_missing_${index}`, log });
      await resolveFeishuBotName({ account, openId: `ou_suppressed_${index}`, log });
      expect(requestMock).toHaveBeenCalledTimes(index + 1);
      vi.advanceTimersByTime(60_001);
    }
    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { bots: { ou_available: { name: "Available" } } },
    });

    await expect(resolveFeishuBotName({ account, openId: "ou_available", log })).resolves.toBe(
      "Available",
    );
    expect(requestMock).toHaveBeenCalledTimes(11);
  });

  it("deduplicates concurrent lookups for one account and bot", async () => {
    const { promise, resolve: release } = Promise.withResolvers<unknown>();
    requestMock.mockReturnValue(promise);

    const first = resolveFeishuBotName({ account, openId: "ou_peer", log });
    const second = resolveFeishuBotName({ account, openId: "ou_peer", log });
    release?.({ code: 0, data: { bots: { ou_peer: { name: "Peer Bot" } } } });

    await expect(Promise.all([first, second])).resolves.toEqual(["Peer Bot", "Peer Bot"]);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
