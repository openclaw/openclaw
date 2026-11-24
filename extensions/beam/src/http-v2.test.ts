import { createHash } from "node:crypto";
import http from "node:http";
import { expect, it } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { sampleUpload, staffReceipt } from "./beam-store.test-support.js";
import { beamTestAuthority, persistentBeamTestStore } from "./beam.test-support.js";
import { createBeamV2Handler } from "./http-v2.js";
import { createBeamIngressLimits, createBeamRequestHandler } from "./http.js";
import { createBeamSessionCatalog } from "./session-catalog.js";
import { BEAM_MAX_BODY_BYTES, BEAM_MAX_GUEST_RECEIPTS, BEAM_RETENTION_MS } from "./types.js";

it("reads one publication generation and protects a visitor's snapshot across replacement and deletion", async () => {
  const { store, keyedStore, close } = await persistentBeamTestStore();
  let profile: string | undefined = "publisher";
  let revokeOnRead = false;
  let revoked = false;
  let disconnectOnRead = false;
  let disconnected = false;
  let hostFailure: unknown;
  let observedGrant: string | undefined;
  const ended = new Error("original Visitor grant ended");
  const closed = new Error("request transport closed");
  let scopes = ["operator.sessions.write"];
  const visitor = () => ({
    personProfileId: profile,
    attributionProfileId: "publisher",
    scopes,
    requiredGrantPluginId: "visitor-access",
    assertCurrent(requiredGrantPluginId?: string) {
      observedGrant = requiredGrantPluginId;
      if (disconnected) {
        throw closed;
      }
      if (revoked && requiredGrantPluginId === "visitor-access") {
        throw ended;
      }
    },
    async revalidate() {
      throw new Error("Snapshot reads may not re-admit the caller");
    },
  });
  const handler = createBeamV2Handler({
    async readPublication(id) {
      const row = await store.readPublication(id);
      if (revokeOnRead) {
        revoked = true;
      }
      if (disconnectOnRead) {
        disconnected = true;
      }
      return row;
    },
    putSnapshot: store.putSnapshot,
    currentAuthority: visitor,
    controlUiBasePath: () => "/console",
  });
  await using server = http.createServer((req, res) => {
    // The public proxy forwards /team to the Gateway root, with no mount header.
    req.url = req.url?.replace(/^\/team(?=\/)/, "");
    void handler(req, res).catch((error: unknown) => {
      // Production HTTP maps this failure at the Gateway boundary, without exposing the row.
      hostFailure = error;
      res.destroy();
    });
  });
  try {
    const origin = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    const upload = sampleUpload({ hookEvent: "Stop" });
    const publish = () =>
      store.upload(upload, {
        ...staffReceipt(Date.now()),
        publisher: { kind: "guest", profileId: "publisher" },
      });
    await publish();
    const headUrl = `${origin}/team/api/v2/beam/snapshots/${upload.beamId}/head`;
    const head = await (await fetch(headUrl)).json();
    expect(head).toMatchObject({ beamId: upload.beamId, canRelease: false, state: "writable" });
    const url = new URL(`${head.apiUrl}/snapshot`, headUrl);
    expect(url.pathname).toBe(`/team/api/v2/beam/publications/${head.publicationId}/snapshot`);
    expect(new URL(head.url, headUrl).pathname).toMatch(/^\/team\/console\/beam\//);
    scopes = ["operator.read"];
    expect((await (await fetch(headUrl)).json()).canRelease).toBe(false);
    expect(observedGrant).toBeUndefined();
    scopes = ["operator.sessions.write"];
    const snapshot = await fetch(url);
    const bytes = await snapshot.text();
    expect(snapshot.headers.get("etag")).toBe(head.revision);
    expect(head.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    expect(JSON.parse(bytes)).toEqual({
      version: 2,
      beamId: upload.beamId,
      source: upload.source,
      title: upload.title,
      updatedAt: upload.updatedAt,
      completed: false,
      items: upload.items,
    });
    revokeOnRead = true;
    expect(await (await fetch(url)).text()).toBe(bytes);
    expect(observedGrant).toBeUndefined();
    revokeOnRead = false;
    await expect(fetch(url)).rejects.toThrow();
    expect(hostFailure).toBe(ended);
    expect(observedGrant).toBe("visitor-access");
    revoked = false;
    disconnectOnRead = true;
    await expect(fetch(url)).rejects.toThrow();
    expect(hostFailure).toBe(closed);
    disconnectOnRead = false;
    disconnected = false;
    profile = undefined;
    expect((await fetch(url)).status).toBe(404);
    profile = "another-visitor";
    const hidden = await fetch(url);
    const absent = await fetch(`${origin}/api/v2/beam/snapshots/${"a".repeat(32)}/head`);
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).toBe(await absent.text());
    profile = "publisher";
    upload.title = "Updated at the same source timestamp";
    await publish();
    const latest = await (await fetch(headUrl)).json();
    expect(latest.publicationId).toBe(head.publicationId);
    expect(latest.revision).not.toBe(head.revision);
    expect(latest.digest).not.toBe(head.digest);
    await store.delete(upload.beamId);
    await publish();
    expect((await fetch(url)).status).toBe(404);
    expect((await (await fetch(headUrl)).json()).publicationId).not.toBe(head.publicationId);

    // The stable receiver wrote only uploader attribution; no publication generation or owner.
    const oldRow = { ...upload, createdAt: 10, receivedAt: 10, uploaderProfileId: profile };
    await keyedStore.register(upload.beamId, oldRow);
    expect((await fetch(headUrl)).status).toBe(404);
    scopes = ["operator.read"];
    const legacy = await (await fetch(headUrl)).json();
    expect(legacy).toMatchObject({
      state: "legacy_unbound",
      canRelease: false,
      snapshotUrl: "snapshot",
    });
    expect(legacy).not.toHaveProperty("publicationId");
    const oldSnapshot = new URL(legacy.snapshotUrl, headUrl);
    expect((await fetch(oldSnapshot)).status).toBe(412);
    const selected = await fetch(oldSnapshot, { headers: { "If-Match": legacy.revision } });
    expect(selected.status).toBe(200);
    expect(selected.headers.get("beam-digest")).toBe(legacy.digest);
    expect((await keyedStore.lookup(upload.beamId))?.publicationId).toBeUndefined();
    await keyedStore.register(upload.beamId, { ...oldRow, title: "Changed" });
    expect((await fetch(oldSnapshot, { headers: { "If-Match": legacy.revision } })).status).toBe(
      412,
    );
  } finally {
    await close();
  }
});

it("conditionally publishes exact bytes, replays the original receipt and fences a competing v1 writer", async () => {
  const { store, close } = await persistentBeamTestStore();
  const authority = () => ({
    personProfileId: "publisher",
    scopes: ["operator.write"],
    assertCurrent() {},
    async revalidate() {},
  });
  const handler = createBeamV2Handler({
    ...store,
    currentAuthority: authority,
    controlUiBasePath: () => undefined,
  });
  await using server = http.createServer((req, res) => void handler(req, res));
  try {
    const origin = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    const v1 = sampleUpload();
    const target = `${origin}/api/v2/beam/snapshots/${v1.beamId}`;
    const packet = {
      ...v1,
      version: 2,
      items: [{ type: "userMessage", speaker: "p2", text: "Selected text" }],
    };
    const raw = JSON.stringify(packet, null, 2) + "\n";
    const key = "12345678-1234-4123-abcd-000000000001";
    const put = (data: string, id: string, condition: Record<string, string>) =>
      fetch(target, {
        method: "PUT",
        headers: { "content-type": "application/json", "idempotency-key": id, ...condition },
        body: data,
      });
    const absent = { "if-none-match": "*" };
    const oversized = await put(" ".repeat(BEAM_MAX_BODY_BYTES + 1), key, absent);
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("connection")).toBe("close");
    expect(await oversized.json()).toMatchObject({ error: { code: "too_large" } });
    const success = await put(raw, key, absent);
    expect(success.status).toBe(200);
    const first = await success.json();
    expect(first).toMatchObject({
      disposition: "applied",
      digest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    });
    const machine = new URL(`${first.apiUrl}/snapshot`, target);
    expect(await (await fetch(machine)).text()).toBe(raw);
    const catalog = createBeamSessionCatalog(store);
    const history = await catalog.read({ agentId: "main", hostId: "gateway", threadId: v1.beamId });
    expect(history.items[0]?.sender).toMatchObject({
      label: "p2",
      identity: { type: "observation" },
    });
    expect((await put(raw + " ", key, absent)).status).toBe(409);
    const fresh = "12345678-1234-4123-abcd-000000000002";
    expect((await put(raw, fresh, absent)).status).toBe(412);
    await store.upload(v1, staffReceipt(Date.now()));
    expect((await put(raw, fresh, { "if-match": first.revision })).status).toBe(412);
    expect(await (await put(raw, key, absent)).json()).toEqual(first);
    const current = await (await fetch(target + "/head")).json();
    const replacement = await put(raw, fresh, { "if-match": current.revision });
    expect(replacement.status).toBe(200);
    const next = await replacement.json();
    expect(next.publicationId).toBe(first.publicationId);
    expect(next.revision).not.toBe(first.revision);
    const unchanged = await put(raw, "12345678-1234-4123-abcd-000000000003", {
      "if-match": next.revision,
    });
    expect(await unchanged.json()).toMatchObject({
      revision: next.revision,
      disposition: "unchanged",
    });
    const duplicate = raw.replace('"version": 2', '"version": 2, "version": 2');
    expect((await put(duplicate, fresh, { "if-match": next.revision })).status).toBe(400);
  } finally {
    await close();
  }
});

