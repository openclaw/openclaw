import { createHash } from "node:crypto";
import http from "node:http";
import { expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { parseBeamPacket } from "../packet-contract/packet-v2.generated.js";
import { sampleUpload, staffReceipt } from "./beam-store.test-support.js";
import { beamTestAuthority, persistentBeamTestStore } from "./beam.test-support.js";
import { readBeamDestination } from "./destination-v2.js";
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
    releasePublication: store.releasePublication,
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
    expect(head).toMatchObject({ beamId: upload.beamId, canRelease: true, state: "writable" });
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
    const historicalText = "retained " + String.fromCharCode(0xd800);
    await keyedStore.register(upload.beamId, {
      ...oldRow,
      title: historicalText,
      sourceModel: { provider: "example", model: historicalText.trim().replace(" ", "-") },
      items: [{ type: "userMessage", text: historicalText }],
    });
    expect((await fetch(oldSnapshot, { headers: { "If-Match": legacy.revision } })).status).toBe(
      412,
    );
    const changed = await (await fetch(headUrl)).json();
    const restored = await fetch(oldSnapshot, { headers: { "If-Match": changed.revision } });
    const portable = parseBeamPacket(new Uint8Array(await restored.arrayBuffer()));
    expect(portable.title).toBe("retained \ufffd");
    expect(portable.items[0]?.text).toBe(portable.title);
    expect(portable.sourceModel?.model).toBe("retained-\ufffd");
    expect((await keyedStore.lookup(upload.beamId))?.title).toBe(historicalText);
  } finally {
    await close();
  }
});

it("conditionally publishes exact bytes, replays the original receipt and fences a competing v1 writer", async () => {
  const { store, keyedStore, close } = await persistentBeamTestStore();
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
    expect(await (await put(raw, key, absent)).json()).toEqual({ ...first, canRelease: false });
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

    // Model two receiver incarnations that retained the exact same content and write token.
    // The first receiver's enrolled conditional mirror must fail against the second one.
    const row = await keyedStore.lookup(v1.beamId);
    expect(row).toBeDefined();
    await keyedStore.register(v1.beamId, { ...row!, publicationId: "e".repeat(32) });
    const other = await (await fetch(target + "/head")).json();
    expect(other.digest).toBe(next.digest);
    expect(other.publicationId).not.toBe(next.publicationId);
    expect(other.revision).not.toBe(next.revision);
    expect(
      (await put(raw, "12345678-1234-4123-abcd-000000000004", { "if-match": next.revision }))
        .status,
    ).toBe(412);
  } finally {
    await close();
  }
});

