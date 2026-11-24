import { createHash } from "node:crypto";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  beamMirrorTestFixture,
  beamTestMirrorConfig,
  beamTestNow,
  createBeamTestRuntime,
} from "./beam.test-support.js";
import * as cleaner from "./cleaner.js";
import {
  openBeamMirrorEnrollment,
  type MirrorPublicationStoreValue,
} from "./mirror-publication.js";
import * as transport from "./mirror-v2.js";

vi.mock("./mirror-v2.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mirror-v2.js")>()),
  enrollBeamMirrorV2: vi.fn(),
  requireBeamMirrorPublisher: vi.fn(),
  inspectBeamMirrorV2Enrollment: vi.fn(),
  publishBeamMirrorV2: vi.fn(),
}));
const source = {
  catalogId: "example",
  hostId: "gateway",
  threadId: "thread",
  agentId: "main",
  sourceHomeId: "home",
};
const raw = Buffer.from("synthetic reviewed packet"),
  id = "a".repeat(32);
const digest = (body: Buffer) => "sha256:" + createHash("sha256").update(body).digest("hex");
const head = { publicationId: "publication-1", revision: '"revision-1"', sha256: digest(raw) };
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
const open = (
  explicit = false,
  token = "publisher-test",
  endpoint = "https://team.example/api/v2/beam",
  assertCurrent: () => void = () => {},
  confirmGeneration?: string,
) =>
  openBeamMirrorEnrollment({
    source,
    confirmGeneration,
    token,
    endpoint,
    signal: new AbortController().signal,
    assertCurrent,
    explicit,
    store: createPluginStateKeyedStoreV2ForTests<MirrorPublicationStoreValue>(
      "beam",
      { namespace: "mirror-publications", retention: "retained", env: state.env },
      { assertCurrent },
    ),
  });
beforeEach(async () => {
  vi.clearAllMocks();
  resetPluginStateStoreForTests();
  state = await createOpenClawTestState({ label: "beam-mirror-enrollment" });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  await state.cleanup();
});

it("reuses only the settled receiver receipt after freshly reading an enrolled source", async () => {
  const endpoint = "https://team.example/api/v2/beam";
  const catalog = {
    id: source.catalogId,
    hostId: source.hostId,
    sessions: [{ ...source, recencyAt: beamTestNow }],
  };
  const fixture = beamMirrorTestFixture();
  const getStore = (authority: { assertCurrent(): void }) =>
    createPluginStateKeyedStoreV2ForTests<MirrorPublicationStoreValue>(
      "beam",
      { namespace: "mirror-publications", retention: "retained", env: state.env },
      authority,
    );
  const runtime = createBeamTestRuntime(
    beamTestMirrorConfig({ endpoint, catalogs: [source.catalogId], token: "publisher-test" }),
  );
  const read = vi.fn();
  const runner = fixture.runner(
    { ...catalog, onRead: read },
    { runtime, getPublicationStore: getStore },
  );
  vi.mocked(transport.enrollBeamMirrorV2).mockImplementationOnce(async (request) => ({
    state: "published",
    head: { ...head, sha256: digest(Buffer.from(request.raw)) },
  }));
  const authority = { async revalidate() {}, assertCurrent() {} };
  const enrolled = await runner.enroll(source, authority);
  expect(enrolled.state).toBe("published");
  await runner.tick();
  await runner.tick();
  expect(read).toHaveBeenCalledTimes(3);
  expect(cleaner.cleanBeamCandidate).toHaveBeenCalledTimes(2);
  expect(transport.publishBeamMirrorV2).not.toHaveBeenCalled();

  // The durable receipt can change in another writer while this poll's read is outstanding.
  const other = (await open())!;
  vi.mocked(transport.publishBeamMirrorV2)
    .mockRejectedValueOnce(new Error("lost acknowledgement"))
    .mockResolvedValueOnce({ state: "released" });
  read.mockImplementationOnce(async () => {
    await expect(other.publish(id, Buffer.from("pending edit"))).rejects.toThrow(
      "lost acknowledgement",
    );
  });
  await runner.tick();
  expect(cleaner.cleanBeamCandidate).toHaveBeenCalledTimes(3);
  const [first, replay] = vi.mocked(transport.publishBeamMirrorV2).mock.calls;
  expect(replay?.[0].intent).toEqual(first?.[0].intent);
  expect((await open())?.fenced).toBe("released");
  await runner.tick();
  expect(cleaner.cleanBeamCandidate).toHaveBeenCalledTimes(3);
});

it("requires a positive operator enrollment and keeps a released generation fenced on reopen", async () => {
  expect(await open()).toBeUndefined();
  vi.mocked(transport.enrollBeamMirrorV2).mockResolvedValueOnce({ state: "published", head });
  const explicit = (await open(true))!;
  await expect(explicit.enroll(id, raw)).resolves.toMatchObject({ state: "published", head });
  const later = (await open())!;
  expect(later.sourceSalt).toBe(explicit.sourceSalt);
  vi.mocked(transport.publishBeamMirrorV2).mockResolvedValueOnce({ state: "released" });
  await expect(later.publish(id, Buffer.from("new bytes"))).resolves.toBe("retired");
  expect((await open(true))?.fenced).toBe("released");
  expect(transport.enrollBeamMirrorV2).toHaveBeenCalledOnce();
  await expect(open(false, "different-publisher")).rejects.toThrow("credential");
  expect(await open(false, "publisher-test", "https://other.example/api/v2/beam")).toBeUndefined();
});