it("keeps exhausted Visitor receipt capacity local to its publisher", async () => {
  const { store, writeStore, close } = await persistentBeamTestStore();
  try {
    const packet = sampleUpload();
    const send = (profileId: string, requestId: string, suffix: string) => {
      const upload = { ...packet, beamId: suffix.repeat(32) };
      const packetText = JSON.stringify({ ...upload, version: 2 });
      return store.putSnapshot(
        {
          upload,
          requestId,
          ifMatch: null,
          packetText,
          digest: "sha256:" + createHash("sha256").update(packetText).digest("hex"),
          receivedAt: Date.now(),
          publisher: { kind: "guest", profileId },
        },
        () => {},
      );
    };
    const quotaKey = "guest:" + createHash("sha256").update("one").digest("hex");
    await writeStore.register(
      quotaKey,
      Array(BEAM_MAX_GUEST_RECEIPTS - 1).fill(Date.now() + BEAM_RETENTION_MS),
    );
    const receipt = await send("one", "first", "a");
    expect(receipt).toMatchObject({ disposition: "applied" });
    expect(await send("one", "first", "a")).toEqual(receipt);
    const full = await send("one", "second", "b");
    expect(full).toMatchObject({
      refusal: "receipt_capacity",
      retryAfterSeconds: expect.any(Number),
    });
    const handler = createBeamV2Handler({
      ...store,
      currentAuthority: () => ({
        scopes: ["operator.sessions.write"],
        personProfileId: "one",
        requiredGrantPluginId: "visitor-access",
        assertCurrent() {},
        async revalidate() {},
      }),
      controlUiBasePath: () => undefined,
    });
    await using server = http.createServer((req, res) => void handler(req, res));
    const beamId = "b".repeat(32);
    const origin = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    const refused = await fetch(origin + "/api/v2/beam/snapshots/" + beamId, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "if-none-match": "*",
        "idempotency-key": "12345678-1234-4123-abcd-000000000019",
      },
      body: JSON.stringify({ ...packet, version: 2, beamId }),
    });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "rate_limited",
        retry: "same_request",
        message: expect.stringContaining("original Idempotency-Key"),
      },
    });
    expect(await store.get("b".repeat(32))).toBeUndefined();
    expect(await send("two", "second", "c")).toMatchObject({ disposition: "applied" });
  } finally {
    await close();
  }
});