it("records and replays a publication by a shared credential without assigning a person", async () => {
  const { store, close } = await persistentBeamTestStore();
  const handler = createBeamV2Handler({
    ...store,
    currentAuthority: () => ({
      attributionProfileId: "gateway-owner",
      scopes: ["operator.write"],
      assertCurrent() {},
      async revalidate() {},
    }),
    controlUiBasePath: () => undefined,
  });
  await using server = http.createServer((req, res) => void handler(req, res));
  try {
    const packet = { ...sampleUpload(), version: 2 };
    const target = `http://127.0.0.1:${await listenOnLoopback(server)}/api/v2/beam/snapshots/${packet.beamId}`;
    const publish = () =>
      fetch(target, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "if-none-match": "*",
          "idempotency-key": "12345678-1234-4123-abcd-000000000008",
        },
        body: JSON.stringify(packet),
      });
    const first = await publish();
    expect(first.status).toBe(200);
    const receipt = await first.json();
    expect(receipt).toMatchObject({ disposition: "applied", canRelease: false });
    expect(await (await publish()).json()).toEqual(receipt);
    expect(await store.get(packet.beamId)).not.toHaveProperty("publisherProfileId");
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

it("releases only the selected bytes for the original verified publisher and retains the receipt after archive", async () => {
  const { store, handoffStore, close } = await persistentBeamTestStore();
  let personProfileId: string | undefined = "owner";
  let scopes = ["operator.write"];
  const auth = () => ({ scopes, personProfileId, assertCurrent() {}, async revalidate() {} });
  const handler = createBeamV2Handler({
    ...store,
    currentAuthority: auth,
    controlUiBasePath: () => undefined,
  });
  await using server = http.createServer((req, res) => void handler(req, res));
  try {
    const origin = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    const upload = sampleUpload();
    const publish = () =>
      store.upload(upload, {
        ...staffReceipt(Date.now()),
        publisher: { kind: "staff", profileId: "owner" },
      });
    await publish();
    const headUrl = origin + "/api/v2/beam/snapshots/" + upload.beamId + "/head";
    const initial = await (await fetch(headUrl)).json();
    expect(initial.canRelease).toBe(true);
    const path = new URL(initial.apiUrl, headUrl).href;
    const key = "12345678-1234-4123-abcd-000000000001";
    const release = (revision: string, digest: string, requestId = key) =>
      fetch(path + "/release", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "if-match": revision,
          "idempotency-key": requestId,
        },
        body: JSON.stringify({ digest }),
      });
    personProfileId = "other";
    expect((await release(initial.revision, initial.digest)).status).toBe(404);
    personProfileId = undefined;
    expect((await release(initial.revision, initial.digest)).status).toBe(404);
    personProfileId = "owner";
    scopes = ["operator.read"];
    expect((await release(initial.revision, initial.digest)).status).toBe(404);
    scopes = ["operator.write"];
    await publish();
    expect((await release(initial.revision, initial.digest)).status).toBe(412);
    const current = await (await fetch(headUrl)).json();
    const success = await release(current.revision, current.digest);
    expect(success.status).toBe(200);
    const receipt = await success.json();
    expect(receipt).toMatchObject({
      publicationId: current.publicationId,
      revision: current.revision,
      state: "released",
      canRelease: false,
    });
    expect((await release(initial.revision, initial.digest)).status).toBe(409);
    expect(await (await fetch(path + "/destination")).json()).toEqual({
      state: "released_unbound",
    });
    expect(await publish()).toMatchObject({ kind: "handoff", accepted: false });
    const snapshot = await store.get(upload.beamId);
    expect(snapshot).toBeDefined();
    const reserved = await store.reserveContinuation(snapshot!, "main", () => {});
    reserved.release();
    expect(await (await fetch(path + "/destination")).json()).toEqual({ state: "creating" });
    expect(await store.delete(upload.beamId)).toBe(true);
    const retained = await handoffStore.lookup(upload.beamId);
    expect(retained).not.toHaveProperty("packetText");
    expect(retained).not.toHaveProperty("items");
    expect(await (await release(current.revision, current.digest)).json()).toEqual(receipt);
    expect((await fetch(path + "/snapshot")).status).toBe(410);
    expect(await (await fetch(path + "/destination")).json()).toEqual({
      state: "needs_reconciliation",
    });
    personProfileId = "other";
    expect((await release(current.revision, current.digest)).status).toBe(404);
  } finally {
    await close();
  }
});

it("exposes a bound destination only through a provenance-checked caller-authorized session incarnation", async () => {
  const refresh = vi.fn(async () => {});
  const auth = {
    scopes: ["operator.sessions.write"],
    requiredGrantPluginId: "visitor-access",
    personProfileId: "publisher",
    assertCurrent() {},
    revalidate: refresh,
  };
  const binding = {
    id: "opaque-reference",
    sessionKey: "agent:main:dashboard:opaque-reference",
    agentId: "main",
    ready: true as const,
  };
  const row = {
    ...sampleUpload(),
    createdAt: 1,
    receivedAt: 1,
    handoffId: "generation",
    publisherProfileId: "publisher",
    continuation: binding,
  };
  const dispatch =
    vi.fn<typeof import("openclaw/plugin-sdk/gateway-method-runtime").dispatchGatewayMethod>();
  dispatch.mockResolvedValueOnce({
    ok: true,
    payload: { sessionKey: binding.sessionKey, sessionId: "original" },
  });
  expect(await readBeamDestination(row, true, auth, dispatch)).toEqual({
    state: "ready",
    reference: binding.id,
    sessionKey: binding.sessionKey,
    sessionId: "original",
  });
  expect(dispatch).toHaveBeenCalledExactlyOnceWith("beam.owned.resolve", {
    catalogId: "beam",
    threadId: row.beamId,
    hostId: "gateway",
    agentId: "main",
  });
  expect(
    await readBeamDestination(row, true, { ...auth, personProfileId: "other" }, dispatch),
  ).toBe("unavailable");
  expect(dispatch).toHaveBeenCalledTimes(1);
  for (const payload of [
    { sessionKey: binding.sessionKey },
    { sessionKey: "other", sessionId: "original" },
  ]) {
    dispatch.mockResolvedValueOnce({ ok: true, payload });
    expect(
      await readBeamDestination(row, true, { ...auth, scopes: ["operator.read"] }, dispatch),
    ).toEqual({ state: "needs_reconciliation" });
  }
  dispatch.mockResolvedValueOnce({ ok: false, error: { code: "FORBIDDEN", message: "denied" } });
  expect(await readBeamDestination(row, true, auth, dispatch)).toBe("unavailable");
  expect(refresh).not.toHaveBeenCalled();
});

