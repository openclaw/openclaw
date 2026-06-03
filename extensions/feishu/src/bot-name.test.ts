import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetBotNameStateForTests,
  enrichMentionBotNames,
  resolveFeishuBotName,
  resolveFeishuBotNames,
} from "./bot-name.js";
import type { MentionTarget } from "./mention-target.types.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

const log = vi.fn();

const account = {
  accountId: "acc-1",
  selectionSource: "explicit",
  enabled: true,
  configured: true,
  domain: "feishu",
  appId: "cli_app1",
  appSecret: "secret_app1", // pragma: allowlist secret
  config: {},
} as ResolvedFeishuAccount;

const account2 = {
  ...account,
  accountId: "acc-2",
  appId: "cli_app2",
} as ResolvedFeishuAccount;

function mockClient(request: ReturnType<typeof vi.fn>) {
  createFeishuClientMock.mockReturnValue({ request });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  resetBotNameStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveFeishuBotNames", () => {
  it("returns names for hits and writes positive cache", async () => {
    const request = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        bots: { ou_a: { bot_id: "ou_a", name: "AlertBot" } },
        failed_bots: {},
      },
    });
    mockClient(request);

    const r1 = await resolveFeishuBotNames({ account, openIds: ["ou_a"], log });
    expect(r1.get("ou_a")).toBe("AlertBot");
    expect(request).toHaveBeenCalledTimes(1);

    // Second call should hit cache, no new request.
    const r2 = await resolveFeishuBotNames({ account, openIds: ["ou_a"], log });
    expect(r2.get("ou_a")).toBe("AlertBot");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("collapses failed_bots into negative cache (60s)", async () => {
    const request = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        bots: {},
        failed_bots: { ou_missing: { code: 20002, reason: "bot not found" } },
      },
    });
    mockClient(request);

    const r1 = await resolveFeishuBotNames({ account, openIds: ["ou_missing"], log });
    expect(r1.get("ou_missing")).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);

    // Within negative cache window — no new RPC.
    const r2 = await resolveFeishuBotNames({ account, openIds: ["ou_missing"], log });
    expect(r2.get("ou_missing")).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("auto-shards into chunks of 10", async () => {
    const request = vi.fn().mockImplementation(async ({ url }: { url: string }) => {
      const matches = [...url.matchAll(/bot_ids=([^&]+)/g)].map((m) => m[1] ?? "");
      const bots: Record<string, { bot_id: string; name: string }> = {};
      for (const ou of matches) {
        bots[ou] = { bot_id: ou, name: `Name-${ou}` };
      }
      return { code: 0, data: { bots, failed_bots: {} } };
    });
    mockClient(request);

    const ous = Array.from({ length: 11 }, (_, i) => `ou_${i}`);
    const result = await resolveFeishuBotNames({ account, openIds: ous, log });

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(11);
    expect(result.get("ou_0")).toBe("Name-ou_0");
    expect(result.get("ou_10")).toBe("Name-ou_10");
  });

  it("retries on internal error 20006 with exponential backoff", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ code: 20006, msg: "internal error" })
      .mockResolvedValueOnce({ code: 20006, msg: "internal error" })
      .mockResolvedValueOnce({
        code: 0,
        data: { bots: { ou_a: { bot_id: "ou_a", name: "Recovered" } }, failed_bots: {} },
      });
    mockClient(request);

    const promise = resolveFeishuBotNames({ account, openIds: ["ou_a"], log });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(request).toHaveBeenCalledTimes(3);
    expect(result.get("ou_a")).toBe("Recovered");
  });

  it("treats 99991672 (scope missing) as silent, returns empty without negative cache", async () => {
    const scopeError = Object.assign(new Error("scope missing"), {
      response: { data: { code: 99991672, msg: "permission denied" } },
    });
    const request = vi.fn().mockRejectedValue(scopeError);
    mockClient(request);

    const r1 = await resolveFeishuBotNames({ account, openIds: ["ou_a"], log });
    expect(r1.size).toBe(0);
    // No log warning for permission case (debug-level only).
    // No negative cache → if scope is granted later, the next call retries.
    const r2 = await resolveFeishuBotNames({ account, openIds: ["ou_a"], log });
    expect(r2.size).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("isolates cache by accountId so the same ou string does not bleed across apps", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: { bots: { ou_x: { bot_id: "ou_x", name: "AppOneBot" } }, failed_bots: {} },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { bots: { ou_x: { bot_id: "ou_x", name: "AppTwoBot" } }, failed_bots: {} },
      });
    mockClient(request);

    const r1 = await resolveFeishuBotNames({ account, openIds: ["ou_x"], log });
    expect(r1.get("ou_x")).toBe("AppOneBot");

    const r2 = await resolveFeishuBotNames({ account: account2, openIds: ["ou_x"], log });
    expect(r2.get("ou_x")).toBe("AppTwoBot");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("returns empty without RPC when account is not configured", async () => {
    const request = vi.fn();
    mockClient(request);
    const result = await resolveFeishuBotNames({
      account: { ...account, configured: false },
      openIds: ["ou_a"],
      log,
    });
    expect(result.size).toBe(0);
    expect(request).not.toHaveBeenCalled();
  });

  it("opens the breaker after 10 consecutive failures and short-circuits", async () => {
    const request = vi.fn().mockResolvedValue({ code: 20006, msg: "internal error" });
    mockClient(request);
    vi.useFakeTimers();

    // 10 failures, each retried 3 times → 30 calls total before breaker opens.
    for (let i = 0; i < 10; i++) {
      const p = resolveFeishuBotNames({ account, openIds: [`ou_${i}`], log });
      await vi.runAllTimersAsync();
      await p;
    }
    expect(request).toHaveBeenCalledTimes(30);

    // Breaker now open → no new RPC.
    const p = resolveFeishuBotNames({ account, openIds: ["ou_after"], log });
    await vi.runAllTimersAsync();
    await p;
    expect(request).toHaveBeenCalledTimes(30);
  });
});

