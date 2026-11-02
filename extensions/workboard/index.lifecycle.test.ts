import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { assert, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { WorkboardStore } from "./src/store.js";
import { createGatewayMethodCapture } from "./src/test/gateway-method-capture.js";
import {
  WORKBOARD_CARD_TOOL_NAMES,
  WORKBOARD_SESSIONS_BOARD_TOOL_NAMES,
} from "./src/workspace-access.js";

const workerModuleUrl = new URL("./src/sqlite-store.worker.ts", import.meta.url);
const runtimeSource = fileURLToPath(new URL("./index.ts", import.meta.url));
const closedStore = "workboard store is closed.";

it("discovers tool schemas without creating storage and persists executed tools", () =>
  withStateDirEnv("workboard-discovery-", async ({ stateDir }) => {
    {
      await using discovery = registerGeneration(plugin.register, "tool-discovery");
      const tools = discovery.tools();
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(
        [...WORKBOARD_CARD_TOOL_NAMES, ...WORKBOARD_SESSIONS_BOARD_TOOL_NAMES].toSorted(),
      );
      const create = tools.find((tool) => tool.name === "workboard_create")!;
      expect(existsSync(path.join(stateDir, "plugins/workboard/workboard.sqlite"))).toBe(false);
      await create.execute("create", { title: "Retained discovery card" });
    }
    await using reopened = openStore();
    expect(await reopened.list()).toMatchObject([{ title: "Retained discovery card" }]);
  }));

function openStore() {
  const store = WorkboardStore.openSqlite(workerModuleUrl);
  return Object.assign(store, { [Symbol.asyncDispose]: () => store.close() });
}

function registerGeneration(
  register: (api: OpenClawPluginApi) => void = plugin.register,
  registrationMode: OpenClawPluginApi["registrationMode"] = "full",
) {
  const captured = createCapturedPluginRegistration({ ...plugin, registrationMode });
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  const { registerGatewayMethod, invoke: rpc } = createGatewayMethodCapture();
  let gatewayStart: Parameters<typeof captured.api.on<"gateway_start">>[1] = () => {};
  let gatewayStop: Parameters<typeof captured.api.on<"gateway_stop">>[1] = () => {};
  register({
    ...captured.api,
    runtimeSource,
    registerService,
    registerTool,
    registerGatewayMethod,
    on: (name, handler) => {
      if (name === "gateway_start") {
        gatewayStart = handler as typeof gatewayStart;
      } else if (name === "gateway_stop") {
        gatewayStop = handler as typeof gatewayStop;
      }
    },
  });
  const mocks = { warn: vi.fn(), emit: vi.fn() };
  const serviceContext = {
    config: {},
    stateDir: process.env.OPENCLAW_STATE_DIR!,
    logger: { ...captured.api.logger, warn: mocks.warn },
    gatewayEvents: { emit: mocks.emit, onSessionsChanged: () => () => {} },
  };
  const start = async () => {
    for (const [service] of registerService.mock.calls) {
      assert(service.apiVersion !== 2, "Workboard uses v1 services without a host scheduler");
      await service.start(serviceContext);
    }
    void gatewayStart({ port: 0 }, {});
    await vi.advanceTimersByTimeAsync(0);
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
    const [ok, payload, error] = (await rpc(`workboard.${method}`, { ...params })).mock.calls[0]!;
    expect({ ok, payload, error }).toMatchObject({ ok: true, ...response });
  };
  const expectCards = (titles: string[], allowOthers = false) => {
    const cards = titles.map((title) => expect.objectContaining({ title }));
    return expectCall("cards.list", {
      payload: { cards: allowOthers ? expect.arrayContaining(cards) : cards },
    });
  };
  return Object.assign(
    { cleanup: retire, start, ...mocks, expectCall, expectCards },
    {
      tools: () =>
        registerTool.mock.calls.flatMap(
          ([factory]) =>
            (typeof factory === "function"
              ? factory({})
              : "create" in factory
                ? factory.create({ assertInvocationCurrent: () => {} })
                : factory) ?? [],
        ),
      async [Symbol.asyncDispose]() {
        void gatewayStop({}, {});
        await retire();
      },
    },
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
      await second.expectCall("cards.create", { params: { title: "Fresh card" } });
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
      const board = { id: "retained", name: "Retained board" };
      await generation.expectCall("boards.upsert", { params: board });
      await generation.cleanup({ reason: "disable", sessionKey: "agent:other:session" });
      await generation.expectCall("cards.list");
      await generation.cleanup({ reason: "disable" });
      await generation.expectCall("cards.list", { ok: ownership === "injected" });
      await using reopened = openStore();
      expect((await reopened.listBoards()).boards).toContainEqual(expect.objectContaining(board));
    }),
);
