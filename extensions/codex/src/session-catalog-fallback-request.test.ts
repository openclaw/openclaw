import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeCatalogFixture } from "./session-catalog-resident.test-support.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";
import { CodexCatalogVisiblePage, listVisiblePage } from "./session-catalog-visible-page.js";
import {
  commandRpcMocks,
  config,
  createCodexSessionCatalogControlFactory,
  idleThread,
  pinnedConnectionMocks,
} from "./session-catalog.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function saturatedHome() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const native = nativeCatalogFixture(20_001);
  for (const [index, row] of native.rows.entries()) {
    row.name = `Other investigation ${index}`;
    row.updatedAt = 1_700_000_000 - index;
    row.recencyAt = row.updatedAt;
  }
  let now = 0;
  const factory = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({
      supervision: { enabled: true },
      appServer: {
        transport: "websocket",
        url: "wss://fallback.example.test/codex",
        authToken: "synthetic-fallback-token",
      },
    }),
    getRuntimeConfig: () => config,
    now: () => now,
  });
  const home = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", home);
  await control.initialize();
  expect(native.fetched.flat()).toHaveLength(20_001);
  commandRpcMocks.codexControlRequest.mockClear();
  return {
    control,
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

async function visibleSearch(
  mode: "inline" | "stepped",
  control: CodexSessionCatalogControl,
  excludedThreadIds: ReadonlySet<string>,
  cursor?: string,
) {
  const params = { control, limit: 1, searchTerm: "Wanted", excludedThreadIds, cursor };
  if (mode === "inline") {
    return await listVisiblePage(params);
  }
  const operation = new CodexCatalogVisiblePage(params);
  for (;;) {
    const step = await operation.next();
    if (step.done) {
      return step.page;
    }
    await nextTurn();
  }
}

describe("overflow catalog request budgets", () => {
  it.each(["inline", "stepped"] as const)(
    "shares 20 native reads across title search and %s exclusion filling",
    async (mode) => {
      const { control } = await saturatedHome();
      const positions: number[] = [];
      let visibleAt = 0;
      commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, method, params) => {
        expect(method).toBe("thread/list");
        expect(params.useStateDbOnly).toBe(true);
        const position = params.cursor
          ? Number(params.cursor.slice("native-after:".length)) + 1
          : 1;
        positions.push(position);
        const wanted = position % 20 === 0 || position === visibleAt;
        return {
          data: [
            idleThread({
              id: `fallback-${position}`,
              name: wanted ? "Wanted investigation" : "Other investigation",
              source: "cli",
              originator: "codex_cli_rs",
              preview: `Please inspect fallback task ${position} and verify the result.`,
            }),
          ],
          nextCursor: `native-after:${position}`,
        };
      });
      const excluded = new Set(
        Array.from({ length: 20 }, (_, index) => `fallback-${(index + 1) * 20}`),
      );

      const first = await visibleSearch(mode, control, excluded);

      expect(positions.length).toBeLessThanOrEqual(20);
      expect(first.sessions).toEqual([]);
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(first.nextCursor).not.toBe("native-after:20");
      expect(positions).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

      visibleAt = 21;
      const second = await visibleSearch(mode, control, excluded, first.nextCursor);

      expect(second.sessions.map((session) => session.threadId)).toEqual(["fallback-21"]);
      expect(positions).toEqual(Array.from({ length: 21 }, (_, index) => index + 1));
    },
  );

  it.each(["control", "visible"] as const)(
    "backs off the complete %s fallback request when a later native page fails",
    async (mode) => {
      const fixture = await saturatedHome();
      const failure = new Error("second fallback page failed");
      let recovered = false;
      commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, method, params) => {
        expect(method).toBe("thread/list");
        expect(params.useStateDbOnly).toBe(true);
        if (params.cursor === "page-two") {
          if (!recovered) {
            throw failure;
          }
          return { data: [idleThread({ id: "match", source: "cli", name: "Wanted" })] };
        }
        return {
          data: [
            idleThread({
              id: "head",
              source: "cli",
              name: mode === "visible" ? "Wanted" : "Other",
            }),
          ],
          nextCursor: "page-two",
        };
      });
      const search = () =>
        mode === "control"
          ? fixture.control.listPage({ limit: 1, searchTerm: "Wanted" })
          : listVisiblePage({
              control: fixture.control,
              limit: 1,
              searchTerm: "Wanted",
              excludedThreadIds: new Set(["head"]),
            });

      await expect(search()).rejects.toBe(failure);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
      await expect(search()).rejects.toBe(failure);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(4);
      await expect(search()).rejects.toBe(failure);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(4);

      fixture.advance(5_000);
      await expect(search()).rejects.toBe(failure);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(6);
      fixture.advance(9_999);
      await expect(search()).rejects.toBe(failure);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(6);

      fixture.advance(1);
      recovered = true;
      expect((await search()).sessions.map((session) => session.threadId)).toEqual(["match"]);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(8);
    },
  );
});

