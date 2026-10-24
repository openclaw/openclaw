import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexThreadListParams } from "./app-server/protocol.js";
import {
  nativeCatalogFixture,
  remoteCatalogFactory,
} from "./session-catalog-resident.test-support.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";
import { CodexCatalogVisiblePage, listVisiblePage } from "./session-catalog-visible-page.js";
import {
  commandRpcMocks,
  config,
  idleThread,
  pinnedConnectionMocks,
} from "./session-catalog.test-helpers.js";

const nativeRequest = commandRpcMocks.codexControlRequest;
type NativeReadParams = CodexThreadListParams & { threadId?: string };
const expectCalls = (count: number) => expect(nativeRequest).toHaveBeenCalledTimes(count);
const sequence = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
const thread = (id: string, name = "Wanted") =>
  idleThread({ id, source: "cli", originator: "codex_cli_rs", name });
const searchParams = (
  control: CodexSessionCatalogControl,
  excludedThreadIds: ReadonlySet<string>,
) => ({ control, limit: 1, searchTerm: "Wanted", excludedThreadIds });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function saturatedHome() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const native = nativeCatalogFixture(20_001);
  for (const [index, row] of native.rows.entries()) {
    row.name = "Other";
    row.recencyAt = row.updatedAt = 1_700_000_000 - index;
  }
  let now = 0;
  const factory = remoteCatalogFactory("fallback", {
    getRuntimeConfig: () => config,
    now: () => now,
  });
  const home = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", home);
  await control.initialize();
  expect(native.fetched.flat()).toHaveLength(20_001);
  nativeRequest.mockClear();
  return {
    control,
    now: () => now,
    advance: (milliseconds: number) => (now += milliseconds),
  };
}

async function failingFallback() {
  const fixture = await saturatedHome();
  const failure = new Error("second fallback page failed");
  let recovered = false;
  nativeRequest.mockImplementation(async (_plugin, method, params) => {
    expect([method, params.useStateDbOnly]).toEqual(["thread/list", true]);
    if (params.cursor === "page-two" && !recovered) {
      throw failure;
    }
    return {
      data: [idleThread({ id: params.cursor ? "match" : "head", source: "cli", name: "Wanted" })],
      nextCursor: params.cursor ? undefined : "page-two",
    };
  });
  const params = searchParams(fixture.control, new Set(["head"]));
  const search = () => listVisiblePage(params);
  return {
    ...fixture,
    params,
    search,
    async expectFailure(calls: number, advance = 0) {
      fixture.advance(advance);
      await expect(search()).rejects.toBe(failure);
      expectCalls(calls);
    },
    recover: () => (recovered = true),
  };
}

async function visibleSearch(params: ConstructorParameters<typeof CodexCatalogVisiblePage>[0]) {
  const operation = new CodexCatalogVisiblePage(params);
  for (;;) {
    const step = await operation.next();
    if (step.done) {
      return step.page;
    }
    await nextTurn();
  }
}

it("shares 20 native reads across title search and stepped exclusion filling", async () => {
  const { control } = await saturatedHome();
  const positions: number[] = [];
  let visibleAt = 0;
  nativeRequest.mockImplementation(async (_plugin, method, params) => {
    expect([method, params.useStateDbOnly]).toEqual(["thread/list", true]);
    const position = params.cursor ? Number(params.cursor.slice("native-after:".length)) + 1 : 1;
    positions.push(position);
    const wanted = position % 20 === 0 || position === visibleAt;
    return {
      data: [
        thread(`fallback-${position}`, wanted ? "Wanted investigation" : "Other investigation"),
      ],
      nextCursor: `native-after:${position}`,
    };
  });
  const excluded = new Set(sequence(20).map((index) => `fallback-${index * 20}`));
  const params = searchParams(control, excluded);
  const first = await visibleSearch(params);

  expect(positions.length).toBeLessThanOrEqual(20);
  expect(first).toMatchObject({ sessions: [], nextCursor: expect.any(String) });
  expect(first.nextCursor).not.toBe("native-after:20");
  expect(positions).toEqual(sequence(20));

  visibleAt = 21;
  const second = await visibleSearch({ ...params, cursor: first.nextCursor });

  expect(second.sessions.map((session) => session.threadId)).toEqual(["fallback-21"]);
  expect(positions).toEqual(sequence(21));
});

it("backs off the complete visible fallback request when a later native page fails", async () => {
  const fixture = await failingFallback();
  await fixture.expectFailure(2);
  await fixture.expectFailure(4);
  await fixture.expectFailure(4);
  await fixture.expectFailure(6, 5_000);
  await fixture.expectFailure(6, 9_999);

  fixture.advance(1);
  fixture.recover();
  expect((await fixture.search()).sessions.map((session) => session.threadId)).toEqual(["match"]);
  expectCalls(8);
});

it.each(["read count", "deadline"] as const)("bounds nested reads by %s", async (bound) => {
  const fixture = await saturatedHome();
  if (bound === "deadline") {
    vi.spyOn(performance, "now").mockImplementation(fixture.now);
  }
  let reads = 0;
  let completedCallbacks = 0;
  let latestThreadId = "";
  const dispatch = async (method: string, params: NativeReadParams) => {
    reads++;
    if (bound === "deadline") {
      fixture.advance(20_000);
    }
    if (method === "thread/read") {
      if (!params.threadId) {
        throw new Error("Expected a thread identity for the metadata read");
      }
      latestThreadId = params.threadId;
      return { thread: thread(params.threadId) };
    }
    expect(method).toBe("thread/list");
    if (params.ancestorThreadId || !params.useStateDbOnly) {
      return { data: params.ancestorThreadId ? [] : [thread(latestThreadId)] };
    }
    const position = Number(params.cursor ?? 0) + 1;
    return { data: [thread(`excluded-${position}`)], nextCursor: String(position) };
  };
  nativeRequest.mockImplementation((_plugin, method, params) => dispatch(method, params));
  pinnedConnectionMocks.request.mockImplementation(({ method, requestParams }) =>
    dispatch(method, requestParams),
  );

  const [result] = await Promise.allSettled([
    listVisiblePage({
      ...searchParams(fixture.control, new Set(sequence(20).map((index) => `excluded-${index}`))),
      onExcludedThread: async ({ threadId }) => {
        await fixture.control.requireEligibleThread(threadId);
        await fixture.control.readThread(threadId);
        await fixture.control.listDescendantPage({ ancestorThreadId: threadId, limit: 64 });
        completedCallbacks++;
      },
    }),
  ]);

  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThanOrEqual(bound === "deadline" ? 3 : 20);
  if (bound === "deadline") {
    expect(result).toMatchObject({ status: "rejected", reason: expect.any(Error) });
    expect(completedCallbacks).toBe(0);
  } else {
    expect(completedCallbacks).toBeGreaterThan(0);
    if (result.status === "fulfilled") {
      expect(result.value).toMatchObject({ sessions: [], nextCursor: expect.any(String) });
    } else {
      expect(result.reason).toBeInstanceOf(Error);
    }
  }
});

it("releases an abandoned exclusion-fill probe for the next catalog request", async () => {
  const fixture = await failingFallback();
  const { search, params } = fixture;
  await fixture.expectFailure(2);
  await fixture.expectFailure(4);
  fixture.advance(5_000);

  const abandoned = new CodexCatalogVisiblePage(params);
  await expect(abandoned.next()).resolves.toEqual({ done: false });
  expectCalls(5);
  abandoned.close();

  fixture.recover();
  expect((await search()).sessions.map((session) => session.threadId)).toEqual(["match"]);
  expectCalls(7);
});
