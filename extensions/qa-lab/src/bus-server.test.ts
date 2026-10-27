import { Agent, createServer, request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { QaBusPollResult } from "openclaw/plugin-sdk/qa-channel-protocol";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { closeQaHttpServer, startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";

async function requestOnce(params: { port: number; agent: Agent }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: params.port,
        path: "/",
        agent: params.agent,
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function pollQaBus({
  baseUrl,
  ...body
}: {
  baseUrl: string;
  accountId: string;
  cursor: number;
  acknowledgedCursor?: number;
  timeoutMs: number;
}): Promise<QaBusPollResult> {
  const response = await postQaBusJson(baseUrl, "/v1/poll", body);
  if (!response.ok) {
    throw new Error(`qa-bus request failed: ${response.status}`);
  }
  return (await response.json()) as QaBusPollResult;
}

async function postQaBusJson(baseUrl: string, path: string, body: unknown) {
  return await postQaBusRawJson(baseUrl, path, JSON.stringify(body));
}

async function postQaBusRawJson(baseUrl: string, path: string, body: string) {
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

async function expectJson(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual(body);
}
async function expectSuccess(response: Response, body: object) {
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject(body);
}
const messageIds = (result: QaBusPollResult) =>
  result.events.flatMap((event) => ("message" in event ? [event.message.id] : []));

describe("closeQaHttpServer", () => {
  it("closes idle keep-alive sockets so suite processes can exit", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/plain",
        connection: "keep-alive",
      });
      res.end("ok");
    });
    const agent = new Agent({ keepAlive: true });
    const port = await listenOnLoopback(server);

    try {
      await requestOnce({ port, agent });
      const startedAt = Date.now();
      await closeQaHttpServer(server);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      agent.destroy();
      server.closeAllConnections?.();
    }
  });
});

