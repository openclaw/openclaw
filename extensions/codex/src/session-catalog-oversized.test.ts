import { expect, it, vi } from "vitest";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import { createClientHarness } from "./app-server/test-support.js";
import { createCodexSessionCatalogControl } from "./session-catalog-control.js";
import type { CodexCatalogState, StoredCodexCatalogEntry } from "./session-catalog-index-state.js";

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
  const requests: Array<{
    cursor?: string;
    limit: number;
    bytes: number;
    projectedBytes?: number;
  }> = [];
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
      requests.push({ cursor, limit, bytes: Buffer.byteLength(JSON.stringify(response)) });
      send(response);
    },
  });
  commandRpcMocks.codexControlRequest.mockImplementation(
    async (_plugin, method, params, options) => {
      const response = await harness.client.request(method, params, {
        timeoutMs: options.timeoutMs,
        catalogPreview: true,
        catalogRows: options.catalogRows,
      });
      requests.at(-1)!.projectedBytes = Buffer.byteLength(JSON.stringify(response));
      return response;
    },
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

function createStoredState() {
  const values = new Map<string, StoredCodexCatalogEntry>();
  const state: CodexCatalogState = {
    entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
    register: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key) => values.delete(key),
  };
  return { values, state };
}

it("finishes a native snapshot past one oversized thread with bounded metadata and requests", async () => {
  const { harness, requests, native } = serveCatalog();
  const { values, state } = createStoredState();
  const factory = createFactory(state);
  let restarted: ReturnType<typeof createFactory> | undefined;
  try {
    const home = (await factory.homesForAgent("main"))[0]!;
    const control = factory.forRequest("main", home);
    await control.initialize();
    const page = await control.listPage({ limit: 20 });
    expect(page.sessions.map((row) => row.threadId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `thread-${index}`),
    );
    expect(page.sessions[5]).toMatchObject({
      catalogError: "oversized-thread",
      status: "systemError",
    });
    expect(page.nextCursor).toBeUndefined();
    expect(values.get("complete")).toEqual({ version: 1, kind: "complete" });
    expect(requests.map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
      { cursor: undefined, limit: 16 },
      { cursor: undefined, limit: 8 },
      { cursor: undefined, limit: 4 },
      { cursor: "after-4", limit: 4 },
      { cursor: "after-4", limit: 2 },
      ...Array.from({ length: 6 }, (_, index) => ({ cursor: `after-${index + 4}`, limit: 1 })),
    ]);
    const retainedBytes = Buffer.byteLength(JSON.stringify([...values]));
    expect(retainedBytes).toBeLessThan(16 * 1024);
    await factory.stop();
    restarted = createFactory(state);
    const restoredHome = (await restarted.homesForAgent("main"))[0]!;
    const restoredControl = restarted.forRequest("main", restoredHome);
    const restored = await restoredControl.listPage({ limit: 20 });
    expect(restored.sessions[5]).toMatchObject({
      catalogError: "oversized-thread",
      status: "systemError",
    });
    expect(requests).toHaveLength(11);
    native[5]!.preview = "Recovered preview";
    await restoredControl.initialize();
    const recovered = await restoredControl.listPage({ limit: 20 });
    expect(recovered.sessions[5]).not.toHaveProperty("catalogError");
    expect(recovered.sessions[5]?.status).not.toBe("systemError");
  } finally {
    console.info("catalog boundary", {
      firstResponseBytes: requests[0]?.bytes,
      largestHealthyResponseBytes: Math.max(
        0,
        ...requests.filter(({ bytes }) => bytes <= 8 * 1024 * 1024).map(({ bytes }) => bytes),
      ),
      requests: requests.length,
      largestProjectedResponseBytes: Math.max(
        0,
        ...requests.map(({ projectedBytes }) => projectedBytes ?? 0),
      ),
      retainedBytes: Buffer.byteLength(JSON.stringify([...values])),
    });
    await factory.stop();
    await restarted?.stop();
    await harness.client.closeAndWait();
  }
});

it("omits an oversized noninteractive thread while completing and persisting the snapshot", async () => {
  const { harness, requests, native } = serveCatalog();
  native[5]!.source = "exec";
  const { values, state } = createStoredState();
  const factory = createFactory(state);
  let restarted: ReturnType<typeof createFactory> | undefined;
  const visibleThreadIds = [0, 1, 2, 3, 4, 6, 7, 8, 9].map((index) => `thread-${index}`);
  try {
    const home = (await factory.homesForAgent("main"))[0]!;
    const control = factory.forRequest("main", home);
    await control.initialize();
    const page = await control.listPage({ limit: 20 });
    expect(page.sessions.map((row) => row.threadId)).toEqual(visibleThreadIds);
    expect(page.nextCursor).toBeUndefined();
    expect(values.get("complete")).toEqual({ version: 1, kind: "complete" });
    expect(requests).toHaveLength(11);
    expect([...values.values()]).toContainEqual({
      version: 1,
      kind: "row",
      row: expect.objectContaining({ threadId: "thread-5", page: { sessions: [] } }),
    });
    await factory.stop();
    restarted = createFactory(state);
    const restoredHome = (await restarted.homesForAgent("main"))[0]!;
    const restored = await restarted.forRequest("main", restoredHome).listPage({ limit: 20 });
    expect(restored.sessions.map((row) => row.threadId)).toEqual(visibleThreadIds);
    expect(requests).toHaveLength(11);
  } finally {
    await factory.stop();
    await restarted?.stop();
    await harness.client.closeAndWait();
  }
});
