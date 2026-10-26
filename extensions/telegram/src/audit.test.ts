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

it("cancels a stalled body within the shared timeout budget", async () => {
  const cancel = vi.fn();
  respond = () =>
    requests.length === 1
      ? new Promise<Response>((resolve) => {
          setTimeout(() => resolve(membership()), 40);
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
  const auditPromise = auditGroups(["-1001", "-1002"], 50);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60);
  expect(await auditPromise).toMatchObject({
    ok: false,
    groups: [
      { ok: true },
      { ok: false, error: "Telegram membership audit response body stalled for 5ms" },
    ],
  });
  expect(cancel).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
});

it("reports an audit error and closes transport after malformed JSON", async () => {
  respond = () => new Response("not-json");
  expect(await auditGroups()).toMatchObject({ ok: false, checkedGroups: 1 });
  expect(requests.map(({ wire }) => wire)).toEqual(expectedRequests("-1001"));
  expect(requests[0]?.dispatcher.destroyed).toBe(true);
});

it("reports a departed membership and keeps transport open until the final body settles", async () => {
  const body = new TransformStream<Uint8Array>();
  const writer = body.writable.getWriter();
  respond = () => (requests.length === 1 ? membership("left") : new Response(body.readable));
  const readingBody = writer.write(Buffer.from('{"ok":true,"result":{"status":"administrator"}}'));
  const audit = auditGroups(["-1001", "-1002"]);
  try {
    await readingBody;
    expect(requests.map(({ wire }) => wire)).toEqual(expectedRequests("-1001", "-1002"));
    expect(requests[0]?.dispatcher).toBe(requests[1]?.dispatcher);
    expect(requests[1]?.dispatcher.destroyed).toBe(false);
  } finally {
    await writer.close();
  }
  expect(await audit).toMatchObject({
    ok: false,
    checkedGroups: 2,
    groups: [
      { chatId: "-1001", status: "left", ok: false },
      { chatId: "-1002", status: "administrator" },
    ],
  });
  expect(requests[1]?.dispatcher.destroyed).toBe(true);
});