it.each(["read count", "deadline"] as const)(
  "shares the fallback %s with nested eligibility, metadata, and descendant reads",
  async (bound) => {
    const fixture = await saturatedHome();
    if (bound === "deadline") {
      vi.spyOn(performance, "now").mockImplementation(fixture.now);
    }
    let reads = 0;
    let completedCallbacks = 0;
    let latestThreadId = "";
    const thread = (id: string) =>
      idleThread({ id, source: "cli", originator: "codex_cli_rs", name: "Wanted" });
    const dispatch = async (
      method: string,
      params: {
        cursor?: string | null;
        threadId?: string;
        ancestorThreadId?: string | null;
        useStateDbOnly?: boolean;
      },
    ) => {
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
      if (params.ancestorThreadId) {
        return { data: [] };
      }
      if (!params.useStateDbOnly) {
        return { data: [thread(latestThreadId)] };
      }
      const position = Number(params.cursor ?? 0) + 1;
      return { data: [thread(`excluded-${position}`)], nextCursor: String(position) };
    };
    commandRpcMocks.codexControlRequest.mockImplementation((_plugin, method, params) =>
      dispatch(method, params),
    );
    pinnedConnectionMocks.request.mockImplementation(({ method, requestParams }) =>
      dispatch(method, requestParams),
    );

    const [result] = await Promise.allSettled([
      listVisiblePage({
        control: fixture.control,
        limit: 1,
        searchTerm: "Wanted",
        excludedThreadIds: new Set(
          Array.from({ length: 20 }, (_, index) => `excluded-${index + 1}`),
        ),
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
        expect(result.value.sessions).toEqual([]);
        expect(result.value.nextCursor).toEqual(expect.any(String));
      } else {
        expect(result.reason).toBeInstanceOf(Error);
      }
    }
  },
);

it("releases an abandoned exclusion-fill probe for the next catalog request", async () => {
  const fixture = await saturatedHome();
  const failure = new Error("second fallback page failed");
  let recovered = false;
  commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, method, params) => {
    expect(method).toBe("thread/list");
    if (params.cursor === "page-two") {
      if (!recovered) {
        throw failure;
      }
      return { data: [idleThread({ id: "visible", name: "Wanted", source: "cli" })] };
    }
    return {
      data: [idleThread({ id: "excluded", name: "Wanted", source: "cli" })],
      nextCursor: "page-two",
    };
  });
  const params = {
    control: fixture.control,
    limit: 1,
    searchTerm: "Wanted",
    excludedThreadIds: new Set(["excluded"]),
  };
  await expect(listVisiblePage(params)).rejects.toBe(failure);
  await expect(listVisiblePage(params)).rejects.toBe(failure);
  expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(4);
  fixture.advance(5_000);

  const abandoned = new CodexCatalogVisiblePage(params);
  await expect(abandoned.next()).resolves.toEqual({ done: false });
  expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(5);
  abandoned.close();

  recovered = true;
  expect((await listVisiblePage(params)).sessions.map((session) => session.threadId)).toEqual([
    "visible",
  ]);
  expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(7);
});
