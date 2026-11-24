import { createHash } from "node:crypto";
import { buffer } from "node:stream/consumers";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  beamMirrorTestFixture,
  beamTestMirrorConfig,
  beamTestNow,
  createBeamTestRuntime,
  createBeamTestCatalog,
  createBeamTestRunner,
} from "./beam.test-support.js";
import * as cleaner from "./cleaner.js";
import {
  openBeamMirrorEnrollment,
  beamMirrorEnrollmentKey,
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
const testEndpoint = "https://team.example/api/v2/beam";
const testAuthority = { assertCurrent() {}, async revalidate() {} };
const raw = Buffer.from("synthetic reviewed packet"),
  id = "a".repeat(32);
const digest = (body: Buffer) => "sha256:" + createHash("sha256").update(body).digest("hex");
const head = { publicationId: "publication-1", revision: '"revision-1"', sha256: digest(raw) };
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
const scheduleStore = (authority: { assertCurrent(): void }) =>
  createPluginStateKeyedStoreV2ForTests<string>(
    "beam",
    { namespace: "mirror-schedule", maxEntries: 1024, env: state.env },
    authority,
  );
const publicationStore = (authority: { assertCurrent(): void }) =>
  createPluginStateKeyedStoreV2ForTests<MirrorPublicationStoreValue>(
    "beam",
    { namespace: "mirror-publications", retention: "retained", env: state.env },
    authority,
  );
const runnerStores = { getPublicationStore: publicationStore, getScheduleStore: scheduleStore };
const mirrorRuntime = (url = testEndpoint, token?: string) =>
  createBeamTestRuntime(
    beamTestMirrorConfig({ endpoint: url, catalogs: [source.catalogId], token }),
  );
type TestCatalog = ReturnType<typeof createBeamTestCatalog>;

function pagingCatalog(
  native: TestCatalog,
  onList: (exact: boolean, offset: number) => void,
): TestCatalog {
  let granted = new Set<string>();
  return {
    ...native,
    async list(request) {
      const host = (await native.list(request))[0]!;
      const offset = request.source ? 0 : Number(request.cursors?.[source.hostId] ?? 0);
      const limit = request.limitPerHost ?? 100;
      onList(Boolean(request.source), offset);
      const sessions = host.sessions.slice(offset, offset + limit);
      granted = new Set(sessions.map((row) => row.threadId));
      return [
        {
          ...host,
          sessions,
          nextCursor: offset + limit < host.sessions.length ? String(offset + limit) : undefined,
        },
      ];
    },
    assertCurrent(locator) {
      if (!granted.has(locator.threadId)) {
        throw new Error("source grant superseded");
      }
    },
    async read(request) {
      this.assertCurrent(request);
      return native.read(request);
    },
  };
}

function acknowledgeEnrollment() {
  vi.mocked(transport.enrollBeamMirrorV2).mockImplementationOnce(async ({ raw: packet }) => ({
    state: "published",
    head: { ...head, sha256: digest(Buffer.from(packet)) },
  }));
}

const open = (
  explicit = false,
  token = "publisher-test",
  endpoint = testEndpoint,
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
    store: publicationStore({ assertCurrent }),
  });
beforeEach(async () => {
  vi.resetAllMocks();
  resetPluginStateStoreForTests();
  state = await createOpenClawTestState({ label: "beam-mirror-enrollment" });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  await state.cleanup();
});

it("reuses only the settled receiver receipt after freshly reading an enrolled source", async () => {
  const catalog = {
    id: source.catalogId,
    hostId: source.hostId,
    sessions: [{ ...source, recencyAt: beamTestNow }],
  };
  const fixture = beamMirrorTestFixture();
  const runtime = mirrorRuntime(testEndpoint, "publisher-test");
  const read = vi.fn();
  const runner = fixture.runner({ ...catalog, onRead: read }, { runtime, ...runnerStores });
  acknowledgeEnrollment();
  const selected = { ...source, title: "private display title", modelProvider: "private provider" };
  const enrolled = await runner.enroll(selected, testAuthority);
  expect(enrolled.state).toBe("published");
  expect(
    (await publicationStore(testAuthority).lookup(beamMirrorEnrollmentKey(testEndpoint, source)))
      ?.source,
  ).toEqual(source);
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
  expect(cleaner.cleanBeamCandidate).toHaveBeenCalledTimes(2);
  const [first, replay] = vi.mocked(transport.publishBeamMirrorV2).mock.calls;
  expect(replay?.[0].intent).toEqual(first?.[0].intent);
  expect((await open())?.fenced).toBe("released");
  await runner.tick();
  expect(cleaner.cleanBeamCandidate).toHaveBeenCalledTimes(2);
});