it("routes only the authenticated publication and matching instruction identity to the send service", async () => {
  const { store, close } = await persistentBeamTestStore();
  let person = "visitor";
  let scopes = ["operator.sessions.write"];
  const refresh = vi.fn(async () => {});
  const authority = () => ({
    personProfileId: person,
    scopes,
    requiredGrantPluginId: "visitor-access",
    assertCurrent() {},
    revalidate: refresh,
  });
  const id = "12345678-1234-4123-abcd-000000000007";
  const receipt = { requestId: id, state: "accepted" as const };
  const continuation = { continue: vi.fn(async () => receipt), status: vi.fn(async () => receipt) };
  const handler = createBeamV2Handler({
    ...store,
    currentAuthority: authority,
    controlUiBasePath: () => undefined,
    continuation,
  });
  await using server = http.createServer((req, res) => void handler(req, res));
  try {
    const origin = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    const v1 = sampleUpload();
    await store.upload(v1, {
      ...staffReceipt(Date.now()),
      publisher: { kind: "guest", profileId: person },
    });
    const caps = await (await fetch(origin + "/api/v2/beam/capabilities")).json();
    expect(caps.operations).toContain("continue");
    expect(caps.sendReceiptRetentionSeconds).toBe(604800);
    const target = origin + "/api/v2/beam/snapshots/" + v1.beamId + "/head";
    const head = await (await fetch(target)).json();
    const resource = new URL(head.apiUrl, target).href;
    const post = (body: unknown) =>
      fetch(resource + "/continue", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": id },
        body: JSON.stringify(body),
      });
    const body = {
      requestId: id,
      instruction: "continue from the reviewed packet",
      agent: "_team",
    };
    expect(
      (await post({ ...body, requestId: "12345678-1234-4123-abcd-000000000008" })).status,
    ).toBe(400);
    expect((await post({ ...body, instruction: "x".repeat(48 * 1024 + 1) })).status).toBe(400);
    expect((await post({ ...body, agent: "../other" })).status).toBe(400);
    const oversized = await post({ ...body, instruction: "x".repeat(BEAM_MAX_BODY_BYTES) });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      error: {
        code: "too_large",
        message: "The request body exceeds the size limit for this operation.",
      },
    });
    expect(continuation.continue).not.toHaveBeenCalled();
    expect(await (await post(body)).json()).toEqual(receipt);
    expect(continuation.continue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ beamId: v1.beamId }),
      body,
      expect.objectContaining({ personProfileId: "visitor" }),
    );
    expect(refresh).toHaveBeenCalled();
    refresh.mockClear();
    for (const role of [["operator.sessions.write"], ["operator.read"]]) {
      scopes = role;
      expect(await (await fetch(resource + "/requests/" + id)).json()).toEqual(receipt);
    }
    expect(refresh).not.toHaveBeenCalled();
    scopes = ["operator.sessions.write"];
    person = "foreign";
    expect((await post(body)).status).toBe(404);
    expect((await fetch(resource + "/requests/" + id)).status).toBe(404);
    expect(continuation.status).toHaveBeenCalledTimes(2);
    expect(continuation.continue).toHaveBeenCalledTimes(1);
  } finally {
    await close();
  }
});

