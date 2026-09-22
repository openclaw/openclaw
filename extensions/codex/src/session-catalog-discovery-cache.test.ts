import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import {
  commandRpcMocks,
  config,
  createCodexSessionCatalogControlFactory,
  createCodexSessionCatalogControl,
  createCodexTestBindingStore,
  createGatewayApi,
  createRuntime,
  idleThread,
  registerCodexSessionCatalog,
} from "./session-catalog.test-helpers.js";

describe("Codex catalog discovery cache", () => {
  it.each(["pending", "settled"])(
    "favors a discovery page after a head reader joins it (%s)",
    async (state) => {
      const held = createDeferred<unknown>();
      const started = createDeferred<void>();
      const response = { data: [idleThread({ id: "retained", source: "cli" })] };
      commandRpcMocks.codexControlRequest.mockImplementation(
        (_config: unknown, _method: string, request: { cursor?: string }) => {
          if (request.cursor === "shared") {
            started.resolve();
            return held.promise;
          }
          return { data: [] };
        },
      );
      const control = createCodexSessionCatalogControl({
        getPluginConfig: () => ({ supervision: { enabled: true } }),
        getRuntimeConfig: () => config,
        now: () => 1_000,
      });
      const query = { cursor: "shared", limit: 1 };
      const first = control.listPage(query);
      const pending = [first];
      try {
        await started.promise;
        if (state === "settled") {
          held.resolve(response);
          await first;
        }
        pending.push(control.listPage(query, undefined, { headWalk: true }));
        held.resolve(response);
        const pages = await Promise.all(pending);
        expect(pages[0]).toEqual(pages[1]);
        for (let index = 0; index < 64; index++) {
          await control.listPage({ cursor: `discovery-${index}`, limit: 1 });
        }
        const before = commandRpcMocks.codexControlRequest.mock.calls.length;
        await expect(control.listPage(query, undefined, { headWalk: true })).resolves.toEqual(
          pages[0],
        );
        expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(before);
      } finally {
        held.resolve(response);
        await Promise.allSettled(pending);
      }
    },
  );

  it("reuses the recent exclusion walk while discovery visits older pages", async () => {
    commandRpcMocks.codexControlRequest.mockImplementation(
      async (
        _pluginConfig: unknown,
        _method: string,
        request: { cursor?: string; limit: number },
      ) => {
        const offset = Number(request.cursor ?? 0);
        return {
          data: Array.from({ length: request.limit }, (_, index) =>
            idleThread({
              id: `thread-${offset + index}`,
              source: "cli",
              originator: offset + index === 4300 ? "codex" : "openclaw",
              path: `/synthetic/sessions/thread-${offset + index}.jsonl`,
              recencyAt: 10_000 - offset - index,
              updatedAt: 10_000 - offset - index,
            }),
          ),
          nextCursor: String(offset + request.limit),
        };
      },
    );
    const factory = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => config,
      now: () => 1_000,
    });
    const primary = (await factory.homesForAgent("main"))[0]!;
    const home = { ...primary, localSessionsRoot: "/synthetic/sessions" };
    const { runtime } = createRuntime();
    const { api, getProvider } = createGatewayApi(runtime, config);
    registerCodexSessionCatalog({
      api,
      bindingStore: createCodexTestBindingStore(),
      control: { ...factory, homesForAgent: async () => [home] },
      getRuntimeConfig: () => config,
    });
    const provider = getProvider()!;
    const list = (cursor?: string) =>
      provider.list({
        agentId: "main",
        hostIds: [home.hostId],
        ...(cursor ? { cursors: { [home.hostId]: cursor } } : { limitPerHost: 40 }),
      });

    const first = await list();
    expect(first[0]).toMatchObject({ sessions: [], nextCursor: "800" });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(20);
    let cursor = first[0]!.nextCursor!;
    for (let sweep = 0; sweep < 3; sweep++) {
      const older = await list(cursor);
      expect(older[0]).toMatchObject({ sessions: [], nextCursor: String(1800 + sweep * 1000) });
      cursor = older[0]!.nextCursor!;
      const before = commandRpcMocks.codexControlRequest.mock.calls.length;
      const refreshed = await list();
      expect(refreshed).toEqual(first);
      expect(commandRpcMocks.codexControlRequest.mock.calls.length - before).toBe(0);
    }
    const discovered = await list(cursor);
    expect(discovered[0]?.sessions.map((session) => session.threadId)).toEqual(["thread-4300"]);
    expect(Number(discovered[0]?.nextCursor)).toBeGreaterThan(4300);
  });
});
