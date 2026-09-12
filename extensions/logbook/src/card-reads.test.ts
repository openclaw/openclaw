import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { LogbookStore } from "./store.js";

const workerModuleUrl = new URL("./store.worker.ts", import.meta.url);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("serves timeline and status through their bounded store operations", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-03T12:00:00"));
  const stateDir = realpathSync(mkdtempSync(path.join(tmpdir(), "logbook-card-reads-")));
  const services: OpenClawPluginService[] = [];
  const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
  const context = {
    stateDir,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  const store = await LogbookStore.open(path.join(stateDir, "logbook"), workerModuleUrl);
  const day = "2026-07-03";
  const startMs = new Date(`${day}T09:00:00`).getTime();
  const drafts = Array.from({ length: 8 }, (_, index) => ({
    day,
    startMs: startMs + index * 60_000,
    endMs: startMs + (index + 1) * 60_000,
    title: `Card ${index} 🦞`,
    summary: "Summary",
    detail: "Detailed activity",
    category: "coding",
    distractions: [{ startMs: startMs + 1, endMs: startMs + 11, title: "Break" }],
  }));
  await store.replaceCardsInWindow(day, 0, Number.MAX_SAFE_INTEGER, drafts);
  const cards = await store.cardsForDay(day);
  await store.close();

  plugin.register({
    runtimeSource: fileURLToPath(new URL("../index.ts", import.meta.url)),
    pluginConfig: { captureEnabled: false },
    lifecycle: { registerRuntimeLifecycle() {} },
    runtime: {},
    session: { controls: { registerControlUiDescriptor() {} } },
    registerNodeInvokePolicy() {},
    registerService: (service: OpenClawPluginService) => services.push(service),
    registerGatewayMethod: (
      method: string,
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1],
    ) => methods.set(method, handler),
  } as unknown as OpenClawPluginApi);
  const service = services[0]!;
  try {
    await service.start(context);
    const call = async (method: string, params = {}) => {
      const respond = vi.fn();
      await methods.get(method)!({ params, respond } as unknown as GatewayRequestHandlerOptions);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return respond.mock.calls[0]?.[1];
    };
    const timeline = vi.spyOn(LogbookStore.prototype, "timelineForDay");
    const cardPayloads = vi.spyOn(LogbookStore.prototype, "cardsForDay");
    const cardCount = vi.spyOn(LogbookStore.prototype, "countCardsForDay");
    expect(await call("logbook.timeline", { day })).toEqual({
      day,
      cards,
      stats: {
        trackedMs: 8 * 60_000,
        distractionMs: 80,
        categories: [{ category: "coding", ms: 8 * 60_000 }],
        apps: [],
      },
    });
    expect(timeline).toHaveBeenCalledExactlyOnceWith(day);

    expect(await call("logbook.status")).toMatchObject({ today: day, todayCards: 8 });
    expect(cardCount).toHaveBeenCalledExactlyOnceWith(day);
    expect(cardPayloads).not.toHaveBeenCalled();
  } finally {
    await service.stop?.(context);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