it("publishes one reviewed PNG for a shared reader, preserves packet bytes and checks access on the next read", async () => {
  const { store, close } = await persistentBeamTestStore();
  let actor = beamTestAuthority({ personProfileId: "alice", scopes: ["operator.write"] });
  const handler = createBeamV2Handler({
    ...store,
    currentAuthority: () => actor,
    controlUiBasePath: () => undefined,
  });
  await using server = http.createServer((req, res) => void handler(req, res));
  try {
    const origin = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    const upload = sampleUpload();
    const packet = JSON.stringify({ ...upload, version: 2 });
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGNQCGiAIwZkDgBemgeBLDSLhAAAAABJRU5ErkJggg==";
    const target = origin + "/api/v2/beam/snapshots/" + upload.beamId;
    const put = (name: string, key: string, revision?: string) =>
      fetch(target, {
        method: "PUT",
        headers: {
          "content-type": "application/vnd.openclaw.beam.screenshot+json",
          "idempotency-key": key,
          ...(revision ? { "if-match": revision } : { "if-none-match": "*" }),
        },
        body: JSON.stringify({ packet, name, png }),
      });
    const id = "12345678-1234-4123-abcd-000000000007";
    const response = await put("review.png", id);
    expect(response.status, await response.clone().text()).toBe(200);
    const publication = await response.json();
    expect(await (await put("review.png", id)).json()).toEqual(publication);
    expect((await put("renamed.png", id)).status).toBe(409);
    const renamed = await (
      await put("renamed.png", "12345678-1234-4123-abcd-000000000008", publication.revision)
    ).json();
    expect(renamed.presentationDigest).not.toBe(publication.presentationDigest);
    expect(renamed.digest).toBe(publication.digest);
    const resource = new URL(renamed.apiUrl, target).href;
    const catalog = createBeamSessionCatalog(store);
    const request = { hostId: "gateway", threadId: upload.beamId };
    expect(await catalog.read(request)).not.toHaveProperty("previewImage");
    expect((await catalog.read({ ...request, includePreviewImage: true })).previewImage).toEqual({
      mimeType: "image/png",
      name: "renamed.png",
      data: png,
      digest: renamed.presentationDigest,
    });
    actor = beamTestAuthority({ personProfileId: "bob", scopes: ["operator.read"] });
    expect(await (await fetch(resource + "/snapshot")).text()).toBe(packet);
    const image = await fetch(resource + "/image");
    expect(image.status).toBe(200);
    expect(image.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await image.arrayBuffer()).toString("base64")).toBe(png);
    actor = beamTestAuthority({ personProfileId: "bob", scopes: [] });
    expect((await fetch(resource + "/image")).status).toBe(404);
    actor = beamTestAuthority({
      personProfileId: "charlie",
      scopes: ["operator.sessions.write"],
      requiredGrantPluginId: "visitor-access",
    });
    expect((await fetch(resource + "/image")).status).toBe(404);
    actor = beamTestAuthority({ personProfileId: "alice", scopes: ["operator.write"] });
    const removed = await fetch(target, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "if-match": renamed.revision,
        "idempotency-key": "12345678-1234-4123-abcd-000000000009",
      },
      body: packet,
    });
    expect(removed.status).toBe(200);
    const plain = await removed.json();
    expect(plain.digest).toBe(renamed.digest);
    expect(plain).not.toHaveProperty("presentationDigest");
    expect(plain.revision).not.toBe(renamed.revision);
    expect((await fetch(resource + "/image")).status).toBe(404);
    expect(await store.getScreenshot?.(upload.beamId, renamed.presentationDigest)).toBeUndefined();
    const restored = await put(
      "renamed.png",
      "12345678-1234-4123-abcd-000000000010",
      plain.revision,
    );
    expect(restored.status).toBe(200);
    expect(await store.delete(upload.beamId)).toBe(true);
    expect(await store.getScreenshot?.(upload.beamId, renamed.presentationDigest)).toBeUndefined();
    actor = beamTestAuthority({ personProfileId: "alice", scopes: ["operator.read"] });
    expect((await fetch(resource + "/image")).status).toBe(404);
  } finally {
    await close();
  }
});
