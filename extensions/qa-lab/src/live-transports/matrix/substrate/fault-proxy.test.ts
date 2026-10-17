import { once } from "node:events";
import { createServer, request } from "node:http";
import { text } from "node:stream/consumers";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { buildRoomKeyBackupUnavailableFaultRule } from "../scenarios/scenario-runtime-e2ee-room.js";
import { startMatrixQaFaultProxy } from "./fault-proxy.js";

const syncPath = "/_matrix/client/v3/sync";
const backupPath = "/_matrix/client/v3/room_keys/version";
const forwardedBody = { forwarded: true };
type ForwardedRequest = { authorization?: string; body: string; method: string; url: string };
const servers: Array<{ close(): Promise<void> }> = [];

async function startTargetServer(params?: {
  responseBody?: Buffer | string;
  responseHeaders?: Record<string, string>;
}) {
  const requests: ForwardedRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      requests.push({
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        body: await text(req),
        method: req.method ?? "GET",
        url: req.url ?? "/",
      });
      res.writeHead(200, { "content-type": "application/json", ...params?.responseHeaders });
      res.end(params?.responseBody ?? JSON.stringify(forwardedBody));
    })().catch((error: unknown) =>
      res.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("target server did not bind to a TCP port");
  }
  const handle = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    requests,
  };
  servers.push(handle);
  return handle;
}

function forwardedRequest(url: string, overrides: Partial<ForwardedRequest> = {}) {
  return { body: "", method: "GET", url, ...overrides };
}
function faultHit(method: string, ruleId: string, path = syncPath) {
  return { method, path, ruleId };
}
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

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

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

  it("rejects request targets that resolve outside the configured origin", async () => {
    const { proxy, target } = await startProxy();
    const requestTarget = async (path: string) =>
      await new Promise<{ body: string; status: number | undefined }>((resolve, reject) => {
        const req = request(proxy.baseUrl, { path }, (res) => {
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
