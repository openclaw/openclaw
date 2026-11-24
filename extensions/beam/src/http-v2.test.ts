import { createHash } from "node:crypto";
import http from "node:http";
import { expect, it } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { sampleUpload, staffReceipt } from "./beam-store.test-support.js";
import { persistentBeamTestStore } from "./beam.test-support.js";
import { createBeamV2Handler } from "./http-v2.js";

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
