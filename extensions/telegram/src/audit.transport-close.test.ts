import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { Agent } from "undici/index.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { auditTelegramGroupMembership } from "./audit.js";

const rawFetch = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock("undici/index.js", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici/index.js");
  return { ...actual, fetch: rawFetch };
});

const requests: Array<{ bytes: Buffer; dispatcher: Agent }> = [];
let respond: () => Response | Promise<Response>;

beforeEach(() => {
  requests.length = 0;
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "OPENCLAW_PROXY_URL",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_DEBUG_PROXY_ENABLED",
  ]) {
    vi.stubEnv(key, undefined);
  }
  rawFetch.mockReset().mockImplementation(async (input, init) => {
    const dispatcher = (init as RequestInit & { dispatcher?: unknown })?.dispatcher;
    if (!(dispatcher instanceof Agent)) {
      throw new Error("Membership audit did not provide its owned Agent");
    }
    const request = new Request(input, init);
    requests.push({
      bytes: Buffer.from(`${request.method} ${request.url}\n${await request.text()}`),
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

it.each(["success", "network failure", "malformed JSON"] as const)(
  "closes its owned audit transport after %s without changing the request",
  async (outcome) => {
    respond = () => {
      if (outcome === "network failure") {
        throw new Error("membership fixture failed");
      }
      return outcome === "malformed JSON"
        ? new Response("not-json")
        : Response.json({ ok: true, result: { status: "member" } });
    };
    const result = await auditTelegramGroupMembership({
      token: "123:fixture-token",
      botId: 123,
      groupIds: ["-1001"],
      timeoutMs: 5_000,
      network: { autoSelectFamily: false },
    });

    expect(result.ok).toBe(outcome === "success");
    expect(result.checkedGroups).toBe(1);
    expect(requests.map(({ bytes }) => bytes)).toEqual([
      Buffer.from(
        "GET https://api.telegram.org/bot123:fixture-token/getChatMember?chat_id=-1001&user_id=123\n",
      ),
    ]);
    expect(requests[0]?.dispatcher.destroyed).toBe(true);
  },
);

it("keeps the audit transport open until the final group's response body settles", async () => {
  const readingBody = Promise.withResolvers<void>();
  const finishBody = Promise.withResolvers<void>();
  respond = () =>
    requests.length === 1
      ? Response.json({ ok: true, result: { status: "member" } })
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
  const audit = auditTelegramGroupMembership({
    token: "123:fixture-token",
    botId: 123,
    groupIds: ["-1001", "-1002"],
    timeoutMs: 5_000,
    network: { autoSelectFamily: false },
  });
  try {
    await readingBody.promise;
    expect(requests.map(({ bytes }) => bytes)).toEqual([
      Buffer.from(
        "GET https://api.telegram.org/bot123:fixture-token/getChatMember?chat_id=-1001&user_id=123\n",
      ),
      Buffer.from(
        "GET https://api.telegram.org/bot123:fixture-token/getChatMember?chat_id=-1002&user_id=123\n",
      ),
    ]);
    expect(requests[0]?.dispatcher).toBe(requests[1]?.dispatcher);
    expect(requests[1]?.dispatcher.destroyed).toBe(false);
  } finally {
    finishBody.resolve();
  }
  const result = await audit;
  expect(result.groups.map(({ status }) => status)).toEqual(["member", "administrator"]);
  expect(result.ok).toBe(true);
  expect(requests[1]?.dispatcher.destroyed).toBe(true);
});