it("replays a frozen update after an authorized read even when a newer candidate cannot be cleaned", async () => {
  const runtime = mirrorRuntime(testEndpoint, "publisher-test");
  const native = createBeamTestCatalog({
    id: source.catalogId,
    hostId: source.hostId,
    sessions: [{ ...source, recencyAt: beamTestNow }],
  });
  const grant = vi.fn();
  let sourceState: "first" | "lost" | "invalid" | "hidden" = "first";
  const catalog: typeof native = {
    ...native,
    list: async (request) => (sourceState === "hidden" ? [] : native.list(request)),
    read: async (request) => {
      grant();
      const page = await native.read(request);
      return {
        ...page,
        items: [{ type: "agentMessage", text: sourceState }],
      };
    },
  };
  const runner = createBeamTestRunner({
    runtime,
    listCatalogs: () => [catalog],
    ...runnerStores,
  });
  const mock = vi.mocked(cleaner.cleanBeamCandidate);
  const clean = mock.getMockImplementation()!;
  mock.mockImplementation((input, ...args) => {
    if (
      (JSON.parse(input) as cleaner.BeamCleanCandidate).items.some(
        (item) => item.text === "invalid",
      )
    ) {
      throw new Error("synthetic failure cleaning a newer turn");
    }
    return clean(input, ...args);
  });
  acknowledgeEnrollment();
  await runner.enroll(source, testAuthority);
  vi.mocked(transport.publishBeamMirrorV2)
    .mockRejectedValueOnce(new Error("lost acknowledgement"))
    .mockImplementationOnce(async (p) => ({
      state: "published",
      head: { ...head, revision: '"replayed"', sha256: digest(Buffer.from(p.raw)) },
    }));
  sourceState = "lost";
  await runner.tick();
  sourceState = "hidden";
  await runner.tick();
  expect(grant).toHaveBeenCalledTimes(2);
  expect(transport.publishBeamMirrorV2).toHaveBeenCalledOnce();
  sourceState = "invalid";
  await runner.tick();
  expect(grant).toHaveBeenCalledTimes(3);
  const [original, replay] = vi.mocked(transport.publishBeamMirrorV2).mock.calls;
  expect(replay?.[0].raw).toEqual(original![0].raw);
  expect(replay?.[0].intent).toEqual(original![0].intent);
  await runner.tick();
  expect(transport.publishBeamMirrorV2).toHaveBeenCalledTimes(2);
  expect(JSON.parse(mock.mock.lastCall![0]).items[0]).toMatchObject({
    type: "agentMessage",
    text: "invalid",
  });
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

it.each([33, 101])(
  "delivers current and pre-locator enrollment at rank %i after a cold start",
  async (rank) => {
    const runtime = mirrorRuntime(testEndpoint, "publisher-test");
    const read = vi.fn();
    let title = "first",
      recencyAt = beamTestNow;
    const prior = Array.from({ length: rank - 1 }, (_, i) => ({
      threadId: `other-${i}`,
      sourceHomeId: "other-home",
      recencyAt: beamTestNow + 1,
    }));
    const native = createBeamTestCatalog({
      id: source.catalogId,
      hostId: source.hostId,
      onRead: read,
      sessions: () => [...prior, { ...source, name: title, recencyAt }],
    });
    const pages: number[] = [];
    function create() {
      const catalog = pagingCatalog(native, (exact, offset) => {
        if (!exact) {
          pages.push(offset);
        }
      });
      return createBeamTestRunner({
        runtime,
        listCatalogs: () => [catalog],
        ...runnerStores,
      });
    }
    acknowledgeEnrollment();
    vi.mocked(transport.publishBeamMirrorV2).mockImplementation(async (p) => ({
      state: "published",
      head: { ...head, revision: '"updated"', sha256: digest(Buffer.from(p.raw)) },
    }));
    await create().enroll(source, testAuthority);
    title = "fresh edit";
    await create().tick();
    expect(transport.publishBeamMirrorV2).toHaveBeenCalledOnce();
    expect(pages).toEqual([]);

    // Simulate the released shape of a genuine unacknowledged update. Keep every
    // byte and precondition from its first attempt; only remove the added locator.
    title = "lost response";
    vi.mocked(transport.publishBeamMirrorV2).mockImplementationOnce(async () => {
      throw new Error("dropped response");
    });
    await create().tick();
    const store = publicationStore(testAuthority);
    const key = beamMirrorEnrollmentKey(testEndpoint, source);
    const retained = (await store.lookup(key))!;
    expect(retained.pending).toBeDefined();
    const { source: _source, ...old } = retained;
    await store.register(key, old);
    recencyAt -= 181 * 60_000;
    title = "later local edit";
    for (let i = 0; i < 4; i++) {
      await create().tick();
    }
    const [, lost, replay, terminal] = vi.mocked(transport.publishBeamMirrorV2).mock.calls;
    expect(replay?.[0].raw).toEqual(lost![0].raw);
    expect(replay?.[0].intent).toEqual(lost![0].intent);
    expect(JSON.parse(Buffer.from(terminal![0].raw).toString())).toMatchObject({
      completed: true,
      title,
    });
    expect(await store.lookup(key)).toMatchObject({ source, completed: true });
    expect(pages).toEqual(rank > 100 ? [0, 100] : [0]);
    expect(new Set(read.mock.calls.map(([threadId]) => threadId))).toEqual(
      new Set([source.threadId]),
    );
    const totalReads = read.mock.calls.length;
    await create().tick();
    expect(read).toHaveBeenCalledTimes(totalReads);
  },
);

it("rotates the 32 active slots across restarts without reading unrelated sources", async () => {
  vi.mocked(transport.enrollBeamMirrorV2).mockResolvedValueOnce({ state: "published", head });
  await (await open(true))!.enroll(id, raw);
  const store = publicationStore(testAuthority),
    original = (await store.lookup(beamMirrorEnrollmentKey(testEndpoint, source)))!;
  const sources = Array.from({ length: 68 }, (_, i) => ({
    ...source,
    threadId: i === 0 ? source.threadId : `selected-${i}`,
  }));
  for (const item of sources.slice(1)) {
    await store.register(beamMirrorEnrollmentKey(testEndpoint, item), {
      ...original,
      source: item,
    });
  }
  vi.mocked(transport.publishBeamMirrorV2).mockRejectedValue(new Error("offline"));
  const fixture = beamMirrorTestFixture();
  const read = vi.fn();
  const runtime = mirrorRuntime(testEndpoint, "publisher-test");
  for (const count of [32, 32, 4]) {
    const before = read.mock.calls.length;
    await fixture
      .runner(
        {
          id: source.catalogId,
          hostId: source.hostId,
          sessions: sources.map(({ threadId, sourceHomeId }) => ({
            threadId,
            sourceHomeId,
            recencyAt: beamTestNow,
          })),
          onRead: read,
        },
        { runtime, ...runnerStores },
      )
      .tick();
    expect(read.mock.calls.length - before).toBe(count);
  }
  expect(new Set(read.mock.calls.map(([threadId]) => threadId))).toEqual(
    new Set(sources.map((s) => s.threadId)),
  );
});

it.runIf(process.env.BEAM_TEST_CLEANER_PLUGIN_ROOT).each([
  [1, 1],
  [32, 0],
  [32, 1],
] as const)(
  "bounds real cleaning and PUTs for %i enrolled sources with %i beyond the first page",
  async (count, beyondPage) => {
    const actual = await vi.importActual<typeof transport>("./mirror-v2.js");
    vi.mocked(transport.enrollBeamMirrorV2).mockImplementation(actual.enrollBeamMirrorV2);
    vi.mocked(transport.requireBeamMirrorPublisher).mockImplementation(
      actual.requireBeamMirrorPublisher,
    );
    vi.mocked(transport.publishBeamMirrorV2).mockImplementation(actual.publishBeamMirrorV2);
    const { createBeamExecutableResolver } = await import("./executable.js");
    const resolveExecutable = vi.fn(
      createBeamExecutableResolver(process.env.BEAM_TEST_CLEANER_PLUGIN_ROOT!),
    );
    const inputs = Array.from({ length: 120 }, (_, i) => ({ ...source, threadId: `t${i}` }));
    const selected = [
      ...inputs.slice(0, count - beyondPage),
      ...inputs.slice(100, 100 + beyondPage),
    ];
    const measures = { lists: 0, exact: 0, reads: 0, heads: 0, puts: 0 };
    const receipts = new Map<string, object>();
    await withServer(
      (req, res) => {
        const beamId = req.url?.split("/").at(-1) ?? "";
        if (beamId === "capabilities") {
          res.end(JSON.stringify({ protocol: 2, operations: ["publish", "release"] }));
        } else if (req.method === "PUT") {
          measures.puts++;
          void buffer(req).then(
            (body) => {
              const receipt = {
                beamId,
                publicationId: `gen.${beamId}`,
                revision: '"' + digest(body).slice(7) + '"',
                digest: digest(body),
                state: "writable",
                disposition: "applied",
                canRelease: true,
              };
              receipts.set(beamId, receipt);
              res.end(JSON.stringify(receipt));
            },
            () => res.destroy(),
          );
        } else {
          measures.heads++;
          res.end(JSON.stringify(receipts.get(req.url?.split("/").at(-2) ?? "")));
        }
      },
      async (origin) => {
        let title = "initial";
        const native = createBeamTestCatalog({
          id: source.catalogId,
          hostId: source.hostId,
          sessions: () =>
            inputs.map(({ threadId, sourceHomeId }) => ({
              threadId,
              sourceHomeId,
              name: title,
              recencyAt: beamTestNow,
            })),
          onRead: () => {
            measures.reads++;
          },
        });
        const catalog = pagingCatalog(native, (exact) => {
          measures[exact ? "exact" : "lists"]++;
        });
        const runner = createBeamTestRunner({
          runtime: mirrorRuntime(origin + "/api/v2/beam"),
          listCatalogs: () => [catalog],
          resolveExecutable,
          ...runnerStores,
        });
        for (const item of selected) {
          await runner.enroll(item, testAuthority);
        }
        const tick = async () => {
          for (const key of ["lists", "exact", "reads", "heads", "puts"] as const) {
            measures[key] = 0;
          }
          resolveExecutable.mockClear();
          await runner.tick();
          return { ...measures, cleaners: resolveExecutable.mock.calls.length };
        };
        const reads = { lists: count === 1 ? 0 : 1, exact: beyondPage, reads: count };
        expect(await tick()).toEqual({ ...reads, cleaners: count, heads: 0, puts: 0 });
        expect(await tick()).toEqual({ ...reads, cleaners: 0, heads: 0, puts: 0 });
        title = "edited at the same timestamp";
        expect(await tick()).toEqual({ ...reads, cleaners: count, heads: count, puts: count });
      },
    );
  },
  45_000,
);

it("restarts an expired legacy host cursor while a sibling remains healthy", async () => {
  vi.mocked(transport.enrollBeamMirrorV2).mockResolvedValueOnce({ state: "published", head });
  await (await open(true))!.enroll(id, raw);
  const store = publicationStore(testAuthority),
    key = beamMirrorEnrollmentKey(testEndpoint, source);
  const { source: _source, ...legacy } = (await store.lookup(key))!;
  await store.register(key, legacy);
  const fixture = beamMirrorTestFixture();
  const native = createBeamTestCatalog({
    id: source.catalogId,
    hostId: source.hostId,
    sessions: [{ ...source, recencyAt: beamTestNow }],
  });
  const cursors: Array<string | undefined> = [];
  let expired = false;
  const catalog: typeof native = {
    ...native,
    async list(request) {
      const host = (await native.list(request))[0]!;
      if (request.source) {
        return [host];
      }
      const cursor = request.cursors?.[source.hostId];
      cursors.push(cursor);
      const sibling = { ...host, hostId: "z", sessions: [] };
      if (cursor === "expired") {
        expired = true;
        return [sibling];
      }
      return [
        {
          ...host,
          sessions: cursor === "fresh" ? host.sessions : [],
          nextCursor: cursor === "fresh" ? undefined : expired ? "fresh" : "expired",
        },
        sibling,
      ];
    },
  };
  const runtime = mirrorRuntime(testEndpoint, "publisher-test");
  for (let i = 0; i < 8 && !(await store.lookup(key))?.source; i++) {
    await fixture
      .runner(
        {},
        {
          runtime,
          listCatalogs: () => [catalog],
          ...runnerStores,
        },
      )
      .tick();
  }
  expect((await store.lookup(key))?.source).toEqual(source);
  expect(cursors.filter((s) => s === "expired")).toHaveLength(1);
  expect(cursors).toContain("fresh");
});