it("shares the publishing budget between both protocol versions", async () => {
  const { store, close } = await persistentBeamTestStore();
  const limits = createBeamIngressLimits();
  const addr = "127.0.0.1";
  const authority = beamTestAuthority({ clientIp: addr });
  const v1 = createBeamRequestHandler({
    store,
    limits,
    resolveAuthority: () => authority,
    resolveControlUiBasePath: () => undefined,
  });
  const v2 = createBeamV2Handler({
    ...store,
    limits,
    currentAuthority: () => authority,
    controlUiBasePath: () => undefined,
  });
  await using server = http.createServer(
    (req, res) => void (req.url?.startsWith("/api/v2/") ? v2 : v1)(req, res),
  );
  try {
    const origin = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    // Leave one admission in this IP's actual limiter. A malformed v1 JSON body still consumes it.
    for (let i = 0; i < 59; i++) {
      expect(limits.rateLimiter.isRateLimited(addr)).toBe(false);
    }
    expect(
      (
        await fetch(origin + "/api/v1/beam/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
    const result = await fetch(origin + "/api/v2/beam/snapshots/" + "a".repeat(32), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "if-none-match": "*",
        "idempotency-key": "12345678-1234-4123-abcd-000000000001",
      },
      body: "{}",
    });
    expect(result.status).toBe(429);
  } finally {
    await close();
  }
});
