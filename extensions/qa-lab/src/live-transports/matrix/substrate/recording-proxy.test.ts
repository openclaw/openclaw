import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeMatrixQaRoute } from "./recording-proxy-internals.js";
import { startMatrixQaRecordingProxy, type MatrixQaRecordingProxy } from "./recording-proxy.js";

const closeCallbacks: Array<() => Promise<void>> = [];
const clientPath = "/_matrix/client/v3/";
const statePath = "rooms/!same:matrix.test/state/m.room.name";
const jsonHeaders = { "content-type": "application/json" };
const shape = (...fields: string[]) => ({ kind: "json", fields });
const keyed = <T>(id: string, value: T) => ({ [id]: value });
const events = (...entries: unknown[]) => ({ events: entries });
const get = (proxy: MatrixQaRecordingProxy, path: string, token?: string) =>
  fetch(`${proxy.baseUrl}${clientPath}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });

afterEach(async () => {
  while (closeCallbacks.length > 0) {
    await closeCallbacks.pop()?.();
  }
});

function jsonResponse(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(body));
}

function sendJson(
  proxy: MatrixQaRecordingProxy,
  path: string,
  body: unknown,
  method: "POST" | "PUT" = "POST",
  token?: string,
) {
  return fetch(`${proxy.baseUrl}${clientPath}${path}`, {
    method,
    headers: {
      ...jsonHeaders,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function syncRequest(search = "?timeout=0", bearerToken?: string) {
  return {
    bearerToken,
    body: Buffer.alloc(0),
    headers: {},
    method: "GET",
    path: `${clientPath}sync`,
    search,
  };
}

async function exchangeSync(
  recording: MatrixQaRecordingProxy,
  request: ReturnType<typeof syncRequest>,
  nextBatch: string,
  context = recording.createExchangeContext?.(request),
) {
  await recording.onExchange?.({
    context,
    request,
    response: {
      body: Buffer.from(JSON.stringify({ next_batch: nextBatch })),
      headers: new Headers(jsonHeaders),
      status: 200,
    },
  });
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

async function startRecordingTarget() {
  let syncCount = 0;
  let stateCount = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://matrix.test");
    if (url.pathname.endsWith("/sync")) {
      syncCount += 1;
      const since = url.searchParams.get("since");
      jsonResponse(res, {
        account_data: events({
          content: {
            encrypted: {
              SECRET_NESTED_STORAGE_KEY: { ciphertext: "secret-nested-ciphertext" },
            },
            unsigned: {
              "secret-custom-field-name": "secret-custom-field-value",
            },
            url: "mxc://matrix.test/secret-media",
            info: { mimetype: "image/png" },
          },
          type: "m.cross_signing.master",
        }),
        device_keys: keyed(
          "@secret-user:matrix.test",
          keyed("SECRET_DEVICE", {
            keys: keyed("ed25519:SECRET_DEVICE", "secret-signing-key"),
          }),
        ),
        device_one_time_keys_count: { signed_curve25519: 12 },
        device_unused_fallback_key_types: ["signed_curve25519"],
        next_batch: since === "echoed-unknown" ? since : `secret-sync-${syncCount}`,
        device_lists: { changed: ["secret-device"] },
        rooms: {
          join: keyed("!secret-room:matrix.test", {
            timeline: events(
              { type: "m.room.message" },
              { sender: "@secret-sender:matrix.test", type: "m.room.encrypted" },
            ),
          }),
        },
      });
      return;
    }
    const response = [
      [
        "/room_keys/keys",
        {
          rooms: keyed("!secret-backup-room:matrix.test", {
            sessions: keyed("secret-backup-session", { first_message_index: 0 }),
          }),
        },
      ],
      ["/keys/upload", { one_time_key_counts: {} }],
      ["/keys/query", { failures: keyed("secret-server.example", { errcode: "M_UNAVAILABLE" }) }],
      ["/account_data/", {}],
      ["/sendToDevice/", {}],
    ] satisfies Array<[string, unknown]>;
    const match = response.find(([path]) =>
      path.startsWith("/keys/") ? url.pathname.endsWith(path) : url.pathname.includes(path),
    );
    if (match) {
      jsonResponse(res, match[1]);
      return;
    }
    if (url.pathname.includes("/state/")) {
      stateCount += 1;
      const status = stateCount === 1 ? 401 : 200;
      jsonResponse(
        res,
        status === 401
          ? { errcode: "M_UNKNOWN_TOKEN", error: "secret-response" }
          : { name: "secret-state-name" },
        status,
      );
      return;
    }
    jsonResponse(res, { errcode: "M_UNKNOWN_TOKEN", error: "secret-response" }, 401);
  });
  return await listen(server);
}

async function startRecording(scenarioId = "test", targetBaseUrl?: string) {
  const recording = await startMatrixQaRecordingProxy({
    targetBaseUrl: targetBaseUrl ?? (await startRecordingTarget()),
  });
  closeCallbacks.push(() => recording.stop());
  recording.setScenarioId(scenarioId);
  return recording;
}

function scenarioExpectation(recording: MatrixQaRecordingProxy, scenarioId = "test") {
  return recording.buildManifest({
    requestedProfile: "test",
    scenarioIds: [scenarioId],
    substrate: { id: "tuwunel", version: "test" },
  }).scenarios[scenarioId];
}

describe("Matrix QA recording proxy", () => {
  it("records only redacted shapes and derives scenario expectations", async () => {
    const proxy = await startRecording();

    const firstSync = await get(proxy, "sync?timeout=0&access_token=secret-query", "secret-header");
    const firstBody = (await firstSync.json()) as { next_batch: string };
    await get(
      proxy,
      `sync?timeout=0&since=${encodeURIComponent(firstBody.next_batch)}`,
      "secret-header",
    );
    const postState = () =>
      sendJson(
        proxy,
        "rooms/!secret:matrix.test/state/m.room.name",
        { password: "secret-password", body: "secret-message" },
        "POST",
        "secret-header",
      );
    await postState();
    await get(proxy, "room_keys/keys", "secret-header");
    await sendJson(
      proxy,
      "keys/upload",
      {
        device_keys: {
          algorithms: ["m.olm.v1.curve25519-aes-sha2"],
          device_id: "SECRET_UPLOAD_DEVICE",
          keys: { "ed25519:SECRET_UPLOAD_DEVICE": "secret-upload-key" },
          user_id: "@secret-upload:matrix.test",
        },
        one_time_keys: keyed("signed_curve25519:SECRET_ONE_TIME", { key: "secret-one-time-key" }),
      },
      "POST",
      "secret-header",
    );
    await sendJson(proxy, "keys/query", { device_keys: {} });
    await sendJson(
      proxy,
      "user/@secret-upload%3Amatrix.test/account_data/m.cross_signing.master",
      {
        encrypted: keyed("SECRET_STORAGE_KEY", { ciphertext: "secret-ciphertext" }),
      },
      "PUT",
    );
    await sendJson(
      proxy,
      "user/@secret-upload%3Amatrix.test/account_data/m.megolm_backup.v1",
      { version: "1" },
      "PUT",
    );
    await sendJson(
      proxy,
      "sendToDevice/m.room.encrypted/transaction-42",
      {
        messages: keyed(
          "@secret-recipient:matrix.test",
          keyed("SECRET_RECIPIENT_DEVICE", {
            content: "secret-device-message",
          }),
        ),
      },
      "PUT",
    );
    await postState();

    const records = proxy.records();
    const serialized = JSON.stringify(records);
    const secrets = `secret-query secret-header secret-password secret-message secret-sync
      secret-response secret-room secret-backup-room secret-backup-session secret-state-name
      secret-user SECRET_DEVICE SECRET_UPLOAD_DEVICE SECRET_ONE_TIME SECRET_RECIPIENT_DEVICE
      secret-server.example SECRET_STORAGE_KEY SECRET_NESTED_STORAGE_KEY secret-custom-field-name`;
    for (const secret of secrets.split(/\s+/u)) {
      expect(serialized).not.toContain(secret);
    }
    const expectBody = (route: string, side: "request" | "response", ...fields: string[]) => {
      expect(records.find((record) => record.request.route.endsWith(route))?.[side].body).toEqual(
        shape(...fields),
      );
    };
    expectBody(
      "/keys/upload",
      "request",
      "device_keys.algorithms",
      "device_keys.device_id",
      "device_keys.keys.{keyId}",
      "device_keys.user_id",
      "one_time_keys.{keyId}.key",
    );
    expectBody(
      "/sendToDevice/m.room.encrypted/{transactionId}",
      "request",
      "messages.{userId}.{deviceId}.content",
    );
    expectBody("/keys/query", "response", "failures.{serverName}.errcode");
    expectBody("/account_data/m.cross_signing.master", "request", "encrypted.{keyId}.ciphertext");
    expect(records[1]?.sync).toMatchObject({ continuity: true, since: "sync-1" });

    const manifest = proxy.buildManifest({
      generatedAt: "2026-07-03T00:00:00.000Z",
      requestedProfile: "all",
      scenarioIds: ["test"],
      substrate: { id: "tuwunel", version: "v1.5.1" },
    });
    const expectation = manifest.scenarios.test;
    expect(manifest.profile).toEqual({
      derivedFrom: "observed-request-response-traffic",
      id: "matrix-qa-v1",
    });
    expect(expectation).toEqual(
      expect.objectContaining({
        syncTokens: {
          continuityObserved: true,
          incrementalRequests: 1,
          initialRequests: 1,
          responseTokens: 2,
        },
        state: expect.objectContaining({
          device: [`${clientPath}keys/upload`, `${clientPath}sync`],
          key: expect.arrayContaining([
            `${clientPath}user/{userId}/account_data/m.cross_signing.master`,
            `${clientPath}sync`,
          ]),
          backup: expect.arrayContaining([
            `${clientPath}user/{userId}/account_data/m.megolm_backup.v1`,
          ]),
          media: expect.arrayContaining([`${clientPath}sync`]),
        }),
      }),
    );
    expect(expectation?.ordering[0]).toMatchObject({
      requestBody: { kind: "empty" },
      responseBody: {
        kind: "json",
        fields: expect.arrayContaining([
          "rooms.join.{roomId}.timeline.events[].sender",
          "rooms.join.{roomId}.timeline.events[].type",
        ]),
      },
    });
    expect(expectation?.retries).toEqual([]);
    expect(expectation?.errors).toEqual([
      {
        errcode: "M_UNKNOWN_TOKEN",
        method: "POST",
        route: "/_matrix/client/v3/rooms/{roomId}/state/m.room.name",
        status: 401,
      },
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

    const response = await get(recording, "room_keys/version");
    expect(response.status).toBe(404);
    expect(recording.baseUrl).toBe(baseUrl);
    expect(handle.hits()).toHaveLength(1);
    expect(recording.records().at(-1)?.response).toMatchObject({
      errcode: "M_NOT_FOUND",
      status: 404,
    });
    expect(JSON.stringify(recording.records().at(-1))).not.toContain("secret-in-place-fault");

    handle.remove();
    handle.remove();
    const forwarded = await get(recording, "room_keys/version");
    expect(forwarded.status).toBe(401);
    expect(handle.hits()).toHaveLength(1);
  });

  it("records proxy-generated upstream failures", async () => {
    const recording = await startRecording("test", "http://127.0.0.1:1");
    const response = await get(recording, "sync?timeout=0");

    expect(response.status).toBe(502);
    expect(recording.records().at(-1)?.response).toMatchObject({
      errcode: "MATRIX_QA_FAULT_PROXY_ERROR",
      status: 502,
    });
  });

  it("redacts signature upload device and cross-signing key identifiers", async () => {
    const recording = await startRecording();

    await sendJson(
      recording,
      "keys/signatures/upload",
      keyed("@secret-signing-user:matrix.test", { SECRET_CROSS_SIGNING_KEY: { signatures: {} } }),
    );
    const record = recording.records().at(-1);
    expect(record?.request.body).toEqual(shape("{userId}.{deviceOrKeyId}.signatures"));
    for (const secret of ["secret-signing-user", "SECRET_CROSS_SIGNING_KEY"]) {
      expect(JSON.stringify(record)).not.toContain(secret);
    }
  });

  it("does not learn an unknown request token from the same sync response", async () => {
    const recording = await startRecording();

    await get(recording, "sync?timeout=0&since=echoed-unknown");

    expect(recording.records().at(-1)).toMatchObject({
      sync: { continuity: false, since: "sync-unknown" },
      request: { query: { since: "sync-unknown" } },
    });
    expect(scenarioExpectation(recording)?.syncTokens).toMatchObject({
      continuityObserved: false,
      incrementalRequests: 1,
    });
  });

  it("does not conflate identical operations from different principals", async () => {
    const recording = await startRecording();
    await sendJson(recording, statePath, { name: "same" }, "POST", "first");
    await sendJson(recording, statePath, { name: "same" }, "POST", "second");

    expect(scenarioExpectation(recording)?.retries).toEqual([]);
  });

  it("attributes sync completion to the active scenario", async () => {
    const recording = await startRecording("previous-scenario");
    const request = syncRequest();
    const context = recording.createExchangeContext?.(request);
    recording.setScenarioId("active-scenario");
    await exchangeSync(recording, request, "sync-complete", context);

    expect(recording.records().at(-1)?.scenarioId).toBe("active-scenario");
  });

  it("does not share sync-token continuity across principals", async () => {
    const recording = await startRecording();
    await exchangeSync(recording, syncRequest("?timeout=0", "first"), "shared-token");
    await exchangeSync(
      recording,
      syncRequest("?timeout=0&since=shared-token", "second"),
      "second-token",
    );

    expect(recording.records().at(-1)?.sync).toMatchObject({
      continuity: false,
      since: "sync-unknown",
    });
  });

  it("does not infer retries across intervening operations", async () => {
    const recording = await startRecording();
    const stateEndpoint = `${recording.baseUrl}${clientPath}${statePath}`;

    await fetch(stateEndpoint, { method: "POST" });
    await fetch(`${recording.baseUrl}/_matrix/client/versions`);
    await fetch(stateEndpoint, { method: "POST" });

    expect(scenarioExpectation(recording)?.retries).toEqual([]);
  });

  it("records repeated retry chains and ends each at the first recovery", async () => {
    let requestCount = 0;
    const server = createServer((_req, res) => {
      requestCount += 1;
      const status = requestCount <= 4 && requestCount % 2 === 1 ? 503 : 200;
      jsonResponse(res, status === 200 ? {} : { errcode: "M_UNAVAILABLE" }, status);
    });
    const recording = await startRecording("test", await listen(server));
    const endpoint = `${recording.baseUrl}${clientPath}${statePath}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await fetch(endpoint, { method: "POST" });
    }

    expect(scenarioExpectation(recording)?.retries).toEqual([
      expect.objectContaining({ attempts: 2, statuses: [503, 200] }),
      expect.objectContaining({ attempts: 2, statuses: [503, 200] }),
    ]);
  });
});
