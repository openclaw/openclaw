import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { buffer, text } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { listenOnLoopback } from "../../../../../test-support/hanging-loopback-server.js";
import { buildRoomKeyBackupUnavailableFaultRule } from "../scenarios/scenario-runtime-e2ee-room.js";
import { startMatrixQaFaultProxy } from "./fault-proxy.js";
import { normalizeMatrixQaRoute } from "./recording-proxy-internals.js";
import { startMatrixQaRecordingProxy } from "./recording-proxy.js";

const syncPath = "/_matrix/client/v3/sync";
const clientPath = "/_matrix/client/v3/";
const backupPath = "/_matrix/client/v3/room_keys/version";
const forwardedBody = { forwarded: true };
type ForwardedRequest = { authorization?: string; body: Buffer; method: string; url: string };
const servers: Array<{ close(): Promise<void> }> = [];

async function startTargetServer(params?: {
  responseBody?: Buffer | string;
  responseHeaders?: Record<string, string>;
  responseStatus?: number;
}) {
  const requests: ForwardedRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      requests.push({
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        body: await buffer(req),
        method: req.method ?? "GET",
        url: req.url ?? "/",
      });
      res.writeHead(params?.responseStatus ?? 200, {
        "content-type": "application/json",
        ...params?.responseHeaders,
      });
      res.end(params?.responseBody ?? JSON.stringify(forwardedBody));
    })().catch((error: unknown) =>
      res.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });
  const port = await listenOnLoopback(server);
  const handle = {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    requests,
  };
  servers.push(handle);
  return handle;
}

function forwardedRequest(
  url: string,
  overrides: Partial<Omit<ForwardedRequest, "body">> & { body?: string | Buffer } = {},
) {
  const { body = "", ...rest } = overrides;
  return { body: typeof body === "string" ? Buffer.from(body) : body, method: "GET", url, ...rest };
}
function faultHit(method: string, ruleId: string, path = syncPath) {
  return { method, path, ruleId };
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});
async function expectReply(response: Response, status: number, body: unknown) {
  expect([response.status, await response.json()]).toEqual([status, body]);
}
async function expectError(response: Response, status: number, errcode: string, error?: string) {
  await expectReply(
    response,
    status,
    expect.objectContaining({ errcode, ...(error && { error }) }),
  );
}

