import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { Agent } from "undici/index.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { auditTelegramGroupMembership, collectTelegramUnmentionedGroupIds } from "./audit.js";

const rawFetch = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock("undici/index.js", async () => ({
  ...(await vi.importActual<typeof import("undici")>("undici/index.js")),
  fetch: rawFetch,
}));
const requests: Array<{ wire: string; dispatcher: Agent }> = [];
const membership = (status = "member") => Response.json({ ok: true, result: { status } });
const expectedRequests = (...chatIds: string[]) =>
  chatIds.map(
    (chatId) =>
      `GET https://api.telegram.org/bot123:fixture-token/getChatMember?chat_id=${chatId}&user_id=123\n`,
  );
const auditGroups = (groupIds = ["-1001"], timeoutMs = 5000) =>
  auditTelegramGroupMembership({
    token: "123:fixture-token",
    botId: 123,
    groupIds,
    timeoutMs,
    network: { autoSelectFamily: false },
  });
let respond: () => Response | Promise<Response>;

beforeEach(() => {
  requests.length = 0;
  for (const key of "HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy OPENCLAW_PROXY_URL OPENCLAW_PROXY_ACTIVE OPENCLAW_DEBUG_PROXY_ENABLED".split(
    " ",
  )) {
    vi.stubEnv(key, undefined);
  }
  rawFetch.mockReset().mockImplementation(async (input, init) => {
    const dispatcher = (init as RequestInit & { dispatcher?: unknown })?.dispatcher;
    if (!(dispatcher instanceof Agent)) {
      throw new Error("Membership audit did not provide its owned Agent");
    }
    const request = new Request(input, init);
    requests.push({
      wire: `${request.method} ${request.url}\n${await request.text()}`,
      dispatcher,
    });
    expect(dispatcher.destroyed).toBe(false);
    return respond();
  });
});
afterEach(async () => {
  await Promise.allSettled(requests.map(({ dispatcher }) => dispatcher.destroy()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

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
  respond = () => membership("left");
  expect(await auditGroups()).toMatchObject({
    ok: false,
    groups: [{ ok: false, status: "left" }],
  });
});

it.each([-60_000, 60_000] as const)(
  "keeps the audit deadline on the monotonic clock across a %s ms wall-clock jump",
  async (jumpMs) => {
    // Hold group 1's fetch across the wall-clock jump so the shared deadline is
    // re-read after the clock moved (the bug's discriminating boundary). Group 2's
    // response body is held idle, so the audit is bounded only by the recomputed
    // remaining budget (chunk-idle = half of it). Post-fix the remaining budget is
    // ~10s so the idle bound settles at ~45s total; pre-fix a forward jump clamps
    // it to ~1ms (settles almost immediately) and a backward jump inflates it
    // (does not settle within a reasonable window).
    respond = () =>
      requests.length === 1
        ? new Promise<Response>((resolve) => {
            setTimeout(() => resolve(membership("member")), 40_000);
          })
        : new Response(
            new ReadableStream<Uint8Array>({
              // Never emit; the body read stays pending until the budget bounds it.
              start() {},
            }),
          );
    vi.useFakeTimers();
    let settled = false;
    let result: Awaited<ReturnType<typeof auditGroups>> | undefined;
    const audit = auditGroups(["-1001", "-1002"], 50_000).then((value) => {
      settled = true;
      result = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + jumpMs);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(requests).toHaveLength(2);
    // Just after group 2 starts (40s), the audit must still be pending; by ~46s
    // it must have settled (bounded) within its recomputed budget.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(true);
    expect(result).toMatchObject({ ok: false, checkedGroups: 2 });
    await audit;
  },
);

it.each([
  { name: "stalled body", delay: 0, remaining: 50, groupIds: ["-1001"] },
  { name: "shared timeout budget", delay: 40, remaining: 10, groupIds: ["-1001", "-1002"] },
])("cancels the $name within the remaining budget", async ({ delay, remaining, groupIds }) => {
  const cancel = vi.fn();
  respond = () =>
    delay && requests.length === 1
      ? new Promise<Response>((resolve) => {
          setTimeout(() => resolve(membership()), delay);
        })
      : new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from('{"ok":true,"result":{"status":"member"}}'));
            },
            cancel,
          }),
        );
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
  expect(cancel).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
});

it.each(["network failure", "malformed JSON"] as const)(
  "closes its owned audit transport after %s without changing the request",
  async (outcome) => {
    respond = () => {
      if (outcome === "network failure") {
        throw new Error("membership fixture failed");
      }
      return new Response("not-json");
    };
    expect(await auditGroups()).toMatchObject({ ok: false, checkedGroups: 1 });
    expect(requests.map(({ wire }) => wire)).toEqual(expectedRequests("-1001"));
    expect(requests[0]?.dispatcher.destroyed).toBe(true);
  },
);

it("keeps the audit transport open until the final group's response body settles", async () => {
  const readingBody = Promise.withResolvers<void>();
  const finishBody = Promise.withResolvers<void>();
  respond = () =>
    requests.length === 1
      ? membership()
      : new Response(
          new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                readingBody.resolve();
                await finishBody.promise;
                controller.enqueue(Buffer.from('{"ok":true,"result":{"status":"administrator"}}'));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        );
  const audit = auditGroups(["-1001", "-1002"]);
  try {
    await readingBody.promise;
    expect(requests.map(({ wire }) => wire)).toEqual(expectedRequests("-1001", "-1002"));
    expect(requests[0]?.dispatcher).toBe(requests[1]?.dispatcher);
    expect(requests[1]?.dispatcher.destroyed).toBe(false);
  } finally {
    finishBody.resolve();
  }
  expect(await audit).toMatchObject({
    ok: true,
    checkedGroups: 2,
    groups: [
      { chatId: "-1001", status: "member" },
      { chatId: "-1002", status: "administrator" },
    ],
  });
  expect(requests[1]?.dispatcher.destroyed).toBe(true);
});
