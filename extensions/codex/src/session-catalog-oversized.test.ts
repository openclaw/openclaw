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
  const native = Array.from({ length: 10 }, (_, index) => ({
    cwd: "/workspace/project",
    projectId: null,
    name: "Native task",
    status: { type: "idle" },
    id: `thread-${index}`,
    source: "cli",
    recencyAt: 10 - index,
    preview:
      index === 5 ? 'Escaped "nextCursor": "fake" \\\\ 猫 '.repeat(400_000) : "healthy preview",
  }));
  const requests: Array<{ cursor?: string; limit: number }> = [];
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
      const response = {
        id: request.id,
        result: {
          data,
          nextCursor: next < native.length ? `after-${next}` : null,
          backwardsCursor: `before-${offset}`,
        },
      };
      requests.push({ cursor, limit });
      send(response);
    },
  });
  commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, method, params, options) =>
    harness.client.request(method, params, {
      timeoutMs: options.timeoutMs,
      catalogPreview: true,
      catalogRows: options.catalogRows,
    }),
  );
  return { harness, requests, native };
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

it.each(["cli", "exec"])(
  "bounds and persists oversized %s threads across restart",
  async (source) => {
    const { requests, native, harness } = serveCatalog();
    native[5]!.source = source;
    const { values, state } = memoryCatalogState({ clone: true });
    let factory = createFactory(state);
    const connect = async () =>
      factory.forRequest("main", (await factory.homesForAgent("main"))[0]!);
    const visibleIds = native
      .filter((_, index) => source === "cli" || index !== 5)
      .map(({ id }) => id);
    const oversized = { catalogError: "oversized-thread", status: "systemError" };
    try {
      const control = await connect();
      await control.initialize();
      const page = await control.listPage({ limit: 20 });
      expect(page.sessions.map((row) => row.threadId)).toEqual(visibleIds);
      expect(page.nextCursor).toBeUndefined();
      if (source === "cli") {
        expect(page.sessions[5]).toMatchObject(oversized);
      } else {
        expect([...values.values()]).toContainEqual({
          version: 1,
          kind: "row",
          row: expect.objectContaining({ threadId: "thread-5", page: { sessions: [] } }),
        });
      }
      expect(values.get("complete")).toEqual({ version: 1, kind: "complete" });
      expect(requests).toEqual([
        { cursor: undefined, limit: 16 },
        { cursor: undefined, limit: 8 },
        { cursor: undefined, limit: 4 },
        { cursor: "after-4", limit: 4 },
        { cursor: "after-4", limit: 2 },
        ...Array.from({ length: 6 }, (_, index) => ({ cursor: `after-${index + 4}`, limit: 1 })),
      ]);
      expect(Buffer.byteLength(JSON.stringify([...values]))).toBeLessThan(16 * 1024);
      await factory.stop();
      factory = createFactory(state);
      const restoredControl = await connect();
      const restored = await restoredControl.listPage({ limit: 20 });
      expect(restored.sessions.map((row) => row.threadId)).toEqual(visibleIds);
      expect(requests).toHaveLength(11);
      if (source === "cli") {
        expect(restored.sessions[5]).toMatchObject(oversized);
        native[5]!.preview = "Recovered preview";
        await restoredControl.initialize();
        const recovered = await restoredControl.listPage({ limit: 20 });
        expect(recovered.sessions[5]).not.toHaveProperty("catalogError");
        expect(recovered.sessions[5]?.status).not.toBe("systemError");
      }
    } finally {
      await factory.stop();
      await harness.client.closeAndWait();
    }
  },
);
