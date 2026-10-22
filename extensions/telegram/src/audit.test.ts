import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let collectTelegramUnmentionedGroupIds: typeof import("./audit.js").collectTelegramUnmentionedGroupIds;
let auditTelegramGroupMembership: typeof import("./audit.js").auditTelegramGroupMembership;
const fetchWithTimeoutMock = vi.hoisted(() => vi.fn());
const member = { ok: true, result: { status: "member" } };

vi.mock("openclaw/plugin-sdk/text-utility-runtime", () => ({
  fetchWithTimeout: fetchWithTimeoutMock,
}));

function auditGroups(groupIds = ["-1001"], timeoutMs = 5000) {
  return auditTelegramGroupMembership({ token: "t", botId: 123, groupIds, timeoutMs });
}

function makeStallingMembershipResponse(cancel: (reason?: unknown) => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(member)));
      },
      cancel,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("telegram audit", () => {
  beforeAll(async () => {
    // mock-isolation: Membership auditing uses controlled responses without opening live Telegram dispatchers.
    vi.doMock("./fetch.js", () => ({
      resolveTelegramApiBase: () => "https://api.telegram.org",
      resolveTelegramTransport: () => ({ fetch: fetchWithTimeoutMock, close: async () => {} }),
    }));
    ({ collectTelegramUnmentionedGroupIds, auditTelegramGroupMembership } =
      await import("./audit.js"));
  });

  beforeEach(() => {
    fetchWithTimeoutMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("collects unmentioned numeric group ids and flags wildcard", () => {
    const res = collectTelegramUnmentionedGroupIds({
      "*": { requireMention: false },
      "-1001": { requireMention: false },
      "@group": { requireMention: false },
      "-1002": { requireMention: true },
      "-1003": { requireMention: false, enabled: false },
    });
    expect(res).toEqual({
      hasWildcardUnmentionedGroups: true,
      groupIds: ["-1001"],
      unresolvedGroups: 1,
    });
  });

  it("reports bot not in group when status is left", async () => {
    fetchWithTimeoutMock.mockResolvedValueOnce(
      Response.json({ ok: true, result: { status: "left" } }),
    );
    expect(await auditGroups()).toMatchObject({
      ok: false,
      groups: [{ ok: false, status: "left" }],
    });
  });

  it.each([
    { name: "stalled body", delay: 0, remaining: 50, groupIds: ["-1001"] },
    { name: "shared timeout budget", delay: 40, remaining: 10, groupIds: ["-1001", "-1002"] },
  ])("cancels the $name within the remaining budget", async ({ delay, remaining, groupIds }) => {
    const cancel = vi.fn();
    if (delay) {
      fetchWithTimeoutMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(Response.json(member)), delay);
          }),
      );
    }
    fetchWithTimeoutMock.mockResolvedValueOnce(makeStallingMembershipResponse(cancel));

    vi.useFakeTimers();
    const auditPromise = auditGroups(groupIds, 50);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(await auditPromise).toMatchObject({
      ok: false,
      groups: [
        ...(delay ? [{ ok: true }] : []),
        {
          ok: false,
          error: `Telegram membership audit response body stalled for ${remaining / 2}ms`,
        },
      ],
    });
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      groupIds.length,
      expect.stringContaining(`chat_id=${groupIds.at(-1)}`),
      {},
      remaining,
      fetchWithTimeoutMock,
    );
    expect(cancel).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
  });
});