describe("Matrix QA fault proxy", () => {
  async function startProxy(
    options: Partial<Parameters<typeof startMatrixQaFaultProxy>[0]> = {},
    targetOptions?: Parameters<typeof startTargetServer>[0],
  ) {
    const target = await startTargetServer(targetOptions);
    const proxy = await startMatrixQaFaultProxy({
      targetBaseUrl: target.baseUrl,
      rules: [],
      ...options,
    });
    servers.push({ close: () => proxy.stop() });
    return { proxy, target };
  }

  it("prevents backup discovery and creation only for the faulted account", async () => {
    const { proxy, target } = await startProxy({
      rules: [buildRoomKeyBackupUnavailableFaultRule("driver-token")],
    });
    const backup = (token: string, method = "GET") =>
      fetch(`${proxy.baseUrl}${backupPath}`, {
        headers: { authorization: `Bearer ${token}` },
        method,
      });

    await expectReply(await backup("driver-token"), 404, {
      errcode: "M_NOT_FOUND",
      error: "No current key backup",
    });

    await expectError(await backup("driver-token", "POST"), 503, "M_UNKNOWN");
    await expectReply(await backup("other-token", "POST"), 200, forwardedBody);

    const forwarded = await fetch(`${proxy.baseUrl}/_matrix/client/v3/sync?timeout=0`, {
      body: JSON.stringify({ ok: true }),
      headers: { authorization: "Bearer driver-token", "content-type": "application/json" },
      method: "POST",
    });
    await expectReply(forwarded, 200, forwardedBody);

    expect(proxy.hits()).toEqual([
      faultHit("GET", "room-key-backup-version-unavailable", backupPath),
      faultHit("POST", "room-key-backup-version-unavailable", backupPath),
    ]);
    expect(target.requests).toEqual([
      forwardedRequest(backupPath, { authorization: "Bearer other-token", method: "POST" }),
      forwardedRequest("/_matrix/client/v3/sync?timeout=0", {
        authorization: "Bearer driver-token",
        body: '{"ok":true}',
        method: "POST",
      }),
    ]);
  });

  it("finishes the forwarded response when its exchange observer rejects", async () => {
    let observations = 0;
    const { proxy, target } = await startProxy({
      onExchange: async () => {
        observations += 1;
        throw new Error("capture observer failed");
      },
    });

    const response = await fetch(`${proxy.baseUrl}${syncPath}`, {
      signal: AbortSignal.timeout(5_000),
    });

    await expectError(response, 502, "MATRIX_QA_FAULT_PROXY_ERROR", "capture observer failed");
    expect(observations).toBe(1);
    expect(target.requests).toHaveLength(1);
  });

  it("forwards opaque binary upload bytes without decoding them", async () => {
    let observed: Buffer | undefined;
    const { proxy, target } = await startProxy({
      onExchange: ({ request }) => {
        observed = request.body;
      },
    });
    const body = new Uint8Array([0, 255, 128, 195, 40]);
    await expectReply(
      await fetch(`${proxy.baseUrl}${syncPath}`, { method: "POST", body }),
      200,
      forwardedBody,
    );
    expect(observed).toEqual(Buffer.from(body));
    expect(target.requests).toEqual([
      forwardedRequest(syncPath, { method: "POST", body: Buffer.from(body) }),
    ]);
  });

  it("returns 413 for a chunked overflow before the upload ends", async () => {
    const { proxy, target } = await startProxy({ maxRequestBytes: 4 });
    const reply = Promise.withResolvers<{
      body: string;
      connection?: string;
      status?: number;
    }>();
    const upload = httpRequest(
      `${proxy.baseUrl}${syncPath}`,
      { method: "POST", headers: { "transfer-encoding": "chunked" } },
      (res) => {
        void text(res).then(
          (body) =>
            reply.resolve({ body, connection: res.headers.connection, status: res.statusCode }),
          reply.reject,
        );
      },
    );
    const closed = new Promise<void>((resolve) => {
      upload.once("close", resolve);
    });
    upload.once("error", reply.reject);
    try {
      upload.write("12345");
      const response = await reply.promise;
      expect([response.status, response.connection]).toEqual([413, "close"]);
      expect(JSON.parse(response.body)).toMatchObject({
        errcode: "MATRIX_QA_FAULT_PROXY_REQUEST_TOO_LARGE",
      });
      expect(target.requests).toEqual([]);
    } finally {
      upload.destroy();
      await closed;
    }
  });

  it("does not forward a truncated upload and still serves the next request", async () => {
    const { proxy, target } = await startProxy();
    const upload = httpRequest(`${proxy.baseUrl}${syncPath}`, {
      method: "POST",
      headers: { "content-length": "10", expect: "100-continue" },
    });
    const closed = new Promise<void>((resolve) => {
      upload.once("close", resolve);
    });
    // The client deliberately tears down the partial upload.
    upload.on("error", () => undefined);
    const continuing = once(upload, "continue");
    upload.flushHeaders();
    try {
      await continuing;
      await new Promise<void>((resolve, reject) => {
        upload.write("ab", (error) => (error ? reject(error) : resolve()));
      });
      await setImmediate();
      upload.destroy();
      await closed;
      await expectReply(await fetch(`${proxy.baseUrl}${syncPath}`), 200, forwardedBody);
      expect(target.requests).toEqual([forwardedRequest(syncPath)]);
    } finally {
      upload.destroy();
      await closed;
    }
  });

  it("rejects request targets that resolve outside the configured origin", async () => {
    const { proxy, target } = await startProxy();
    const requestTarget = async (path: string) =>
      await new Promise<{ body: string; status: number | undefined }>((resolve, reject) => {
        const req = httpRequest(proxy.baseUrl, { path }, (res) => {
          void text(res).then((body) => resolve({ body, status: res.statusCode }), reject);
        });
        req.once("error", reject);
        req.end();
      });

    for (const path of ["http://127.0.0.1:9/latest/meta-data", "/\\127.0.0.1:9/latest"]) {
      const response = await requestTarget(path);
      expect(response.status).toBe(400);
      expect(response.body).toContain("MATRIX_QA_FAULT_PROXY_INVALID_TARGET");
    }
    expect(target.requests).toEqual([]);
  });

  it("mutates matching forwarded Matrix responses", async () => {
    const body = gzipSync(Buffer.from(JSON.stringify(forwardedBody)));
    const { proxy, target } = await startProxy(
      {
        rules: [
          {
            id: "sync-state-after",
            match: (proxyRequest) =>
              proxyRequest.method === "GET" &&
              proxyRequest.path === syncPath &&
              proxyRequest.search.includes("org.matrix.msc4222.use_state_after=true"),
            mutateResponse: ({ response }) => ({
              ...response,
              body: Buffer.from(JSON.stringify({ forwarded: true, mutated: true })),
            }),
          },
        ],
      },
      {
        responseBody: body,
        responseHeaders: { "content-encoding": "gzip", "content-length": String(body.byteLength) },
      },
    );

    const mutated = await fetch(
      `${proxy.baseUrl}${syncPath}?timeout=0&org.matrix.msc4222.use_state_after=true`,
      { headers: { authorization: "Bearer driver-token" } },
    );

    const headers = mutated.headers;
    expect([headers.get("content-encoding"), headers.get("content-length")]).toEqual([null, null]);
    await expectReply(mutated, 200, { forwarded: true, mutated: true });
    expect(proxy.hits()).toEqual([faultHit("GET", "sync-state-after")]);
    expect(target.requests).toEqual([
      forwardedRequest(`${syncPath}?timeout=0&org.matrix.msc4222.use_state_after=true`, {
        authorization: "Bearer driver-token",
      }),
    ]);
  });

  it.each(["request", "response"] as const)(
    "rejects oversized forwarded %s bodies",
    async (side) => {
      const requestSide = side === "request";
      const { proxy, target } = await startProxy(
        requestSide ? { maxRequestBytes: 4 } : { maxResponseBytes: 8 },
        { responseBody: JSON.stringify({ payload: "large" }) },
      );
      const path = requestSide ? "/_matrix/client/v3/send" : syncPath;
      const rejected = await fetch(
        `${proxy.baseUrl}${path}`,
        requestSide ? { body: "12345", method: "POST" } : undefined,
      );
      if (requestSide) {
        expect(rejected.headers.get("connection")).toBe("close");
      }
      await expectError(
        rejected,
        requestSide ? 413 : 502,
        `MATRIX_QA_FAULT_PROXY_${side.toUpperCase()}_TOO_LARGE`,
      );
      expect(target.requests).toEqual(requestSide ? [] : [forwardedRequest(path)]);
    },
  );
});

