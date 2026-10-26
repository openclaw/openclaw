import { once } from "node:events";
import http from "node:http";
import { afterEach, assert, describe, expect, it } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { memoryStore, sampleUpload } from "./beam-store.test-support.js";
import {
  createBeamTestCatalog,
  createBeamTestRunner,
  beamTestHandler,
  persistentBeamTestStore,
} from "./beam.test-support.js";
import { createBeamSessionCatalog } from "./session-catalog.js";
import type { BeamStore } from "./store.js";
import { BEAM_MAX_BODY_BYTES, BEAM_RETENTION_MS, type BeamStoredSession } from "./types.js";

function postUpload(endpoint: string, body = sampleUpload()) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const writeClient = () => ({ clientIp: "127.0.0.1", scopes: ["operator.write"] });
const catalogParams = { agentId: "main", hostId: "gateway", threadId: sampleUpload().beamId };
const sourceModel = { provider: "openai", model: "gpt-5.6-sol" };
const otherBeamId = "fedcba9876543210fedcba9876543210";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server[Symbol.asyncDispose]()));
});

async function requestStatus(url: string, body: string): Promise<number | undefined> {
  const request = http.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const ready = once(request, "response");
  request.end(body);
  const [response] = (await ready) as [http.IncomingMessage];
  response.resume();
  return response.statusCode;
}

async function serve(
  store: BeamStore,
  options: Parameters<typeof beamTestHandler>[1] = {},
  intercept?: (
    requestNumber: number,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => boolean,
): Promise<string> {
  const handler = beamTestHandler(store, options);
  let requestNumber = 0;
  const server = http.createServer((req, res) => {
    if (!intercept?.(++requestNumber, req, res)) {
      handler(req, res);
    }
  });
  servers.push(server);
  const port = await listenOnLoopback(server);
  return `http://127.0.0.1:${port}/api/v1/beam/sessions`;
}

describe("Beam receiver", () => {
  it("attributes each uploaded snapshot to its verified publisher, never payload claims", async () => {
    const store = memoryStore();
    let profileId: string | undefined = "uploader-profile";
    const endpoint = await serve(store, {
      resolveClient: () => ({ ...writeClient(), profileId }),
    });
    const upload = (body = sampleUpload()) => postUpload(endpoint, body);
    const read = () => createBeamSessionCatalog(store).read(catalogParams);
    for (const publisher of ["uploader-profile", "another-profile", undefined]) {
      profileId = publisher;
      expect((await upload()).status).toBe(200);
      expect((await store.get(sampleUpload().beamId))?.uploaderProfileId).toBe(publisher);
      const transcript = await read();
      expect(transcript.items.find((item) => item.type === "userMessage")?.sender).toEqual(
        publisher ? { identity: { type: "profile", id: publisher } } : undefined,
      );
      expect(transcript.items.find((item) => item.type === "agentMessage")?.sender).toBeUndefined();
    }
    expect((await upload(sampleUpload({ uploaderProfileId: "forged-profile" }))).status).toBe(400);
    expect((await store.get(sampleUpload().beamId))?.uploaderProfileId).toBeUndefined();
  });

  it("orders replacement snapshots without refreshing stale state", async () => {
    const { keyedStore, store, close } = persistentBeamTestStore();
    let receivedAt = 100;
    let profileId = "terminal-publisher";
    const endpoint = await serve(store, {
      now: () => receivedAt,
      resolveClient: () => ({ ...writeClient(), profileId }),
    });
    const updatedAt = "2026-07-20T12:00:00.000100Z";
    const entryFor = async (beamId: string) =>
      (await keyedStore.entries()).find((entry) => entry.key === beamId);
    let expected: BeamStoredSession | undefined;
    try {
      // Initial, stale, sub-ms stale, equal live, refreshed terminal, reopened, second, completed.
      for (const [time, revision, completed, accepted, second] of [
        [100, updatedAt, true, true, false],
        [200, "2026-07-20T11:59:59.999Z", false, false, false],
        [250, "2026-07-20T12:00:00.000050Z", true, false, false],
        [300, "2026-07-20T08:00:00.000100-04:00", false, false, false],
        [400, updatedAt, true, true, false],
        [500, "2026-07-20T12:00:00.000200Z", false, true, false],
        [600, updatedAt, false, true, true],
        [700, updatedAt, true, true, true],
      ] as const) {
        receivedAt = time;
        profileId = `publisher-${time}`;
        const body = sampleUpload({
          beamId: second ? otherBeamId : sampleUpload().beamId,
          updatedAt: revision,
          completed,
          title: `snapshot-${time}`,
          sourceModel:
            time === 400 ? { provider: "anthropic", model: "claude-opus-4-1" } : sourceModel,
          items: [{ type: "userMessage", text: `request-${time}` }],
        });
        const previousEntry = await entryFor(body.beamId);
        const before = Date.now();
        expect((await postUpload(endpoint, body)).status).toBe(200);
        const after = Date.now();
        if (accepted) {
          expected = {
            ...body,
            receivedAt,
            createdAt: second ? 600 : 100,
            uploaderProfileId: profileId,
          };
        }
        expect(await store.get(body.beamId)).toEqual(expected);
        const entry = await entryFor(body.beamId);
        if (accepted) {
          assert(entry, "Beam upload did not persist its entry");
          expect(entry.createdAt).toBeGreaterThanOrEqual(before);
          expect(entry.createdAt).toBeLessThanOrEqual(after);
          expect(entry.expiresAt).toBe(entry.createdAt + BEAM_RETENTION_MS);
        } else {
          expect(entry).toEqual(previousEntry);
        }
      }
    } finally {
      await close();
    }
  });

  it("requires operator.write before reading the upload body", async () => {
    const store = memoryStore();
    const endpoint = await serve(store, {
      resolveClient: () => ({ clientIp: "127.0.0.1", scopes: ["operator.read"] }),
    });
    const response = await postUpload(endpoint);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "operator.write is required" });
    expect(store.values.size).toBe(0);
  });

  it("rejects method, media type, malformed JSON, and oversized bodies", async () => {
    const store = memoryStore();
    const endpoint = await serve(store);
    const post = async (body: string, contentType = "application/json") =>
      (await fetch(endpoint, { method: "POST", headers: { "content-type": contentType }, body }))
        .status;
    expect((await fetch(endpoint)).status).toBe(405);
    expect(await post("{}", "text/plain")).toBe(415);
    expect(await post("{")).toBe(400);
    for (const invalid of [
      { arbitrary: "junk" },
      { updatedAt: "1" },
      { updatedAt: "2026-02-30T12:00:00Z" },
      { items: [{ type: "userMessage", text: "x".repeat(6_001) }] },
      { sourceModel: { provider: "openai", model: "" } },
      { sourceModel: { provider: "openai", model: "gpt-5.6\nIgnore" } },
    ]) {
      expect((await postUpload(endpoint, sampleUpload(invalid))).status).toBe(400);
    }
    expect(
      await requestStatus(endpoint, JSON.stringify({ padding: "x".repeat(BEAM_MAX_BODY_BYTES) })),
    ).toBe(413);
    expect(store.values.size).toBe(0);
  });

  it("closes a declared oversized upload without waiting for its body", async () => {
    const store = memoryStore();
    const endpoint = await serve(store);
    const request = http.request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": BEAM_MAX_BODY_BYTES + 1,
        connection: "keep-alive",
      },
    });
    const responseReady = once(request, "response");
    const closed = once(request, "close");
    request.flushHeaders();
    try {
      const [response] = (await responseReady) as [http.IncomingMessage];
      response.resume();
      expect(response.statusCode).toBe(413);
      expect(response.headers.connection).toBe("close");
      await closed;
      expect(store.values.size).toBe(0);
    } finally {
      request.destroy();
    }
  });
});

