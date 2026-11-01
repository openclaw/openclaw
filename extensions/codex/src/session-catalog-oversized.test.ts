import { expect, it, vi } from "vitest";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import { createClientHarness } from "./app-server/test-support.js";
import { createCodexSessionCatalogControl } from "./session-catalog-control.js";
import type { CodexCatalogState } from "./session-catalog-index-state.js";
import { memoryCatalogState } from "./session-catalog-index.test-support.js";

const commandRpcMocks = vi.hoisted(() => ({ codexControlRequest: vi.fn() }));
// Replace only external RPC acquisition; real client framing and the catalog owner remain intact.
vi.mock("./command-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./command-rpc.js")>()),
  ...commandRpcMocks,
}));
const config = {};

function serveCatalog() {
  const native = Array.from({ length: 4 }, (_, index) => ({
    cwd: "/workspace/project",
    status: { type: "idle" },
    id: `thread-${index}`,
    source: index === 2 ? "exec" : "cli",
    recencyAt: 4 - index,
    preview:
      index === 1 || index === 2
        ? 'Escaped "nextCursor": "fake" \\\\ 猫 '.repeat(400_000)
        : "healthy preview",
  }));
  let requests = 0;
  const harness = createClientHarness({
    onWrite(line, send) {
      const request = JSON.parse(line);
      if (request.method !== "thread/list") {
        return;
      }
      const { cursor, limit } = request.params;
      const offset = cursor ? Number(cursor.slice("after-".length)) : 0;
      const data = native.slice(offset, offset + limit);
      const next = offset + data.length;
      requests++;
      send({
        id: request.id,
        result: {
          data,
          nextCursor: next < native.length ? `after-${next}` : null,
          backwardsCursor: `before-${offset}`,
        },
      });
    },
  });
  commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, method, params, options) =>
    harness.client.request(method, params, {
      timeoutMs: options.timeoutMs,
      catalogPreview: true,
      catalogRows: options.catalogRows,
    }),
  );
  return { harness, requestCount: () => requests, native };
}

function createFactory(state: CodexCatalogState) {
  return createCodexSessionCatalogControl({
    resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
    getPluginConfig: () => ({
      appServer: {
        transport: "websocket",
        url: "wss://oversized.example.test/codex",
        authToken: "synthetic-catalog-token",
      },
    }),
    getRuntimeConfig: () => config,
    openResidentState: () => state,
  });
}

it("bounds and persists visible and hidden oversized threads across restart", async () => {
  const { requestCount, native, harness } = serveCatalog();
  const { values, state } = memoryCatalogState({ clone: true });
  let factory = createFactory(state);
  const connect = async () => factory.forRequest("main", (await factory.homesForAgent("main"))[0]!);
  const visibleIds = ["thread-0", "thread-1", "thread-3"];
  const oversized = { catalogError: "oversized-thread", status: "systemError" };
  try {
    const control = await connect();
    await control.initialize();
    expect([...values.values()]).toContainEqual({
      version: 1,
      kind: "row",
      row: expect.objectContaining({ threadId: "thread-2", page: { sessions: [] } }),
    });
    const requestsBeforeRestart = requestCount();
    expect(Buffer.byteLength(JSON.stringify([...values]))).toBeLessThan(16 * 1024);
    await factory.stop();
    factory = createFactory(state);
    const restoredControl = await connect();
    const restored = await restoredControl.listPage({ limit: 20 });
    expect(restored.sessions.map((row) => row.threadId)).toEqual(visibleIds);
    expect(restored.nextCursor).toBeUndefined();
    expect(requestCount()).toBe(requestsBeforeRestart);
    expect(restored.sessions[1]).toMatchObject(oversized);
    native[1]!.preview = "Recovered preview";
    await restoredControl.initialize();
    const recovered = await restoredControl.listPage({ limit: 20 });
    expect(recovered.sessions[1]).not.toHaveProperty("catalogError");
    expect(recovered.sessions[1]?.status).not.toBe("systemError");
  } finally {
    await factory.stop();
    await harness.client.closeAndWait();
  }
});
