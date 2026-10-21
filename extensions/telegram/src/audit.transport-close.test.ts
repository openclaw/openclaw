import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { Agent } from "undici/index.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { auditTelegramGroupMembership } from "./audit.js";

const rawFetch = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock("undici/index.js", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici/index.js");
  return { ...actual, fetch: rawFetch };
});

const requests: Array<{ wire: string; dispatcher: Agent }> = [];
let respond: () => Response | Promise<Response>;

const expectedRequests = (...chatIds: string[]) =>
  chatIds.map(
    (chatId) =>
      `GET https://api.telegram.org/bot123:fixture-token/getChatMember?chat_id=${chatId}&user_id=123\n`,
  );
const auditGroups = (groupIds = ["-1001"]) =>
  auditTelegramGroupMembership({
    token: "123:fixture-token",
    botId: 123,
    groupIds,
    timeoutMs: 5_000,
    network: { autoSelectFamily: false },
  });

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
  // Also release the original implementation's leaked dispatcher in negative-control runs.
  await Promise.allSettled(requests.map(({ dispatcher }) => dispatcher.destroy()));
  vi.unstubAllEnvs();
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
    const result = await auditGroups();

    expect(result).toMatchObject({ ok: false, checkedGroups: 1 });
    expect(requests.map(({ wire }) => wire)).toEqual(expectedRequests("-1001"));
    expect(requests[0]?.dispatcher.destroyed).toBe(true);
  },
);

it("keeps the audit transport open until the final group's response body settles", async () => {
  const readingBody = Promise.withResolvers<void>();
  const finishBody = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        readingBody.resolve();
        await finishBody.promise;
        controller.enqueue(Buffer.from('{"ok":true,"result":{"status":"administrator"}}'));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  respond = () =>
    requests.length === 1
      ? Response.json({ ok: true, result: { status: "member" } })
      : new Response(body);
  const audit = auditGroups(["-1001", "-1002"]);
  try {
    await readingBody.promise;
    expect(requests.map(({ wire }) => wire)).toEqual(expectedRequests("-1001", "-1002"));
    expect(requests[0]?.dispatcher).toBe(requests[1]?.dispatcher);
    expect(requests[1]?.dispatcher.destroyed).toBe(false);
  } finally {
    finishBody.resolve();
  }
  const result = await audit;
  expect(result).toMatchObject({
    ok: true,
    checkedGroups: 2,
    groups: [
      { chatId: "-1001", status: "member" },
      { chatId: "-1002", status: "administrator" },
    ],
  });
  expect(requests[1]?.dispatcher.destroyed).toBe(true);
});
