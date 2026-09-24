import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/plugin-entry";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { dayKeyFor } from "./src/day.js";
import { logbookSqliteBackendEntrypoint } from "./src/sqlite-backend-entrypoint.test-support.js";
import { LogbookStore } from "./src/store.js";

type PolicyContext = Parameters<OpenClawPluginNodeInvokePolicy["handle"]>[0];

function registerLogbook(runtimeSource = fileURLToPath(new URL("./index.ts", import.meta.url))) {
  const captured = createCapturedPluginRegistration({ id: "logbook" });
  captured.api.pluginConfig = { captureEnabled: false };
  const policies: OpenClawPluginNodeInvokePolicy[] = [];
  const services: OpenClawPluginService[] = [];
  const methods: Array<{
    method: string;
    handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
    options: unknown;
  }> = [];
  captured.api.registerNodeInvokePolicy = (policy) => policies.push(policy);
  captured.api.registerService = (service) => services.push(service);
  captured.api.registerGatewayMethod = (method, handler, options) => {
    methods.push({ method, handler, options });
  };
  plugin.register({ ...captured.api, runtimeSource });
  return { policies, services, methods };
}

afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("logbook gateway methods", () => {
  it("returns ordered frame metadata through the registered service and SQLite worker", async () => {
    const stateDir = tempDirs.make("logbook-range-rpc-");
    const { methods, services } = registerLogbook();
    const service = services[0]!;
    const handler = methods.find((entry) => entry.method === "logbook.frames")!.handler;
    const context = {
      config: {},
      stateDir,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    };
    const store = await LogbookStore.open(
      path.join(stateDir, "logbook"),
      resolveRuntimeWorkerUrl(logbookSqliteBackendEntrypoint),
    );
    vi.spyOn(LogbookStore, "open").mockResolvedValueOnce(store);
    try {
      await service.start(context);
      const startMs = Date.now();
      const day = dayKeyFor(startMs);
      const ids: number[] = [];
      for (const [capturedAtMs, idle] of [
        [startMs, false],
        [startMs, true],
        [startMs + 2000, false],
      ] as const) {
        ids.push(
          await store.insertFrame({
            capturedAtMs,
            day,
            path: store.frameFilePath(day, capturedAtMs),
            screenIndex: 0,
            byteSize: 9,
            contentHash: `synthetic-${ids.length}`,
            idle,
          }),
        );
      }
      await store.createBatch({
        day,
        startMs,
        endMs: startMs + 3000,
        frameIds: [ids[0]!, ids[2]!],
      });
      const call = async (endMs: number) => {
        const params = { startMs, endMs };
        const respond = vi.fn();
        await handler({
          req: { type: "req", id: "range", method: "logbook.frames", params },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond,
          get context(): never {
            throw new Error("The frame range handler does not use Gateway request context");
          },
        });
        expect(respond).toHaveBeenCalledTimes(1);
        return respond.mock.calls[0];
      };
      expect(await call(startMs + 2000)).toEqual([
        true,
        {
          frames: [
            { id: ids[0], capturedAtMs: startMs, idle: false },
            { id: ids[1], capturedAtMs: startMs, idle: true },
          ],
        },
      ]);
      expect(await call(startMs)).toEqual([true, { frames: [] }]);
      expect(await store.frameById(ids[0]!)).toMatchObject({
        day,
        path: store.frameFilePath(day, startMs),
        width: undefined,
        height: undefined,
        screenIndex: 0,
        byteSize: 9,
      });
    } finally {
      try {
        await service.stop?.(context);
      } finally {
        await store.close();
      }
    }
  });

  it("keeps only process-wide status independent of the authenticated profile", () => {
    const { methods } = registerLogbook();
    expect(methods.find((entry) => entry.method === "logbook.status")?.options).toEqual({
      scope: "operator.read",
      profileAccess: "independent",
    });
    for (const registration of methods.filter((entry) => entry.method !== "logbook.status")) {
      expect(registration.options).not.toHaveProperty("profileAccess");
    }
  });

  it.each([
    ["source", "extensions/logbook/index.ts", "extensions/logbook/src/store.worker.ts"],
    ["standalone", "plugins/logbook/dist/index.js", "plugins/logbook/dist/src/store.worker.js"],
    ["bundled", "dist/extensions/logbook/index.js", "dist/extensions/logbook/src/store.worker.js"],
  ] as const)(
    "locates its %s worker from the selected runtime entry",
    async (_layout, entry, worker) => {
      const { services } = registerLogbook(path.resolve(entry));
      const stopBeforeOpening = new Error("worker location captured");
      const open = vi.spyOn(LogbookStore, "open").mockRejectedValueOnce(stopBeforeOpening);
      await expect(
        services[0]!.start({ config: {}, stateDir: "/unused", logger: console }),
      ).rejects.toBe(stopBeforeOpening);
      expect(open).toHaveBeenCalledExactlyOnceWith(
        path.join("/unused", "logbook"),
        pathToFileURL(path.resolve(worker)),
      );
    },
  );
});

describe("logbook snapshot invoke policy", () => {
  it("blocks logbook.snapshot when gateway.nodes.commands.deny lists screen.snapshot", async () => {
    const {
      policies: [policy],
    } = registerLogbook();
    expect(policy?.commands).toEqual(["logbook.snapshot"]);
    const invokeNode = vi.fn();
    const result = await policy!.handle({
      nodeId: "node-1",
      command: "logbook.snapshot",
      params: undefined,
      config: { gateway: { nodes: { commands: { deny: ["screen.snapshot"] } } } },
      invokeNode,
    } as unknown as PolicyContext);
    expect(result).toMatchObject({ ok: false, code: "SCREEN_CAPTURE_DENIED" });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("invokes the node when screen.snapshot is not denied", async () => {
    const {
      policies: [policy],
    } = registerLogbook();
    const invokeNode = vi.fn().mockResolvedValue({ ok: true, payloadJSON: null });
    const result = await policy!.handle({
      nodeId: "node-1",
      command: "logbook.snapshot",
      params: undefined,
      config: { gateway: { nodes: { commands: { deny: ["camera.snap"] } } } },
      invokeNode,
    } as unknown as PolicyContext);
    expect(result).toMatchObject({ ok: true });
    expect(invokeNode).toHaveBeenCalledTimes(1);
  });
});