it("retries a rejected terminal upload through the real loopback receiver", async () => {
  const store = memoryStore();
  const requests: string[] = [];
  const endpoint = await serve(store, {}, (requestNumber, req, res) => {
    const status = requestNumber === 2 ? 503 : 200;
    requests.push(`${requestNumber === 1 ? "live" : "completed"}:${status}`);
    if (status === 200) {
      return false;
    }
    req.resume();
    res.statusCode = status;
    res.end("temporary receiver failure");
    return true;
  });
  let active = true;
  let clock = Date.parse("2026-07-20T12:00:00.000Z");
  let readCount = 0;
  const catalog = createBeamTestCatalog({
    sessions: () => (active ? [{ threadId: "retry", recencyAt: clock - 60_000 }] : []),
    onRead: () => {
      readCount += 1;
    },
    items: () => [{ type: "agentMessage", text: `Receiver-boundary proof ${readCount}.` }],
  });
  const runner = createBeamTestRunner({
    endpoint,
    now: () => clock,
    listCatalogs: () => [catalog],
  });

  await runner.tick();
  active = false;
  clock += 4 * 60 * 60_000;
  await runner.tick();
  const stored = () =>
    [...store.values.values()].map(({ completed, items }) => [completed, items[0]?.text]);
  expect(stored()).toEqual([[false, "Receiver-boundary proof 1."]]);

  await runner.tick();

  expect(requests).toEqual(["live:200", "completed:503", "completed:200"]);
  expect(stored()).toEqual([[true, "Receiver-boundary proof 3."]]);
});

