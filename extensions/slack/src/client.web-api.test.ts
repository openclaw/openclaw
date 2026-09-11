// Slack tests cover real Web API routing behavior.
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogLevel, WebAPIRequestError, WebClient, type WebClientOptions } from "@slack/web-api";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindSlackWriteClientToAttempt,
  createSlackLookupClient,
  createSlackReadClient,
  createSlackStartupAuthClient,
  createSlackWebClient,
  getSlackListenerWriteClient,
} from "./client.js";
import { resolveSlackListenerEventScope } from "./monitor/event-scope.js";
import { startSlackStream } from "./streaming.js";

const SLACK_API_URL_KEYS = ["SLACK_API_URL"] as const;
const PROXY_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;
const TEST_ENV_KEYS = [...SLACK_API_URL_KEYS, ...PROXY_KEYS] as const;
const originalEnv = { ...process.env };

type SlackApiRequest = {
  authorization?: string;
  body?: string;
  method?: string;
  url?: string;
};

function restoreTestEnv() {
  for (const key of TEST_ENV_KEYS) {
    if (originalEnv[key] !== undefined) {
      process.env[key] = originalEnv[key];
    } else {
      delete process.env[key];
    }
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startSlackApiServer(
  requests: SlackApiRequest[],
  responseDelayMs = 0,
): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url,
    });
    request.resume();
    const sendResponse = () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        `${JSON.stringify({
          ok: true,
          team: "Mock Slack",
          team_id: "TMOCK",
          url: "https://mock.slack.test/",
          user: "mock-bot",
          user_id: "UMOCK",
        })}\n`,
      );
    };
    if (responseDelayMs > 0) {
      setTimeout(sendResponse, responseDelayMs);
    } else {
      sendResponse();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function startDroppedResponseSlackApiServer(requests: SlackApiRequest[]): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((request) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.once("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
        method: request.method,
        url: request.url,
      });
      request.socket.destroy();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function startStalledHeadersSlackApiServer(requests: SlackApiRequest[]): Promise<{
  baseUrl: string;
  close(): Promise<void>;
  socketClosed: Promise<void>;
}> {
  let resolveSocketClosed: () => void = () => {};
  const socketClosed = new Promise<void>((resolve) => {
    resolveSocketClosed = resolve;
  });
  const server = createServer((request) => {
    requests.push({
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url,
    });
    request.resume();
    request.socket.once("close", resolveSocketClosed);
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      const closed = closeServer(server);
      for (const socket of sockets) {
        socket.destroy();
      }
      await closed;
    },
    socketClosed,
  };
}

async function expectEnterpriseUpload(
  terminal: "allowed" | "revoked" | "ambiguous",
  testSignal: AbortSignal,
): Promise<void> {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
  const { sendMessageSlack } = await import("./send.js");
  const uploadReceived = createDeferred<void>();
  const releaseUpload = createDeferred<void>();
  const blockerReceived = createDeferred<void>();
  const releaseBlocker = createDeferred<void>();
  const completionEnqueued = createDeferred<void>();
  const controller = new AbortController();
  const blockerController = new AbortController();
  const signal = AbortSignal.any([controller.signal, testSignal]);
  const revoked = new Error("Enterprise upload authority revoked");
  const errors: unknown[] = [];
  const producers: Promise<unknown>[] = [];
  const observers: Promise<void>[] = [];
  const handlers: Promise<void>[] = [];
  const sockets = new Set<Socket>();
  const requests: {
    url?: string;
    method?: string;
    authorization?: string;
    testHeader?: string | string[];
    body: Buffer;
  }[] = [];
  const attachment = Buffer.from("Enterprise attachment bytes\n".repeat(64));
  const filename = "enterprise-proof.txt";
  let directory: string | undefined;
  let server: Server | undefined;
  let completionAttempts = 0;
  let baseUrl = "";
  try {
    directory = await mkdtemp(join(tmpdir(), "openclaw-slack-enterprise-upload-"));
    const root = await realpath(directory);
    const mediaPath = join(root, filename);
    await writeFile(mediaPath, attachment);
    server = createServer((request, response) => {
      const handled = (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        requests.push({
          url: request.url,
          method: request.method,
          authorization: request.headers.authorization,
          testHeader: request.headers["x-slack-test"],
          body: Buffer.concat(chunks),
        });
        response.setHeader("content-type", "application/json");
        switch (request.url) {
          case "/api/files.getUploadURLExternal":
            response.end(
              JSON.stringify({
                ok: true,
                upload_url: `${baseUrl}/upload`,
                file_id: "FENTERPRISE1",
              }),
            );
            break;
          case "/upload":
            uploadReceived.resolve();
            await releaseUpload.promise;
            response.end("ok");
            break;
          case "/api/auth.test":
            blockerReceived.resolve();
            await releaseBlocker.promise;
            response.end(JSON.stringify({ ok: true, team_id: "TENTERPRISE1" }));
            break;
          case "/api/files.completeUploadExternal":
            if (terminal === "ambiguous") {
              // The server has accepted the complete body before losing the reply.
              request.socket.destroy();
            } else {
              response.end(JSON.stringify({ ok: true, files: [{ id: "FENTERPRISE1" }] }));
            }
            break;
          default:
            throw new Error(`Unexpected Enterprise upload route: ${request.url}`);
        }
      })().catch((error: unknown) => {
        errors.push(error);
        response.destroy();
      });
      handlers.push(handled);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const clientOptions: WebClientOptions = {
      slackApiUrl: `${baseUrl}/api/`,
      maxRequestConcurrency: 1,
      retryConfig: { retries: 2, minTimeout: 1, maxTimeout: 1 },
      headers: { Authorization: "Bearer stale-fixture", "X-Slack-Test": "preserved" },
      logger: {
        debug: (message: unknown) => {
          if (message === `http request url: ${baseUrl}/api/files.completeUploadExternal`) {
            completionAttempts += 1;
            // SDK 8.1.1 calls the guarded transport in this synchronous stack.
            // This observer resumes after shared admission has queued the attempt.
            completionEnqueued.resolve();
          }
        },
        info: () => {},
        warn: () => {},
        error: () => {},
        setLevel: () => {},
        getLevel: () => LogLevel.DEBUG,
        setName: () => {},
      },
    };
    const listenerClient = new WebClient("listener-upload-fixture", clientOptions);
    const eventScope = resolveSlackListenerEventScope({
      identity: { kind: "enterprise", apiAppId: "A123", enterpriseId: "E123" },
      body: { api_app_id: "A123" },
      context: {
        isEnterpriseInstall: true,
        enterpriseId: "E123",
        teamId: "TENTERPRISE1",
      },
      client: listenerClient,
      clientOptions,
    });
    expect(eventScope?.client).toBe(listenerClient);
    expect(eventScope?.writeClient).toBeInstanceOf(WebClient);
    if (!eventScope?.writeClient) {
      throw new Error("Enterprise event has no completion writer");
    }
    const onPlatformSendDispatch = vi.fn(async () => {});
    const onDeliveryResult = vi.fn();
    const send = sendMessageSlack("channel:C123CHAN", "Enterprise attachment", {
      cfg: { channels: { slack: {} } },
      eventScope,
      mediaUrl: mediaPath,
      mediaLocalRoots: [root],
      forceDocument: true,
      uploadFileName: filename,
      signal,
      assertDirectAdapterHandoff: () => signal.throwIfAborted(),
      onPlatformSendDispatch,
      onDeliveryResult,
    }).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    producers.push(send);
    const waitForBoundary = (boundary: Promise<void>, blocker?: Promise<unknown>) => {
      const observation = Promise.race([
        boundary,
        send.then((outcome) => {
          throw outcome.ok
            ? new Error("Enterprise upload completed before the expected boundary")
            : outcome.error;
        }),
        ...(blocker
          ? [
              blocker.then(() => {
                throw new Error("Transport blocker finished before its request was held");
              }),
            ]
          : []),
      ]);
      observers.push(observation);
      return observation;
    };
    await waitForBoundary(uploadReceived.promise);
    expect(requests.at(-1)?.body).toEqual(attachment);
    if (terminal === "revoked") {
      // A separate SDK client proves this is shared transport admission, not
      // the completion client's own SDK queue or the per-target send queue.
      const blockerClient = bindSlackWriteClientToAttempt(eventScope.writeClient, {
        signal: AbortSignal.any([blockerController.signal, testSignal]),
      }).client;
      const blocker = blockerClient.auth.test();
      producers.push(blocker);
      await waitForBoundary(blockerReceived.promise, blocker);
      releaseUpload.resolve();
      await waitForBoundary(completionEnqueued.promise, blocker);
      expect(requests.filter((request) => request.url?.endsWith("completeUploadExternal"))).toEqual(
        [],
      );
      controller.abort(revoked);
      releaseBlocker.resolve();
      await blocker;
    } else {
      releaseUpload.resolve();
    }
    const outcome = await send;
    const expectedRoutes = [
      "/api/files.getUploadURLExternal",
      "/upload",
      terminal === "revoked" ? "/api/auth.test" : "/api/files.completeUploadExternal",
    ];
    expect(requests.map((request) => request.url)).toEqual(expectedRoutes);
    expect(completionAttempts).toBe(1);
    const allocation = requests[0];
    expect(allocation).toMatchObject({
      method: "POST",
      authorization: "Bearer listener-upload-fixture",
      testHeader: "preserved",
    });
    expect(Object.fromEntries(new URLSearchParams(allocation?.body.toString("utf8")))).toEqual({
      team_id: "TENTERPRISE1",
      filename,
      length: String(attachment.length),
    });
    expect(requests[1]).toMatchObject({
      method: "POST",
      authorization: undefined,
      body: attachment,
    });
    const last = requests[2];
    expect(last).toMatchObject({
      method: "POST",
      authorization: "Bearer listener-upload-fixture",
      testHeader: "preserved",
    });
    const completion = new URLSearchParams(last?.body.toString("utf8"));
    if (terminal !== "revoked") {
      expect(Object.fromEntries(completion)).toEqual({
        team_id: "TENTERPRISE1",
        files: JSON.stringify([{ id: "FENTERPRISE1", title: filename }]),
        channel_id: "C123CHAN",
        initial_comment: "Enterprise attachment",
      });
    } else {
      expect(Object.fromEntries(completion)).toEqual({ team_id: "TENTERPRISE1" });
    }
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    if (terminal === "allowed") {
      if (!outcome.ok) {
        throw outcome.error;
      }
      expect(outcome.result).toMatchObject({
        messageId: "FENTERPRISE1",
        channelId: "C123CHAN",
        receipt: { platformMessageIds: ["FENTERPRISE1"] },
      });
      expect(onDeliveryResult).toHaveBeenCalledOnce();
    } else {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        throw new Error("Revoked or ambiguous Enterprise upload reported success");
      }
      expect(outcome.error).toBeInstanceOf(WebAPIRequestError);
      expect(outcome.error).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
      if (terminal === "revoked" && outcome.error instanceof WebAPIRequestError) {
        expect(outcome.error.original).toBe(revoked);
      }
      expect(onDeliveryResult).not.toHaveBeenCalled();
    }
  } catch (error) {
    errors.push(error);
  } finally {
    controller.abort();
    blockerController.abort();
    releaseUpload.resolve();
    releaseBlocker.resolve();
    const settledProducers = await Promise.allSettled([...producers, ...observers]);
    for (const result of settledProducers) {
      if (result.status === "rejected") {
        errors.push(result.reason);
      }
    }
    if (server) {
      const closed = closeServer(server);
      for (const socket of sockets) {
        socket.destroy();
      }
      const settledServer = await Promise.allSettled([closed, ...handlers]);
      for (const result of settledServer) {
        if (result.status === "rejected") {
          errors.push(result.reason);
        }
      }
    }
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Enterprise upload ${terminal} proof failed`);
  }
}

afterEach(() => {
  restoreTestEnv();
});

describe("Slack Web API routing", () => {
  it("uploads exact attachment bytes and completes once in the listener's Enterprise team", async ({
    signal,
  }) => {
    await expectEnterpriseUpload("allowed", signal);
  });

  it("revokes Enterprise completion queued behind shared admission after accepted upload bytes", async ({
    signal,
  }) => {
    await expectEnterpriseUpload("revoked", signal);
  });

  it("does not retry a fully accepted Enterprise completion with a lost response", async ({
    signal,
  }) => {
    await expectEnterpriseUpload("ambiguous", signal);
  });

  it.each([undefined, "TENTERPRISE1"])(
    "keeps lost stream responses one-shot without changing listener reads (team=%s)",
    async (teamId) => {
      for (const key of TEST_ENV_KEYS) {
        delete process.env[key];
      }
      const requests: SlackApiRequest[] = [];
      const server = await startDroppedResponseSlackApiServer(requests);
      try {
        const clientOptions = {
          slackApiUrl: `${server.baseUrl}/api/`,
          teamId,
          retryConfig: { retries: 2, minTimeout: 1, maxTimeout: 1 },
        };
        const listenerClient = new WebClient("listener-stream-fixture", clientOptions);

        await expect(
          startSlackStream({
            client: listenerClient,
            clientOptions,
            channel: "C123",
            threadTs: "1700000000.000100",
            teamId: "TRECIPIENT",
            text: "one committed answer",
            chunks: [],
          }),
        ).rejects.toThrow();

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          authorization: "Bearer listener-stream-fixture",
          url: "/api/chat.startStream",
        });
        const payload = new URLSearchParams(requests[0]?.body);
        expect(payload.get("team_id")).toBe(teamId ?? null);
        expect(payload.get("recipient_team_id")).toBe("TRECIPIENT");

        await expect(listenerClient.auth.test()).rejects.toThrow();
        expect(requests.filter((request) => request.url === "/api/auth.test")).toHaveLength(3);
      } finally {
        await server.close();
      }
    },
  );

  it("omits the empty body emitted by auth.test", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, team_id: "TMOCK", user_id: "UMOCK" }), {
        status: 200,
      }),
    );
    try {
      const client = createSlackWebClient("xoxb-empty-body-proof", {
        retryConfig: { retries: 0 },
        timeout: 1000,
      });

      await expect(client.auth.test()).resolves.toMatchObject({ ok: true });
      expect(globalFetch).toHaveBeenCalledOnce();
      const init = globalFetch.mock.calls[0]?.[1];
      expect(init).toMatchObject({ method: "POST" });
      expect(init).not.toHaveProperty("body");
    } finally {
      globalFetch.mockRestore();
    }
  });

  it("retries two transient startup auth failures", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("request timed out"))
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, team_id: "TMOCK", user_id: "UMOCK" }), {
          status: 200,
        }),
      );
    const client = createSlackStartupAuthClient("startup-fixture", {
      fetch: fetchMock as never,
    });

    await expect(client.auth.test()).resolves.toMatchObject({
      ok: true,
      team_id: "TMOCK",
      user_id: "UMOCK",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a permanent startup auth error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        status: 200,
      }),
    );
    const client = createSlackStartupAuthClient("invalid-fixture", {
      fetch: fetchMock as never,
    });

    await expect(client.auth.test()).rejects.toThrow("invalid_auth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries startup auth after a rate limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, team_id: "TMOCK", user_id: "UMOCK" }), {
          status: 200,
        }),
      );
    const client = createSlackStartupAuthClient("rate-limited-fixture", {
      fetch: fetchMock as never,
    });

    await expect(client.auth.test()).resolves.toMatchObject({
      ok: true,
      team_id: "TMOCK",
      user_id: "UMOCK",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled-header lookup after one request", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const requests: SlackApiRequest[] = [];
    const server = await startStalledHeadersSlackApiServer(requests);
    try {
      const client = createSlackLookupClient("lookup-fixture", {
        slackApiUrl: `${server.baseUrl}/api/`,
        timeout: 50,
      });

      await expect(client.auth.test()).rejects.toThrow();
      await server.socketClosed;

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "POST", url: "/api/auth.test" });
    } finally {
      await server.close();
    }
  });

  it("rejects rate limits without sleeping through Retry-After", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "retry-after": "2" },
      }),
    );
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const client = createSlackLookupClient("lookup-fixture", {
        fetch: fetchMock as never,
      });

      await expect(client.auth.test()).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(timeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 2000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("keeps dropped Enterprise upload completion responses to one team-scoped request", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const requests: SlackApiRequest[] = [];
    const server = await startDroppedResponseSlackApiServer(requests);
    try {
      const clientOptions = {
        headers: {
          Authorization: "Bearer stale-fixture",
          "X-Slack-Test": "preserved",
        },
        slackApiUrl: `${server.baseUrl}/api/`,
        retryConfig: { retries: 2 },
      };
      const listenerClient = new WebClient("listener-fixture", clientOptions);
      const completionClient = getSlackListenerWriteClient({
        listenerClient,
        teamId: "TENTERPRISE1",
        clientOptions,
      });
      expect(completionClient).toBeDefined();
      if (!completionClient) {
        throw new Error("missing Enterprise upload completion client");
      }
      expect(
        getSlackListenerWriteClient({
          listenerClient,
          teamId: "TENTERPRISE1",
          clientOptions,
        }),
      ).toBe(completionClient);
      expect(
        getSlackListenerWriteClient({
          listenerClient,
          teamId: "TENTERPRISE2",
          clientOptions,
        }),
      ).toBeUndefined();

      await expect(
        completionClient.files.completeUploadExternal({
          files: [{ id: "F123", title: "proof.txt" }],
          channel_id: "C123",
        }),
      ).rejects.toThrow();

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        authorization: "Bearer listener-fixture",
        method: "POST",
        url: "/api/files.completeUploadExternal",
      });
      expect(new URLSearchParams(requests[0]?.body).get("team_id")).toBe("TENTERPRISE1");
      expect(requests[0]?.authorization).not.toContain("stale-fixture");
    } finally {
      await server.close();
    }
  });

  it("does not inherit the listener request timeout for upload completion", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const requests: SlackApiRequest[] = [];
    const server = await startSlackApiServer(requests, 80);
    try {
      const clientOptions = {
        slackApiUrl: `${server.baseUrl}/api/`,
        retryConfig: { retries: 2 },
        timeout: 20,
      };
      const listenerClient = new WebClient("listener-fixture", clientOptions);
      const completionClient = getSlackListenerWriteClient({
        listenerClient,
        teamId: "TENTERPRISE1",
        clientOptions,
      });
      expect(completionClient).toBeDefined();
      if (!completionClient) {
        throw new Error("missing Enterprise upload completion client");
      }

      const result = await completionClient.files.completeUploadExternal({
        files: [{ id: "F123", title: "proof.txt" }],
        channel_id: "C123",
      });

      expect(result.ok).toBe(true);
      expect(requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("bounds dedicated reads without timing out shared clients", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const requests: SlackApiRequest[] = [];
    const server = await startSlackApiServer(requests, 80);
    try {
      const options = {
        retryConfig: { retries: 0 },
        slackApiUrl: `${server.baseUrl}/api/`,
      };
      const readClient = createSlackReadClient("xoxb-read", { ...options, timeout: 20 });
      const sharedClient = createSlackWebClient("xoxb-shared", options);

      await expect(readClient.auth.test()).rejects.toThrow();
      await expect(sharedClient.auth.test()).resolves.toMatchObject({ ok: true });

      // The read client aborts at 20ms, so whether its request reaches the
      // server before the abort is a race on a loaded runner. The bound itself
      // is asserted above; here only the shared client's arrival is certain,
      // and its token proves the dedicated client did not carry the call.
      expect(requests.length).toBeGreaterThanOrEqual(1);
      expect(requests.at(-1)?.authorization).toBe("Bearer xoxb-shared");
    } finally {
      await server.close();
    }
  });

  it("routes real WebClient requests to the SLACK_API_URL root", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const requests: SlackApiRequest[] = [];
    const server = await startSlackApiServer(requests);
    try {
      process.env.SLACK_API_URL = `${server.baseUrl}/api/`;

      const client = createSlackWebClient("xoxb-route-proof", {
        retryConfig: { retries: 0 },
        timeout: 1000,
      });
      const result = await client.auth.test();

      expect(result.ok).toBe(true);
      expect(requests).toEqual([
        {
          authorization: "Bearer xoxb-route-proof",
          method: "POST",
          url: "/api/auth.test",
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("routes real WebClient requests to explicit Slack API URL options before SLACK_API_URL", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const envRequests: SlackApiRequest[] = [];
    const explicitRequests: SlackApiRequest[] = [];
    const envServer = await startSlackApiServer(envRequests);
    const explicitServer = await startSlackApiServer(explicitRequests);
    try {
      process.env.SLACK_API_URL = `${envServer.baseUrl}/api/`;

      const client = createSlackWebClient("xoxb-route-proof", {
        retryConfig: { retries: 0 },
        slackApiUrl: `${explicitServer.baseUrl}/api/`,
        timeout: 1000,
      });
      const result = await client.auth.test();

      expect(result.ok).toBe(true);
      expect(envRequests).toEqual([]);
      expect(explicitRequests).toEqual([
        {
          authorization: "Bearer xoxb-route-proof",
          method: "POST",
          url: "/api/auth.test",
        },
      ]);
    } finally {
      await explicitServer.close();
      await envServer.close();
    }
  });
});
