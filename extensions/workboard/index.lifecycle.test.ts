import { fileURLToPath } from "node:url";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { WorkboardStore } from "./src/store.js";

const workerModuleUrl = new URL("./src/sqlite-store.worker.ts", import.meta.url);
const runtimeSource = fileURLToPath(new URL("./index.ts", import.meta.url));
const closedStore = "workboard store is closed.";

function openStore() {
  const store = WorkboardStore.openSqlite(workerModuleUrl);
  return Object.assign(store, { [Symbol.asyncDispose]: () => store.close() });
}

function registerGeneration(register: (api: OpenClawPluginApi) => void = plugin.register) {
  const captured = createCapturedPluginRegistration(plugin);
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  const registerGatewayMethod = vi.fn<OpenClawPluginApi["registerGatewayMethod"]>();
  let gatewayStart: Parameters<typeof captured.api.on<"gateway_start">>[1] = () => {};
  let gatewayStop: Parameters<typeof captured.api.on<"gateway_stop">>[1] = () => {};
  register({
    ...captured.api,
    runtimeSource,
    registerService,
    registerGatewayMethod,
    on: (name, handler) => {
      if (name === "gateway_start") {
        gatewayStart = handler as typeof gatewayStart;
      } else if (name === "gateway_stop") {
        gatewayStop = handler as typeof gatewayStop;
      }
    },
  });
  const warn = vi.fn();
  const emit = vi.fn();
  const scheduler = createTestPluginServiceScheduler();
  const serviceContext = {
    scheduler,
    config: {},
    stateDir: process.env.OPENCLAW_STATE_DIR!,
    logger: { ...captured.api.logger, warn },
    gatewayEvents: { emit, onSessionsChanged: () => () => {} },
  };
  const start = async () => {
    for (const [service] of registerService.mock.calls) {
      await service.start(serviceContext);
    }
    void gatewayStart({ port: 0 }, {});
    await vi.advanceTimersByTimeAsync(0);
  };
  const close = async () => {
    scheduler.beginClose();
    try {
      void gatewayStop({}, {});
      for (const [service] of registerService.mock.calls) {
        await service.stop?.(serviceContext);
      }
    } finally {
      await scheduler.stop();
      await retire({ reason: "disable" });
    }
  };
  const retire = async (
    context?: Parameters<NonNullable<(typeof captured.runtimeLifecycles)[number]["cleanup"]>>[0],
  ) => {
    for (const lifecycle of captured.runtimeLifecycles) {
      await (context ? lifecycle.cleanup?.(context) : lifecycle.dispose?.());
    }
  };
  const expectCall = async (
    method: string,
    expected: { ok?: boolean; payload?: object; error?: object; params?: object } = {},
  ) => {
    const { params = {}, ...response } = expected;
    const handler = registerGatewayMethod.mock.calls.find(
      ([name]) => name === `workboard.${method}`,
    )?.[1];
    if (!handler) {
      throw new Error(`Missing Gateway method: ${method}`);
    }
    const respond = vi.fn<Parameters<typeof handler>[0]["respond"]>();
    await handler({ params, respond } as unknown as Parameters<typeof handler>[0]);
    const [ok, payload, error] = respond.mock.calls[0] ?? [];
    expect({ ok, payload, error }).toMatchObject({ ok: true, ...response });
  };
  const expectCards = (titles: string[], allowOthers = false) => {
    const cards = titles.map((title) => expect.objectContaining({ title }));
    return expectCall("cards.list", {
      payload: { cards: allowOthers ? expect.arrayContaining(cards) : cards },
    });
  };
  return Object.assign(
    { cleanup: retire, start, warn, emit, expectCall, expectCards },
    { [Symbol.asyncDispose]: close },
  );
}

it("registers store disposal before a later runtime dependency throws", () =>
  withStateDirEnv("workboard-registration-failure-", async () => {
    await using store = openStore();
    using _ = vi.spyOn(WorkboardStore, "openSqlite").mockReturnValueOnce(store);
    const failure = new Error("synthetic worktree runtime unavailable");
    const captured = createCapturedPluginRegistration(plugin);
    const runtime = new Proxy(captured.api.runtime, {
      get(target, property) {
        if (property === "worktrees") {
          throw failure;
        }
        return Reflect.get(target, property, target);
      },
    });
    expect(() => plugin.register({ ...captured.api, runtime, runtimeSource })).toThrow(failure);
    expect(captured.runtimeLifecycles).toHaveLength(1);
    await captured.runtimeLifecycles[0]!.dispose?.();
    await expect(store.list()).rejects.toThrow(closedStore);
  }));

it.each(["disable", "restart", "dispose"] as const)(
  "closes only the retired generation on %s",
  (action) =>
    withStateDirEnv("workboard-registration-lifecycle-", async () => {
      const reason = action === "dispose" ? "disable" : action;
      vi.useFakeTimers();
      using _ = { [Symbol.dispose]: () => vi.useRealTimers() };
      await using first = registerGeneration();
      await using second = registerGeneration();
      const retire = () => first.cleanup(action === "dispose" ? undefined : { reason });
      await first.start();
      await first.expectCall("cards.create", { params: { title: "Retained card" } });
      for (const context of [
        { reason: "reset" as const },
        { reason: "delete" as const },
        { reason, sessionKey: "agent:other:session" },
        { reason, runId: "other-run" },
      ]) {
        await first.cleanup(context);
        await first.expectCards(["Retained card"]);
      }

      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await retire();
      await first.expectCall("cards.list", { ok: false, error: { message: closedStore } });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(first.warn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await second.start();
      const fresh = { title: "Fresh card" };
      await second.expectCall("cards.create", { params: fresh, payload: { card: fresh } });
      await second.expectCards(["Retained card", "Fresh card"], true);
      await retire();
      second.emit.mockClear();
      await second.expectCall("cards.create", { params: { title: "After retirement" } });
      expect(second.emit).toHaveBeenCalled();
    }),
);

it.each(["internal", "injected"] as const)(
  "retains public Gateway store ownership for %s stores",
  (ownership) =>
    withStateDirEnv("workboard-gateway-lifecycle-", async () => {
      await using store = ownership === "injected" ? openStore() : undefined;
      await using generation = registerGeneration((api) =>
        registerWorkboardGatewayMethods({ api, store }),
      );
      await generation.expectCards([]);
      const board = { id: "retained", name: "Retained board" };
      await generation.expectCall("boards.upsert", { params: board });
      await generation.cleanup({ reason: "disable", sessionKey: "agent:other:session" });
      await generation.expectCall("cards.list");
      await generation.cleanup({ reason: "disable" });
      await generation.expectCall("cards.list", { ok: ownership === "injected" });
      await using reopened = openStore();
      expect(await reopened.listBoards()).toMatchObject({
        boards: expect.arrayContaining([expect.objectContaining(board)]),
      });
    }),
);