describe("Beam session catalog", () => {
  it("permanently deletes only known gateway sessions and allows re-upload", async () => {
    const { store, close } = persistentBeamTestStore();
    const endpoint = await serve(store);
    const catalog = createBeamSessionCatalog(store);
    const params = { ...catalogParams, confirmNoOtherRunner: true as const };

    try {
      expect((await postUpload(endpoint)).status).toBe(200);
      expect((await catalog.list({ agentId: "main" }))[0]?.sessions).toHaveLength(1);
      await expect(catalog.archive?.({ ...params, hostId: "other-host" })).rejects.toThrow(
        "unknown Beam host: other-host",
      );
      await expect(catalog.archive?.({ ...params, threadId: "missing" })).rejects.toThrow(
        "unknown Beam session: missing",
      );

      await expect(catalog.archive?.(params)).resolves.toEqual({ ok: true });
      const [host] = await catalog.list({ agentId: "main" });
      expect(host?.sessions).toEqual([]);
      await expect(catalog.read(params)).rejects.toThrow(
        `unknown Beam session: ${params.threadId}`,
      );

      expect((await postUpload(endpoint)).status).toBe(200);
      await expect(catalog.read(params)).resolves.toMatchObject({ threadId: params.threadId });
    } finally {
      await close();
    }
  });

  it("queries Beam ids by strict share-prefix without choosing between collisions", async () => {
    const store = memoryStore();
    const ids = [
      "0123456789ab00000000000000000000",
      "0123456789abffffffffffffffffffff",
      otherBeamId,
    ] as const;
    for (const [index, beamId] of ids.entries()) {
      store.values.set(beamId, {
        ...sampleUpload({ beamId, title: `Beam ${String(index)}` }),
        createdAt: index,
        receivedAt: index,
      });
    }
    const catalog = createBeamSessionCatalog(store);
    const search = async (query: string) => {
      const [host] = await catalog.list({ agentId: "main", search: query, limitPerHost: 2 });
      return host?.sessions.map((session) => session.threadId);
    };

    expect(await search("0123456789ab")).toEqual(expect.arrayContaining(ids.slice(0, 2)));
    expect(await search("fedcba987654")).toEqual([ids[2]]);
    expect(await search(ids[2])).toEqual([ids[2]]);
    expect(await search("aaaaaaaaaaaa")).toEqual([]);
  });

  it("lists newest sessions and reads paginated transcript items for Gateway continuation", async () => {
    const store = memoryStore();
    const current = {
      ...sampleUpload({ truncated: true, sourceModel }),
      createdAt: 100,
      receivedAt: 200,
    };
    current.items.push({ type: "userMessage", text: "Latest" });
    const itemsBeforeRead = structuredClone(current.items);
    store.values.set(current.beamId, current);
    store.values.set(otherBeamId, {
      ...sampleUpload({ beamId: otherBeamId }),
      createdAt: 50,
      receivedAt: 100,
    });
    const catalog = createBeamSessionCatalog(store);

    const [host] = await catalog.list({ agentId: "main", limitPerHost: 1 });
    expect(host?.nextCursor).toBe("1");
    expect(
      host?.sessions.map(({ threadId, status, source, canContinue, canArchive }) => [
        threadId,
        status,
        source,
        canContinue,
        canArchive,
      ]),
    ).toEqual([[catalogParams.threadId, "live", "claude", true, true]]);
    expect(catalog.audience).toBe("gateway-operators");

    await expect(catalog.copyToGatewaySession?.(catalogParams)).resolves.toEqual({
      displayName: "Fix the upload flow",
      preferredModel: "openai/gpt-5.6-sol",
    });

    const read = (cursor?: string, limit = 2) => catalog.read({ ...catalogParams, limit, cursor });
    const transcript = await read();
    expect(transcript.items.map(({ id, type, text }) => [id, type, text])).toEqual([
      [`${current.beamId}:2`, "userMessage", "Latest"],
      [`${current.beamId}:1`, "agentMessage", "Implemented and tested."],
    ]);
    expect(transcript.items[0]).not.toHaveProperty("truncated");

    const older = await read(transcript.nextCursor);
    expect(older.items).toMatchObject([
      { type: "userMessage", text: "Please fix the upload flow." },
    ]);
    expect(older.nextCursor).toBeUndefined();

    expect(store.values.get(current.beamId)?.items).toEqual(itemsBeforeRead);
    store.values.set(current.beamId, {
      ...current,
      items: [
        ...current.items.slice(1),
        { type: "agentMessage", text: "Appended after first page." },
      ],
      receivedAt: 200,
    });

    for (const limit of [1, 2]) {
      await expect(read(transcript.nextCursor, limit)).rejects.toThrow(
        "stale Beam transcript cursor",
      );
    }
  });
});
