import { WebClient, type WebClientOptions } from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { createSlackWriteClient, resolveSlackWriteClientOptions } from "./client.js";
import { appendSlackStream, startSlackStream, stopSlackStream } from "./streaming.js";

type StreamMethod = "chat.startStream" | "chat.appendStream" | "chat.stopStream";
type SlackFetch = NonNullable<WebClientOptions["fetch"]>;
const STREAM_TS = "1700000000.000100";
const success = () => Response.json({ ok: true, ts: STREAM_TS });
const rateLimited = (retryAfter = "0", body: BodyInit = "rate limited") =>
  new Response(body, { status: 429, headers: { "retry-after": retryAfter } });
const send = (client: WebClient, text = "answer") =>
  client.apiCall("chat.postMessage", { channel: "CFIXTURE", text });

function rejectedTransport(retryAfter = "0", onRequest = () => {}) {
  const responses: Response[] = [];
  const fetch: SlackFetch = async () => {
    onRequest();
    const response = rateLimited(retryAfter);
    responses.push(response);
    return response;
  };
  return { fetch, responses };
}

function createRateLimitTransport(
  method: StreamMethod | "chat.postMessage",
  terminal: "success" | "socket",
  brokenBody = false,
) {
  const requests: Array<{ method: string; body: string }> = [];
  let attempts = 0;
  const fetch: SlackFetch = async (input, init) => {
    const currentMethod = new URL(input).pathname.split("/").at(-1) ?? "";
    if (typeof init?.body !== "string") {
      throw new Error("Expected Slack's URL-encoded streaming request");
    }
    requests.push({ method: currentMethod, body: init.body });
    if (currentMethod === method && ++attempts === 1) {
      const body = brokenBody
        ? new ReadableStream({
            start(controller) {
              controller.error(new Error("rejected response body interrupted"));
            },
          })
        : JSON.stringify({ ok: false, error: "ratelimited" });
      return rateLimited("0", body);
    }
    if (currentMethod === method && terminal === "socket") {
      throw new Error("synthetic lost acknowledgment");
    }
    return success();
  };
  return { fetch, requests };
}

async function runStreamOperation(method: StreamMethod, fetch: SlackFetch) {
  const clientOptions: WebClientOptions = {
    fetch,
    slackApiUrl: "https://synthetic.slack.invalid/api/",
    retryConfig: { retries: 2, minTimeout: 1, maxTimeout: 1 },
    teamId: "TFIXTURE",
  };
  const client = new WebClient("synthetic-rate-limit-fixture", clientOptions);
  const session = await startSlackStream({
    client,
    clientOptions,
    channel: "CFIXTURE",
    threadTs: "1700000000.000001",
    teamId: "TRECIPIENT",
    userId: "UFIXTURE",
    text: method === "chat.startStream" ? "answer" : "prefix",
    chunks: [],
  });
  if (method !== "chat.startStream") {
    await appendSlackStream({
      session,
      text: "answer",
      ...(method === "chat.appendStream" ? { chunks: [] } : {}),
    });
  }
  await stopSlackStream({ session });
  return session;
}

describe("Slack explicit rate-limit recovery", () => {
  it.each(["retry", "abort"] as const)(
    "allows %s while a discarded 429 body and its cancellation remain pending",
    async (action) => {
      const cleanup = createDeferred<void>();
      let bodyController!: ReadableStreamDefaultController;
      let cancelled = false;
      let attempts = 0;
      const body = new ReadableStream({
        start(controller) {
          bodyController = controller;
        },
        cancel() {
          cancelled = true;
          return cleanup.promise;
        },
      });
      const fetch: SlackFetch = async () => {
        attempts += 1;
        return attempts === 1 ? rateLimited(action === "abort" ? "60" : "0", body) : success();
      };
      const operation =
        action === "retry"
          ? runStreamOperation("chat.startStream", fetch)
          : send(createSlackWriteClient("stalled-cancel", { fetch, timeout: 20 }));
      const settled = operation.then(
        () => "delivered",
        () => "aborted",
      );
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          settled,
          new Promise<string>((resolve) => {
            deadline = setTimeout(() => resolve("stalled"), 1_000);
          }),
        ]);
        expect({ outcome, cancelled, attempts }).toEqual({
          outcome: action === "retry" ? "delivered" : "aborted",
          cancelled: true,
          attempts: action === "retry" ? 3 : 1,
        });
      } finally {
        clearTimeout(deadline);
        bodyController.error(new Error("test cleanup"));
        cleanup.resolve();
        await settled;
      }
    },
  );
  it.each(["chat.startStream", "chat.appendStream", "chat.stopStream"] as const)(
    "retries rejected %s with identical bodies, including a broken start response",
    async (method) => {
      const brokenBody = method === "chat.startStream";
      const transport = createRateLimitTransport(method, "success", brokenBody);
      const session = await runStreamOperation(method, transport.fetch);
      const attempts = transport.requests.filter((request) => request.method === method);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.body).toBe(attempts[1]?.body);
      const body = new URLSearchParams(attempts[1]?.body);
      if (!brokenBody) {
        expect(body.get("team_id")).toBe("TFIXTURE");
        expect(JSON.parse(body.get("chunks") ?? "[]")).toEqual([
          { type: "markdown_text", text: "answer" },
        ]);
      }
      expect(session).toMatchObject({ stopped: true, delivered: true, pendingText: "" });
    },
  );

  it("does not replay an ambiguous socket response after an explicit rate-limit retry", async () => {
    const transport = createRateLimitTransport("chat.appendStream", "socket");
    await expect(runStreamOperation("chat.appendStream", transport.fetch)).rejects.toThrow();
    expect(
      transport.requests.filter((request) => request.method === "chat.appendStream"),
    ).toHaveLength(2);
    expect(transport.requests.some((request) => request.method === "chat.stopStream")).toBe(false);
  });

  it("revalidates direct-delivery authority before a refused write is retried", async () => {
    let authorized = true;
    const transport = rejectedTransport("0", () => {
      authorized = false;
    });
    const client = createSlackWriteClient(
      "synthetic-live-authority-fixture",
      { fetch: transport.fetch },
      () => {
        if (!authorized) {
          throw new Error("direct delivery is no longer active");
        }
      },
    );

    await expect(send(client)).rejects.toThrow("direct delivery is no longer active");
    expect(transport.responses).toHaveLength(1);
  });

  it("bounds rate-limit recovery for 2147001 to one request", async () => {
    const { fetch, responses } = rejectedTransport("2147001");
    const client = createSlackWriteClient("synthetic-budget-fixture", { fetch });
    await expect(send(client)).rejects.toThrow();
    expect(responses).toHaveLength(1);
    expect(responses.every((response) => response.bodyUsed)).toBe(true);
  });

  it("does not multiply the retry budget when pre-resolved options are reused", async () => {
    const { fetch, responses } = rejectedTransport();
    const options = resolveSlackWriteClientOptions({ fetch });
    const client = createSlackWriteClient("synthetic-reused-fixture", options);
    await expect(send(client)).rejects.toThrow();
    expect(responses).toHaveLength(3);
  });
});
