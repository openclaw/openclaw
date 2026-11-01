import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginNodeInvokePolicy } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { dayKeyFor } from "./src/day.js";
import { LogbookStore } from "./src/store.js";
import {
  quietLogger,
  useLogbookFixture,
  workerModuleUrl,
} from "./src/test-fixtures.test-support.js";

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

const fixture = useLogbookFixture("logbook-registration-");

describe("logbook registration", () => {
  it("returns ordered frame metadata through the registered service and SQLite worker", async () => {
    const stateDir = fixture.makeDir();
    const { methods, service } = registerLogbook();
    const handler = methods.find(([method]) => method === "logbook.frames")![1];
    const context = {
      config: {},
      stateDir,
      logger: quietLogger,
      scheduler: createTestPluginServiceScheduler(),
    };
    const store = await LogbookStore.open(path.join(stateDir, "logbook"), workerModuleUrl);
    fixture.defer(async () => {
      try {
        await service.stop?.(context);
      } finally {
        await store.close();
      }
    });
    vi.spyOn(LogbookStore, "open").mockResolvedValueOnce(store);
    await service.start(context);
    const startMs = Date.now();
    const day = dayKeyFor(startMs);
    const ids: number[] = [];
    for (const [index, offset] of [0, 0, 2000].entries()) {
      const id = await store.captureFrame({
        capturedAtMs: startMs + offset,
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
      return respond.mock.calls[0];
    };
    const frames = [
      { id: ids[0], capturedAtMs: startMs, idle: false },
      { id: ids[1], capturedAtMs: startMs, idle: true },
    ];
    expect(await call(startMs + 2000)).toEqual([true, { frames }]);
    expect(await call(startMs)).toEqual([true, { frames: [] }]);
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

  it("locates the packaged worker from the runtime entry", async () => {
    const { service } = registerLogbook(fileURLToPath(new URL("./dist/index.js", import.meta.url)));
    const stopBeforeOpening = new Error("worker location captured");
    const open = vi.spyOn(LogbookStore, "open").mockRejectedValueOnce(stopBeforeOpening);
    const scheduler = createTestPluginServiceScheduler();
    fixture.defer(() => scheduler.stop());
    await expect(
      service.start({ config: {}, stateDir: "/unused", logger: quietLogger, scheduler }),
    ).rejects.toBe(stopBeforeOpening);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      path.join("/unused", "logbook"),
      new URL("./dist/src/store.worker.js", import.meta.url),
    );
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
        config: { gateway: { nodes: { commands: { deny: [denied] } } } },
        invokeNode,
      } as unknown as PolicyContext),
    ).toMatchObject(expected);
    expect(invokeNode).toHaveBeenCalledTimes(calls);
  });
});