describe("Matrix QA recording proxy", () => {
  async function startRecording(targetBaseUrl?: string) {
    const recording = await startMatrixQaRecordingProxy({
      targetBaseUrl:
        targetBaseUrl ??
        (
          await startTargetServer({
            responseStatus: 401,
            responseBody: JSON.stringify({ errcode: "M_UNKNOWN_TOKEN", error: "secret-response" }),
          })
        ).baseUrl,
    });
    servers.push({ close: () => recording.stop() });
    return recording;
  }

  it("records completed uploads without retaining request or response data", async () => {
    const target = await startTargetServer({
      responseBody: JSON.stringify({
        content_uri: "mxc://matrix.test/secret-media",
        body: "secret-message",
        next_batch: "secret-sync",
      }),
    });
    const proxy = await startRecording(target.baseUrl);
    await fetch(`${proxy.baseUrl}${syncPath}?access_token=secret-query`, {
      headers: { authorization: "Bearer secret-header" },
    });
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(
        `${proxy.baseUrl}/_matrix/media/v3/upload?filename=secret-name`,
        {
          method: "POST",
          headers: { authorization: "Bearer secret-header" },
          body: "secret-file-contents",
        },
      );
      expect(response.status).toBe(200);
    }
    expect(
      target.requests.filter(({ url }) => url.startsWith("/_matrix/media/v3/upload")),
    ).toHaveLength(2);
    expect(proxy.records()).toEqual([
      { request: { method: "GET", route: syncPath }, response: { status: 200 } },
      ...Array.from({ length: 2 }, () => ({
        request: { method: "POST", route: "/_matrix/media/v3/upload" },
        response: { status: 200 },
      })),
    ]);
  });

  it("normalizes substrate-specific Matrix identifiers from routes", () => {
    const routes = [
      [
        "rooms/!r%3Ax/send/m.room.message/txn",
        "rooms/{roomId}/send/m.room.message/{transactionId}",
      ],
      ["rooms/!r%3Ax/redact/$e%3Ax/txn", "rooms/{roomId}/redact/{eventId}/{transactionId}"],
      ["/media/v3/download/x/id", "/media/v3/download/{serverName}/{mediaId}"],
      ["/media/v3/download/x/id/f.pdf", "/media/v3/download/{serverName}/{mediaId}/{filename}"],
      ["/client/v1/media/thumbnail/x/id", "/client/v1/media/thumbnail/{serverName}/{mediaId}"],
      ["user/@a%3Ax/filter/id", "user/{userId}/filter/{filterId}"],
      [
        "user/@a%3Ax/account_data/m.secret_storage.key.id",
        "user/{userId}/account_data/m.secret_storage.key.{keyId}",
      ],
      ["room_keys/keys/!r%3Ax/id", "room_keys/keys/{roomId}/{sessionId}"],
    ] satisfies Array<[string, string]>;
    for (const [route, expected] of routes) {
      const prefix = route.startsWith("/") ? "/_matrix" : clientPath;
      expect(normalizeMatrixQaRoute(`${prefix}${route}`)).toBe(`${prefix}${expected}`);
    }
  });

  it("records in-place faults without changing the canonical proxy URL", async () => {
    const recording = await startRecording();
    const baseUrl = recording.baseUrl;
    const handle = recording.installFaultRule({
      id: "in-place-backup-unavailable",
      match: (request) => request.path.endsWith("/room_keys/version"),
      response: () => ({
        body: { errcode: "M_NOT_FOUND", error: "secret-in-place-fault" },
        status: 404,
      }),
    });
    const response = await fetch(`${baseUrl}${backupPath}`);
    expect(response.status).toBe(404);
    expect(recording.baseUrl).toBe(baseUrl);
    expect(handle.hits()).toHaveLength(1);
    expect(recording.records().at(-1)?.response).toEqual({ status: 404 });
    handle.remove();
    handle.remove();
    const forwarded = await fetch(`${baseUrl}${backupPath}`);
    expect(forwarded.status).toBe(401);
    expect(recording.records().at(-1)?.response).toEqual({ status: 401 });
    expect(handle.hits()).toHaveLength(1);
  });

  it("records proxy-generated upstream failures", async () => {
    const recording = await startRecording("http://127.0.0.1:1");
    const response = await fetch(`${recording.baseUrl}${syncPath}?timeout=0`);
    expect(response.status).toBe(502);
    expect(recording.records().at(-1)?.response).toEqual({ status: 502 });
  });
});
