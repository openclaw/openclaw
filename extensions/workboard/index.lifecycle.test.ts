import { fileURLToPath } from "node:url";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { WorkboardStore } from "./src/store.js";

const workerModuleUrl = new URL("./src/sqlite-store.worker.ts", import.meta.url);

const runtimeSource = fileURLToPath(new URL("./index.ts", import.meta.url));

function registerGeneration(register: (api: OpenClawPluginApi) => void = plugin.register) {
  const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
  const methods = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
  let gatewayStart = () => {};
  let gatewayStop = () => {};
  const captured = capturePluginRegistration({
    ...plugin,
    register(api) {
      api.registerService = (service) => {
        services.push(service);
      };
      api.registerGatewayMethod = (method, handler) => {
        methods.set(method, handler);
      };
      api.on = (name, handler) => {
        if (name === "gateway_start") {
          gatewayStart = () => {
            void (handler as Parameters<typeof api.on<"gateway_start">>[1])({ port: 0 }, {});
          };
        } else if (name === "gateway_stop") {
          gatewayStop = () => {
            void (handler as Parameters<typeof api.on<"gateway_stop">>[1])({}, {});
          };
        }
      };
      register({ ...api, runtimeSource });
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
    for (const service of services) {
      await service.start(serviceContext);
    }
    gatewayStart();
    await vi.advanceTimersByTimeAsync(0);
  };
  const stop = async () => {
    scheduler.beginClose();
    try {
      gatewayStop();
      for (const service of services) {
        await service.stop?.(serviceContext);
      }
    } finally {
      await scheduler.stop();
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
    const handler = methods.get(`workboard.${method}`);
    if (!handler) {
      throw new Error(`Missing Gateway method: ${method}`);
    }
    const respond = vi.fn<Parameters<typeof handler>[0]["respond"]>();
    await handler({ params, respond } as unknown as Parameters<typeof handler>[0]);
    const [ok, payload, error] = respond.mock.calls[0] ?? [];
    expect({ ok, payload, error }).toMatchObject({ ok: true, ...response });
  };
  return { cleanup: retire, dispose: () => retire(), start, stop, warn, emit, expectCall };
}

describe("Workboard registration cleanup", () => {
  it("registers store disposal before a later runtime dependency throws", async () => {
    await withStateDirEnv("workboard-registration-failure-", async () => {
      const store = WorkboardStore.openSqlite(workerModuleUrl);
      const opened = vi.spyOn(WorkboardStore, "openSqlite").mockReturnValueOnce(store);
      const failure = new Error("synthetic worktree runtime unavailable");
      try {
        const captured = capturePluginRegistration({
          ...plugin,
          register(api) {
            const runtime = new Proxy(api.runtime, {
              get(target, property) {
                if (property === "worktrees") {
                  throw failure;
                }
                return Reflect.get(target, property, target);
              },
            });
            expect(() => plugin.register({ ...api, runtime, runtimeSource })).toThrow(failure);
          },
        });
        expect(captured.runtimeLifecycles).toHaveLength(1);
        await captured.runtimeLifecycles[0]!.dispose?.();
        await expect(store.list()).rejects.toThrow("workboard store is closed.");
      } finally {
        opened.mockRestore();
        await store.close();
      }
    });
  });

  it.each(["disable", "restart", "dispose"] as const)(
    "closes only the retired generation on %s",
    async (action) => {
      const reason = action === "dispose" ? "disable" : action;
      await withStateDirEnv("workboard-registration-lifecycle-", async () => {
        vi.useFakeTimers();
        const first = registerGeneration();
        const second = registerGeneration();
        const retire = () => (action === "dispose" ? first.dispose() : first.cleanup({ reason }));
        try {
          await first.start();
          await first.expectCall("cards.create", { params: { title: "Retained card" } });
          for (const context of [
            { reason: "reset" as const },
            { reason: "delete" as const },
            { reason, sessionKey: "agent:other:session" },
            { reason, runId: "other-run" },
          ]) {
            await first.cleanup(context);
            await first.expectCall("cards.list", {
              payload: { cards: [expect.objectContaining({ title: "Retained card" })] },
            });
          }

          expect(vi.getTimerCount()).toBeGreaterThan(0);
          await retire();
          await first.expectCall("cards.list", {
            ok: false,
            error: { message: "workboard store is closed." },
          });
          await vi.advanceTimersByTimeAsync(60_000);
          expect(first.warn).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(0);
          await second.start();
          await second.expectCall("cards.create", {
            params: { title: "Fresh card" },
            payload: { card: { title: "Fresh card" } },
          });
          await second.expectCall("cards.list", {
            payload: {
              cards: expect.arrayContaining(
                ["Retained card", "Fresh card"].map((title) => expect.objectContaining({ title })),
              ),
            },
          });
          await retire();
          second.emit.mockClear();
          await second.expectCall("cards.create", {
            params: { title: "After repeated retirement" },
          });
          expect(second.emit).toHaveBeenCalled();
        } finally {
          await first.stop();
          await second.stop();
          await first.cleanup({ reason: "disable" });
          await second.cleanup({ reason: "disable" });
          vi.useRealTimers();
        }
      });
    },
  );

  it.each(["internal", "injected"] as const)(
    "retains public Gateway store ownership for %s stores",
    async (ownership) => {
      await withStateDirEnv("workboard-gateway-lifecycle-", async () => {
        const store =
          ownership === "injected" ? WorkboardStore.openSqlite(workerModuleUrl) : undefined;
        const generation = registerGeneration((api) =>
          registerWorkboardGatewayMethods({ api, store }),
        );
        try {
          await generation.expectCall("cards.list", { payload: { cards: [] } });
          await generation.expectCall("boards.upsert", {
            params: { id: "retained", name: "Retained board" },
          });
          await generation.cleanup({ reason: "disable", sessionKey: "agent:other:session" });
          await generation.expectCall("cards.list");
          await generation.cleanup({ reason: "disable" });
          await generation.expectCall("cards.list", { ok: ownership === "injected" });
          const reopened = WorkboardStore.openSqlite(workerModuleUrl);
          try {
            expect(await reopened.listBoards()).toMatchObject({
              boards: expect.arrayContaining([
                expect.objectContaining({ id: "retained", name: "Retained board" }),
              ]),
            });
          } finally {
            await reopened.close();
          }
        } finally {
          await generation.cleanup({ reason: "disable" });
          await store?.close();
        }
      });
    },
  );
});
