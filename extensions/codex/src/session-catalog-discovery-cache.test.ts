import { describe, expect, it } from "vitest";
import {
  commandRpcMocks,
  config,
  createCodexSessionCatalogControlFactory,
  createCodexTestBindingStore,
  createGatewayApi,
  createRuntime,
  idleThread,
  registerCodexSessionCatalog,
} from "./session-catalog.test-helpers.js";

describe("resident Codex catalog discovery", () => {
  it("keeps recent results resident while discovering older entries beyond a large hidden prefix", async () => {
    const hiddenCount = 4_300;
    const visibleCount = 1_360;
    const total = hiddenCount + visibleCount;
    commandRpcMocks.codexControlRequest.mockImplementation(
      async (
        _pluginConfig: unknown,
        _method: string,
        request: { cursor?: string; limit: number },
      ) => {
        const offset = Number(request.cursor ?? 0);
        const count = Math.min(request.limit, total - offset);
        return {
          data: Array.from({ length: count }, (_, index) => {
            const position = offset + index;
            return idleThread({
              id: `thread-${position}`,
              source: "cli",
              originator: position >= hiddenCount ? "codex" : "openclaw",
              path: `/synthetic/sessions/thread-${position}.jsonl`,
              recencyAt: 10_000 - position,
              updatedAt: 10_000 - position,
            });
          }),
          ...(offset + count < total ? { nextCursor: String(offset + count) } : {}),
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
        limitPerHost: 40,
        ...(cursor ? { cursors: { [home.hostId]: cursor } } : {}),
      });

    await factory.forRequest("main", home).initialize();
    const nativeCalls = commandRpcMocks.codexControlRequest.mock.calls.length;
    expect(nativeCalls).toBeGreaterThan(1);
    const first = await list();
    expect(first[0]?.sessions).toHaveLength(40);
    const ids = first[0]!.sessions.map((session) => session.threadId);
    let cursor = first[0]!.nextCursor;
    expect(cursor).toBeDefined();
    while (cursor) {
      const older = await list(cursor);
      ids.push(...older[0]!.sessions.map((session) => session.threadId));
      cursor = older[0]!.nextCursor;
      expect(await list()).toEqual(first);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(nativeCalls);
    }
    expect(ids).toEqual(
      Array.from({ length: visibleCount }, (_, index) => `thread-${hiddenCount + index}`),
    );
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(nativeCalls);
  });
});