it("keeps first-create uncertainty operator-owned and binds only a consciously selected receiver generation", async () => {
  vi.mocked(transport.enrollBeamMirrorV2).mockRejectedValueOnce(new Error("connection lost"));
  await expect((await open(true))!.enroll(id, raw)).rejects.toThrow("connection lost");
  expect((await open())?.active).toBe(false);
  await expect((await open())!.publish(id, raw)).resolves.toBe(false);
  await expect((await open(true))!.enroll(id, raw)).resolves.toMatchObject({
    state: "unconfirmed",
    beamId: id,
  });
  vi.mocked(transport.inspectBeamMirrorV2Enrollment).mockResolvedValue({ state: "observed", head });
  await expect((await open(true))!.enroll(id, raw, "wrong-generation")).rejects.toThrow(
    "could not be confirmed",
  );
  expect((await open())?.active).toBe(false);
  await expect((await open(true))!.enroll(id, raw, head.publicationId)).resolves.toMatchObject({
    state: "published",
    head,
  });
  expect(transport.enrollBeamMirrorV2).toHaveBeenCalledOnce();
});

it("replays the exact pending bytes and precondition after restart before accepting a newer candidate", async () => {
  vi.mocked(transport.enrollBeamMirrorV2).mockResolvedValueOnce({ state: "published", head });
  await (await open(true))!.enroll(id, raw);
  const first = Buffer.from("edit one"),
    later = Buffer.from("edit two");
  vi.mocked(transport.publishBeamMirrorV2)
    .mockRejectedValueOnce(new Error("lost acknowledgement"))
    .mockResolvedValueOnce({
      state: "published",
      head: { ...head, revision: '"revision-2"', sha256: digest(first) },
    });
  await expect((await open())!.publish(id, first)).rejects.toThrow("lost acknowledgement");
  await expect((await open())!.publish(id, later)).resolves.toBe(false);
  const [attempt, replay] = vi.mocked(transport.publishBeamMirrorV2).mock.calls;
  expect(replay?.[0].intent).toEqual(attempt?.[0].intent);
  expect(replay?.[0].raw).toEqual(first);
  expect(transport.enrollBeamMirrorV2).toHaveBeenCalledOnce();
});

it("leaves an unacknowledged enrollment inactive when its operator loses authority during the request", async () => {
  let active = true;
  const binding = await open(true, undefined, undefined, () => {
    if (!active) {
      throw new Error("operator disconnected");
    }
  });
  vi.mocked(transport.enrollBeamMirrorV2).mockImplementationOnce(async () => {
    active = false;
    return { state: "published", head };
  });
  await expect(binding!.enroll(id, raw)).rejects.toThrow("operator disconnected");
  expect((await open())?.active).toBe(false);
  await expect((await open(true))!.enroll(id, raw)).resolves.toMatchObject({
    state: "unconfirmed",
  });
  expect(transport.enrollBeamMirrorV2).toHaveBeenCalledOnce();
});

it("rotates a publisher credential only after read-only confirmation of the same source generation", async () => {
  vi.mocked(transport.enrollBeamMirrorV2).mockResolvedValueOnce({ state: "published", head });
  await (await open(true))!.enroll(id, raw);
  const old = (await open())!;
  const rotated = (endpoint?: string, generation = head.publicationId) =>
    open(true, "new-credential", endpoint, undefined, generation);
  await expect(open(false, "new-credential")).rejects.toThrow("credential");
  await expect(rotated("https://other.example/api/v2/beam")).rejects.toThrow("No enrollment");
  await expect(rotated(undefined, "other-generation")).rejects.toThrow("credential");
  expect(transport.inspectBeamMirrorV2Enrollment).not.toHaveBeenCalled();
  vi.mocked(transport.inspectBeamMirrorV2Enrollment).mockResolvedValueOnce({ state: "conflict" });
  await expect(rotated()).rejects.toThrow("publisher authority");
  vi.mocked(transport.inspectBeamMirrorV2Enrollment).mockResolvedValueOnce({ state: "released" });
  await expect(rotated()).rejects.toThrow("publisher authority");
  vi.mocked(transport.inspectBeamMirrorV2Enrollment).mockResolvedValueOnce({
    state: "observed",
    head,
  });
  expect((await rotated())!.describe()).toMatchObject({ state: "published", head });
  expect((await open(false, "new-credential"))!.sourceSalt).toBe(old.sourceSalt);
  await expect(old.publish(id, Buffer.from("stale caller"))).resolves.toBe(false);
  await expect(open()).rejects.toThrow("credential");
  expect(transport.enrollBeamMirrorV2).toHaveBeenCalledOnce();
  expect(transport.publishBeamMirrorV2).not.toHaveBeenCalled();
});

it("checks receiver release authority before reserving the first local enrollment", async () => {
  vi.mocked(transport.requireBeamMirrorPublisher).mockRejectedValueOnce(
    new Error("verified publisher required"),
  );
  await expect(open(true)).rejects.toThrow("verified publisher required");
  await expect(open(false)).resolves.toBeUndefined();
  expect(transport.enrollBeamMirrorV2).not.toHaveBeenCalled();
  const reserved = await open(true, "verified-publisher");
  const next = await open(true, "rotated-before-first-write");
  expect(next?.sourceSalt).toBe(reserved?.sourceSalt);
  await expect(open(false, "verified-publisher")).rejects.toThrow("credential");
  expect(transport.enrollBeamMirrorV2).not.toHaveBeenCalled();
});
