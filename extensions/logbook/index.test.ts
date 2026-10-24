import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OpenClawPluginNodeInvokePolicy } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
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
  const policy = vi.spyOn(captured.api, "registerNodeInvokePolicy").mockImplementation(() => {});
  const service = vi.spyOn(captured.api, "registerService").mockImplementation(() => {});
  const rpc = vi.spyOn(captured.api, "registerGatewayMethod").mockImplementation(() => {});
  plugin.register({ ...captured.api, runtimeSource });
  return {
    policy: policy.mock.calls[0]![0],
    service: service.mock.calls[0]![0],
    methods: rpc.mock.calls,
  };
}

afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("logbook registration", () => {
  it("returns ordered frame metadata through the registered service and SQLite worker", async () => {
    const stateDir = tempDirs.make("logbook-range-rpc-");
    const { methods, service } = registerLogbook();
    const handler = methods.find(([method]) => method === "logbook.frames")![1];
    const context = {
      config: {},
      stateDir,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      scheduler: createTestPluginServiceScheduler(),
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
      for (const [index, offset] of [0, 0, 2000].entries()) {
        const capturedAtMs = startMs + offset;
        const id = await store.captureFrame({
          capturedAtMs,
          day,
          screenIndex: 0,
          buffer: Buffer.from(index < 2 ? "synthetic initial" : "synthetic changed"),
        });
        ids.push(id);
      }
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
      const frames = [
        { id: ids[0], capturedAtMs: startMs, idle: false },
        { id: ids[1], capturedAtMs: startMs, idle: true },
      ];
      expect(await call(startMs + 2000)).toEqual([true, { frames }]);
      expect(await call(startMs)).toEqual([true, { frames: [] }]);
    } finally {
      context.scheduler.beginClose();
      try {
        await service.stop?.(context);
      } finally {
        await context.scheduler.stop();
        await store.close();
      }
    }
  });

  it("keeps only process-wide status independent of the authenticated profile", () => {
    const { methods } = registerLogbook();
    expect(methods.find(([method]) => method === "logbook.status")?.[2]).toEqual({
      scope: "operator.read",
      profileAccess: "independent",
    });
    for (const registration of methods.filter(([method]) => method !== "logbook.status")) {
      expect(registration[2]).not.toHaveProperty("profileAccess");
    }
  });

  it.each([
    ["extensions/logbook/index.ts", "extensions/logbook/src/store.worker.ts"],
    ["plugins/logbook/dist/index.js", "plugins/logbook/dist/src/store.worker.js"],
  ] as const)("locates the worker for runtime entry %s", async (entry, worker) => {
    const root = tempDirs.make("logbook-worker-layout-");
    const runtimeSource = path.resolve(root, entry);
    if (entry.endsWith(".js")) {
      const packageRoot = path.dirname(path.dirname(runtimeSource));
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "@openclaw/logbook" }),
      );
    }
    const { service } = registerLogbook(runtimeSource);
    const config = { database: { engine: "postgres" as const } };
    const stopBeforeOpening = new Error("worker location captured");
    const open = vi.spyOn(LogbookStore, "open").mockRejectedValueOnce(stopBeforeOpening);
    const scheduler = createTestPluginServiceScheduler();
    try {
      await expect(
        service.start({ config, stateDir: "/unused", logger: console, scheduler }),
      ).rejects.toBe(stopBeforeOpening);
      expect(open).toHaveBeenCalledExactlyOnceWith(
        path.join("/unused", "logbook"),
        pathToFileURL(path.resolve(root, worker)),
      );
    } finally {
      await scheduler.stop();
    }
  });
  it.each([
    ["screen.snapshot", { ok: false, code: "SCREEN_CAPTURE_DENIED" }, 0],
    ["camera.snap", { ok: true }, 1],
  ] as const)("applies the snapshot policy with %s denied", async (denied, expected, calls) => {
    const { policy } = registerLogbook();
    expect(policy.commands).toEqual(["logbook.snapshot"]);
    const invokeNode = vi.fn().mockResolvedValue({ ok: true, payloadJSON: null });
    expect(
      await policy.handle({
        nodeId: "node-1",
        command: "logbook.snapshot",
        params: undefined,
        config: { gateway: { nodes: { commands: { deny: [denied] } } } },
        invokeNode,
      } as unknown as PolicyContext),
    ).toMatchObject(expected);
    expect(invokeNode).toHaveBeenCalledTimes(calls);
  });
});
