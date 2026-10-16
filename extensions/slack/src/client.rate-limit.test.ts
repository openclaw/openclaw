// Real OpenClaw stream helpers and Slack SDK with synthetic HTTP responses.
import { WebClient, type WebClientOptions } from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  createSlackWriteClient,
  getSlackWriteClient,
  getSlackListenerWriteClient,
  resolveSlackWriteClientOptions,
} from "./client.js";
import { appendSlackStream, startSlackStream, stopSlackStream } from "./streaming.js";

type EffectAuthority = ReturnType<
  typeof import("openclaw/plugin-sdk/fetch-runtime").captureEffectAuthority
>;
const effectInput = vi.hoisted(() => ({ current: undefined as EffectAuthority | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => effectInput.current ?? actual.captureEffectAuthority(),
  };
});

type StreamMethod = "chat.startStream" | "chat.appendStream" | "chat.stopStream";
const STREAM_TS = "1700000000.000100";

function createRateLimitTransport(
  method: StreamMethod | "chat.postMessage",
  terminal: "success" | "socket",
  brokenBody = false,
) {
  const requests: Array<{ method: string; body: string }> = [];
  let attempts = 0;
  const fetch: NonNullable<WebClientOptions["fetch"]> = async (input, init) => {
    const currentMethod = new URL(input).pathname.split("/").at(-1) ?? "";
    if (typeof init?.body !== "string") {
      throw new Error("Expected Slack's URL-encoded streaming request");
    }
    requests.push({ method: currentMethod, body: init.body });
    if (currentMethod === method) {
      attempts += 1;
      if (attempts === 1) {
        const body = brokenBody
          ? new ReadableStream({
              start(controller) {
                controller.error(new Error("rejected response body interrupted"));
              },
            })
          : JSON.stringify({ ok: false, error: "ratelimited" });
        return new Response(body, {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      if (terminal === "socket") {
        throw new Error("synthetic lost acknowledgment");
      }
    }
    return Response.json({ ok: true, ts: STREAM_TS });
  };
  return { fetch, requests };
}

async function runStreamOperation(
  method: StreamMethod,
  fetch: NonNullable<WebClientOptions["fetch"]>,
) {
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
  if (method === "chat.appendStream") {
    await appendSlackStream({ session, text: "answer", chunks: [] });
  }
  if (method === "chat.stopStream") {
    await appendSlackStream({ session, text: "answer" });
  }
  await stopSlackStream({ session });
  return session;
}

const STREAM_METHODS = ["chat.appendStream", "chat.stopStream"] as const;

describe("Slack explicit rate-limit recovery", () => {
  it.each([
    { cache: "token", warm: true },
    { cache: "listener", warm: false },
    { cache: "listener", warm: true },
  ] as const)(
    "keeps $cache clients operation-local under effect authority (warm=$warm)",
    async ({ cache, warm }) => {
      const transport = createRateLimitTransport("chat.postMessage", "success");
      const token = `synthetic-${cache}-${warm}-scope`;
      const clientOptions = {
        fetch: transport.fetch,
        slackApiUrl: `https://synthetic.slack.invalid/${cache}-${warm}/api/`,
        teamId: "TFIXTURE",
      };
      for (const name of ["http_proxy", "https_proxy", "all_proxy"]) {
        vi.stubEnv(name, "");
      }
      vi.stubGlobal("fetch", transport.fetch);
      const listenerClient = new WebClient(token, clientOptions);
      const getClient = () => {
        const client =
          cache === "token"
            ? getSlackWriteClient(token, {
                slackApiUrl: clientOptions.slackApiUrl,
                teamId: "TFIXTURE",
              })
            : getSlackListenerWriteClient({ listenerClient, teamId: "TFIXTURE", clientOptions });
        if (!client) {
          throw new Error("missing fixture write client");
        }
        return client;
      };
      const send = (client: WebClient, text: string) =>
        client.apiCall("chat.postMessage", { channel: "CFIXTURE", text });
      let authorityOpen = true;
      const authority: EffectAuthority = {
        active: true,
        run: (run) => run(),
        async initiate(effect) {
          if (!authorityOpen) {
            throw new Error("fixture effect authority closed");
          }
          return effect();
        },
      };
      try {
        if (warm) {
          await send(getClient(), "warm");
        }
        effectInput.current = authority;
        const scoped = getClient();
        await send(scoped, "scoped");
        authorityOpen = false;
        effectInput.current = undefined;
        await expect(send(scoped, "late")).rejects.toThrow("fixture effect authority closed");
        if (cache === "listener") {
          expect(
            getSlackListenerWriteClient({
              listenerClient,
              teamId: "TOTHER",
              clientOptions,
            }),
          ).toBeUndefined();
        }
        await expect(send(getClient(), "ordinary")).resolves.toMatchObject({ ok: true });
        expect(
          transport.requests.map((request) => new URLSearchParams(request.body).get("text")),
        ).toEqual(warm ? ["warm", "warm", "scoped", "ordinary"] : ["scoped", "scoped", "ordinary"]);
      } finally {
        authorityOpen = false;
        effectInput.current = undefined;
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    },
  );
  it("recovers an authoritative rejection even if its discarded body fails", async () => {
    const transport = createRateLimitTransport("chat.startStream", "success", true);
    const session = await runStreamOperation("chat.startStream", transport.fetch);
    expect(session).toMatchObject({ stopped: true, delivered: true, pendingText: "" });
    const attempts = transport.requests.filter((request) => request.method === "chat.startStream");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.body).toBe(attempts[1]?.body);
  });

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
      const fetch: NonNullable<WebClientOptions["fetch"]> = async () => {
        attempts += 1;
        return attempts === 1
          ? new Response(body, {
              status: 429,
              headers: { "retry-after": action === "abort" ? "60" : "0" },
            })
          : new Response(JSON.stringify({ ok: true, ts: STREAM_TS }));
      };
      const operation =
        action === "retry"
          ? runStreamOperation("chat.startStream", fetch)
          : createSlackWriteClient("synthetic-stalled-cancel-fixture", {
              fetch,
              timeout: 20,
            }).apiCall("chat.postMessage", { channel: "CFIXTURE", text: "answer" });
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
        expect(outcome).toBe(action === "retry" ? "delivered" : "aborted");
        expect(cancelled).toBe(true);
        expect(attempts).toBe(action === "retry" ? 3 : 1);
      } finally {
        clearTimeout(deadline);
        bodyController.error(new Error("test cleanup"));
        cleanup.resolve();
        await settled;
      }
    },
  );
  it.each(STREAM_METHODS)(
    "retries a rejected %s without duplicating buffered text",
    async (method) => {
      const transport = createRateLimitTransport(method, "success");
      const session = await runStreamOperation(method, transport.fetch);
      const attempts = transport.requests.filter((request) => request.method === method);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.body).toBe(attempts[1]?.body);
      const body = new URLSearchParams(attempts[1]?.body);
      expect(body.get("team_id")).toBe("TFIXTURE");
      expect(JSON.parse(body.get("chunks") ?? "[]")).toEqual([
        { type: "markdown_text", text: "answer" },
      ]);
      expect(session).toMatchObject({ stopped: true, delivered: true, pendingText: "" });
    },
  );

  it.each(["socket"] as const)(
    "does not replay an ambiguous %s response after an explicit rate-limit retry",
    async (terminal) => {
      const transport = createRateLimitTransport("chat.appendStream", terminal);
      await expect(runStreamOperation("chat.appendStream", transport.fetch)).rejects.toThrow();
      expect(
        transport.requests.filter((request) => request.method === "chat.appendStream"),
      ).toHaveLength(2);
      expect(transport.requests.some((request) => request.method === "chat.stopStream")).toBe(
        false,
      );
    },
  );

  it("revalidates direct-delivery authority before a refused write is retried", async () => {
    let authorized = true;
    let attempts = 0;
    const client = createSlackWriteClient(
      "synthetic-live-authority-fixture",
      {
        fetch: async () => {
          attempts += 1;
          authorized = false;
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "0" },
          });
        },
      },
      () => {
        if (!authorized) {
          throw new Error("direct delivery is no longer active");
        }
      },
    );

    await expect(
      client.apiCall("chat.postMessage", { channel: "CFIXTURE", text: "answer" }),
    ).rejects.toThrow("direct delivery is no longer active");
    expect(attempts).toBe(1);
  });

  it.each([{ header: "2147001", calls: 1 }])(
    "bounds rate-limit recovery for $header ($calls requests)",
    async (testCase) => {
      const responses: Response[] = [];
      const client = createSlackWriteClient("synthetic-budget-fixture", {
        fetch: async () => {
          const response = new Response("rate limited", {
            status: 429,
            headers: { "retry-after": testCase.header },
          });
          responses.push(response);
          return response;
        },
      });
      await expect(
        client.apiCall("chat.postMessage", { channel: "CFIXTURE", text: "answer" }),
      ).rejects.toThrow();
      expect(responses).toHaveLength(testCase.calls);
      expect(responses.every((response) => response.bodyUsed)).toBe(true);
    },
  );

  it("does not multiply the retry budget when pre-resolved options are reused", async () => {
    let attempts = 0;
    const options = resolveSlackWriteClientOptions({
      fetch: async () => {
        attempts += 1;
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      },
    });
    const client = createSlackWriteClient("synthetic-reused-fixture", options);
    await expect(
      client.apiCall("chat.postMessage", { channel: "CFIXTURE", text: "answer" }),
    ).rejects.toThrow();
    expect(attempts).toBe(3);
  });
});
