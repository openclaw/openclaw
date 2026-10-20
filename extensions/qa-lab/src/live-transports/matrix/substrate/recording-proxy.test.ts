import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeMatrixQaRoute } from "./recording-proxy-internals.js";
import { startMatrixQaRecordingProxy } from "./recording-proxy.js";

const closeCallbacks: Array<() => Promise<void>> = [];
const clientPath = "/_matrix/client/v3/";

afterEach(async () => {
  while (closeCallbacks.length > 0) {
    await closeCallbacks.pop()?.();
  }
});

function jsonResponse(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("recording target did not bind");
  }
  closeCallbacks.push(
    async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return `http://127.0.0.1:${address.port}`;
}

async function startRecording(targetBaseUrl?: string) {
  const recording = await startMatrixQaRecordingProxy({
    targetBaseUrl:
      targetBaseUrl ??
      (await listen(
        createServer((_req, res) =>
          jsonResponse(res, { errcode: "M_UNKNOWN_TOKEN", error: "secret-response" }, 401),
        ),
      )),
  });
  closeCallbacks.push(() => recording.stop());
  return recording;
}

describe("Matrix QA recording proxy", () => {
  it("records completed uploads for the native-media scenario without retaining request data", async () => {
    let uploadCount = 0;
    const proxy = await startRecording(
      await listen(
        createServer((req, res) => {
          req.resume();
          if (req.url?.startsWith("/_matrix/media/v3/upload")) {
            uploadCount += 1;
            jsonResponse(res, { content_uri: "mxc://matrix.test/secret-media" });
          } else {
            jsonResponse(res, { next_batch: "secret-sync", body: "secret-message" });
          }
        }),
      ),
    );
    await fetch(`${proxy.baseUrl}${clientPath}sync?access_token=secret-query`, {
      headers: { authorization: "Bearer secret-header" },
    });
    const matrixRecordIndex = proxy.records().length;
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
    const uploads = proxy
      .records()
      .slice(matrixRecordIndex)
      .filter(
        (record) =>
          record.request.method === "POST" &&
          record.request.route.includes("/media/") &&
          record.request.route.endsWith("/upload") &&
          record.response.status >= 200 &&
          record.response.status < 300,
      );
    expect(uploadCount).toBe(2);
    expect(uploads).toHaveLength(2);
    expect(proxy.records()).toEqual([
      { request: { method: "GET", route: `${clientPath}sync` }, response: { status: 200 } },
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

  it("records in-place scenario faults without changing the canonical proxy URL", async () => {
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

    const response = await fetch(`${baseUrl}${clientPath}room_keys/version`);
    expect(response.status).toBe(404);
    expect(recording.baseUrl).toBe(baseUrl);
    expect(handle.hits()).toHaveLength(1);
    expect(recording.records().at(-1)?.response).toEqual({ status: 404 });

    handle.remove();
    handle.remove();
    const forwarded = await fetch(`${baseUrl}${clientPath}room_keys/version`);
    expect(forwarded.status).toBe(401);
    expect(recording.records().at(-1)?.response).toEqual({ status: 401 });
    expect(handle.hits()).toHaveLength(1);
  });

  it("records proxy-generated upstream failures", async () => {
    const recording = await startRecording("http://127.0.0.1:1");
    const response = await fetch(`${recording.baseUrl}${clientPath}sync?timeout=0`);

    expect(response.status).toBe(502);
    expect(recording.records().at(-1)?.response).toEqual({ status: 502 });
  });
});