describe("resolveFeishuBotName (single)", () => {
  it("returns the name for a single ou", async () => {
    const request = vi.fn().mockResolvedValue({
      code: 0,
      data: { bots: { ou_solo: { bot_id: "ou_solo", name: "Solo" } }, failed_bots: {} },
    });
    mockClient(request);
    const name = await resolveFeishuBotName({ account, openId: "ou_solo", log });
    expect(name).toBe("Solo");
  });
});

describe("enrichMentionBotNames", () => {
  it("only fetches bot mentions with empty name and fills them in place", async () => {
    const request = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        bots: { ou_botA: { bot_id: "ou_botA", name: "BotA" } },
        failed_bots: {},
      },
    });
    mockClient(request);

    const targets: MentionTarget[] = [
      { openId: "ou_user1", name: "Alice", key: "@_user_1", mentionedType: "user" },
      { openId: "ou_botA", name: "", key: "@_user_2", mentionedType: "bot" },
      { openId: "ou_botB", name: "ExistingName", key: "@_user_3", mentionedType: "bot" },
      { openId: "ou_user2", name: "Bob", key: "@_user_4", mentionedType: "user" },
    ];

    await enrichMentionBotNames({ account, targets, log });

    expect(targets[0]?.name).toBe("Alice");
    expect(targets[1]?.name).toBe("BotA"); // filled
    expect(targets[2]?.name).toBe("ExistingName"); // not refetched
    expect(targets[3]?.name).toBe("Bob");

    // Only ou_botA should have been queried.
    expect(request).toHaveBeenCalledTimes(1);
    const call = request.mock.calls[0]?.[0] as { url: string };
    expect(call.url).toContain("bot_ids=ou_botA");
    expect(call.url).not.toContain("ou_botB");
    expect(call.url).not.toContain("ou_user1");
  });

  it("is a no-op when there are no bot mentions needing fill", async () => {
    const request = vi.fn();
    mockClient(request);
    const targets: MentionTarget[] = [
      { openId: "ou_user1", name: "Alice", key: "@_user_1", mentionedType: "user" },
      { openId: "ou_user2", name: "Bob", key: "@_user_2" }, // mentionedType undefined
    ];
    await enrichMentionBotNames({ account, targets, log });
    expect(request).not.toHaveBeenCalled();
  });
});