describe("qa-bus server", () => {
  const stops: Array<() => Promise<void>> = [];
  async function fixture(state = createQaBusState()) {
    const bus = await startQaBusServer({ state });
    let stopping: Promise<void> | undefined;
    const stop = () => (stopping ??= bus.stop());
    stops.push(stop);
    return {
      ...bus,
      stop,
      state,
      post: (route: string, body: unknown) => postQaBusJson(bus.baseUrl, route, body),
      raw: (route: string, body: string) => postQaBusRawJson(bus.baseUrl, route, body),
      poll: (cursor = 0, acknowledgedCursor?: number) =>
        pollQaBus({
          baseUrl: bus.baseUrl,
          accountId: "acct-a",
          timeoutMs: 0,
          cursor,
          acknowledgedCursor,
        }),
      inbound: (text: string, id = "target") =>
        state.addInboundMessage({
          accountId: "acct-a",
          conversation: { id, kind: "direct" },
          senderId: "acct-a-user",
          text,
        }),
    };
  }

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  it("returns a 500 JSON response when request handling rejects", async () => {
    const state = createQaBusState();
    const requestError = new Error("snapshot unavailable");
    state.getSnapshot = () => {
      throw requestError;
    };
    const bus = await fixture(state);

    const response = await fetch(`${bus.baseUrl}/v1/state`, {
      signal: AbortSignal.timeout(1_000),
    });
    await expectJson(response, 500, { error: requestError.message });
  });

  it("normalizes direct-message aliases at HTTP ingress without accepting unknown kinds", async () => {
    const { state, post } = await fixture();

    for (const kind of ["direct", "dm"]) {
      const response = await post("/v1/inbound/message", {
        conversation: { id: "alice", kind },
        senderId: "alice",
        text: `hello from ${kind}`,
      });

      await expectSuccess(response, {
        message: { conversation: { id: "alice", kind: "direct" } },
      });
    }

    const rejected = await post("/v1/inbound/message", {
      conversation: { id: "alice", kind: "private" },
      senderId: "alice",
      text: "must not be accepted",
    });

    expect(rejected.status).toBe(400);
    expect(state.getSnapshot().messages).toHaveLength(2);
  });

  it("wakes matching polls and fences late polls and writes during shutdown", async () => {
    const bus = await fixture();
    const { state, inbound } = bus;

    const pending = pollQaBus({
      baseUrl: bus.baseUrl,
      accountId: "acct-a",
      cursor: 999,
      timeoutMs: 500,
    });

    inbound("fresh event");

    const result = await pending;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      accountId: "acct-a",
      cursor: 1,
      kind: "inbound-message",
    });

    const waitForCursorAdvance = state.waitForCursorAdvance.bind(state);
    let pollWaitersStarted = 0;
    let pollWaitersSettled = 0;
    state.waitForCursorAdvance = async (...args) => {
      pollWaitersStarted += 1;
      try {
        return await waitForCursorAdvance(...args);
      } finally {
        pollWaitersSettled += 1;
      }
    };
    const activePoll = postQaBusJson(bus.baseUrl, "/v1/poll", {
      accountId: "active",
      cursor: 1,
      timeoutMs: 30_000,
    }).catch(() => undefined);
    await vi.waitFor(() => expect(pollWaitersStarted).toBe(1));
    function pausedPost(route: string, input: unknown) {
      const body = JSON.stringify(input);
      const req = request({
        host: "127.0.0.1",
        port: bus.port,
        path: route,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      });
      req.on("response", (response) => response.resume());
      req.on("error", () => undefined);
      req.write(body.slice(0, 1));
      return () => {
        req.end(body.slice(1));
      };
    }
    const finishPoll = pausedPost("/v1/poll", {
      accountId: "late-body",
      cursor: 0,
      timeoutMs: 30_000,
    });
    const finishInbound = pausedPost("/v1/inbound/message", {
      conversation: { id: "late-room", kind: "direct" },
      senderId: "late-sender",
      text: "must not survive shutdown",
    });
    await sleep(10);

    const startedAt = Date.now();
    const stopping = bus.stop();
    setTimeout(() => {
      finishPoll();
      finishInbound();
    }, 50);
    await stopping;
    await activePoll;

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect([pollWaitersStarted, pollWaitersSettled]).toEqual([1, 1]);
    expect(state.getSnapshot()).toMatchObject({ events: [], messages: [] });
  });

  it("resumes an account after its last acknowledged cursor when the client restarts", async () => {
    const { state, poll, inbound } = await fixture();
    const consumed = inbound("consumed before restart", "first");
    const firstPoll = await poll();
    expect(firstPoll.events.map((event) => event.cursor)).toEqual([1]);

    await poll(firstPoll.cursor, 0);
    expect(state.getAcknowledgedPollCursor("acct-a")).toBe(0);
    const unacknowledgedRestart = await poll();
    expect(messageIds(unacknowledgedRestart)).toEqual([consumed.id]);

    await poll(firstPoll.cursor, firstPoll.cursor);
    expect(state.getAcknowledgedPollCursor("acct-a")).toBe(firstPoll.cursor);
    const queuedDuringRestart = inbound("queued during restart", "second");
    const restartedPoll = await poll();
    expect(messageIds(restartedPoll)).toEqual([queuedDuringRestart.id]);

    state.reset();
    const queuedAfterReset = inbound("queued after bus reset", "third");
    const resetPoll = await poll();
    expect(messageIds(resetPoll)).toEqual([queuedAfterReset.id]);
  });

  it("paginates a burst without advancing past events omitted by the poll limit", async () => {
    const { poll, inbound } = await fixture();

    for (let index = 1; index <= 101; index += 1) {
      inbound(`burst event ${index}`, "burst");
    }

    const firstPage = await poll();
    expect(firstPage.events).toHaveLength(100);
    expect(firstPage.cursor).toBe(100);

    const secondPage = await poll(firstPage.cursor);
    expect(secondPage.events).toHaveLength(1);
    expect(secondPage.events[0]?.cursor).toBe(101);
    expect(secondPage.cursor).toBe(101);
  });

  it.each([
    [
      "/v1/poll",
      { accountId: "acct-a", cursor: "999", timeoutMs: 500 },
      "poll cursor must be an integer at least 0.",
      300,
    ],
    [
      "/v1/poll",
      { accountId: "acct-a", cursor: 1, acknowledgedCursor: 2, timeoutMs: 0 },
      "acknowledged poll cursor must not exceed the requested poll cursor.",
      undefined,
    ],
    [
      "/v1/actions/search",
      { limit: "all", query: "anything" },
      "search limit must be an integer at least 1.",
      undefined,
    ],
  ] as const)("rejects %s input: %s", async (route, body, error, deadline) => {
    const { post } = await fixture();
    const startedAt = Date.now();
    const response = await post(route, body);
    if (deadline) {
      expect(Date.now() - startedAt).toBeLessThan(deadline);
    }
    await expectJson(response, 400, { error });
  });

  it.each(["inbound", "outbound"] as const)(
    "accepts a generated-media payload larger than 1 MiB on the %s message route",
    async (direction) => {
      const { state, post } = await fixture();

      const generatedImage = Buffer.alloc(1_600_000, 0x71);
      const attachment = {
        id: "qa-lighthouse-image",
        kind: "image",
        mimeType: "image/png",
        fileName: "qa-lighthouse.png",
        contentBase64: generatedImage.toString("base64"),
      };
      const response = await post(`/v1/${direction}/message`, {
        accountId: "acct-a",
        text: "QA lighthouse",
        attachments: [attachment],
        ...(direction === "inbound"
          ? {
              conversation: { id: "qa-operator", kind: "direct" },
              senderId: "qa-operator",
            }
          : { to: "dm:qa-operator" }),
      });

      await expectSuccess(response, {
        message: { direction, attachments: [attachment] },
      });

      const snapshot = state.getSnapshot();
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.events).toHaveLength(1);
      const storedAttachment = snapshot.messages[0]?.attachments?.[0];
      expect(storedAttachment).toEqual(attachment);
    },
  );

  it("returns a controlled error when a v1 POST body contains malformed JSON", async () => {
    const { raw } = await fixture();
    const response = await raw("/v1/reset", "{");

    await expectJson(response, 400, { error: "Malformed JSON body" });
  });

  it("keeps oversized numeric poll and search fields bounded", async () => {
    const { post, raw, inbound } = await fixture();
    const message = inbound("bounded numeric fields");

    const pollResponse = await post("/v1/poll", {
      accountId: "acct-a",
      cursor: 0,
      limit: 10_000,
      timeoutMs: 60_000,
    });
    await expectSuccess(pollResponse, {
      events: [{ message: { id: message.id } }],
    });

    const extremeSearchResponse = await raw(
      "/v1/actions/search",
      `{"accountId":"acct-a","limit":1e309,"query":"bounded"}`,
    );
    await expectSuccess(extremeSearchResponse, {
      messages: [{ id: message.id }],
    });
  });
  it.each([
    { pathname: "/v1/inbound/message", limit: 16 * 1024 * 1024 },
    { pathname: "/v1/outbound/message", limit: 16 * 1024 * 1024 },
    { pathname: "/v1/reset", limit: 1024 * 1024 },
  ])(
    "delivers 413 over the wire and closes when the $pathname body exceeds its limit",
    async ({ pathname, limit }) => {
      const bus = await fixture();
      // Declared over-cap length: rejected from the header alone, while the sender is
      // still mid-upload and can only learn the outcome from what reaches it.
      const result = await postRawWebhook({
        url: `${bus.baseUrl}${pathname}`,
        body: "{}",
        contentLength: limit + 1,
        headers: { "content-type": "application/json" },
      });

      expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(JSON.parse(result.body)).toEqual({ error: "Payload too large" });
      expect(result.closedByServer).toBe(true);
    },
  );
});
