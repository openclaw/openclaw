import vm from "node:vm";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, expect, it, vi } from "vitest";
import { createRelayCommandHandler } from "../../../chrome-extension/modules/relay-command-handler.js";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../../control-service.js";
import { executeActViaPlaywright } from "../pw-tools-core.interactions.execution.js";
import { withConnectedDaemon } from "./relay-coexistence.test-support.js";

const targetId = "fixture-target";
afterEach(async () => {
  await stopBrowserControlService();
  clearRuntimeConfigSnapshot();
  vi.unstubAllGlobals();
});

it.each(["owned", "borrowed"] as const)(
  "repairs the %s relay after initial attach loss and delayed frame-tree publication",
  async (ownership) => {
    const barriers = () => ({
      held: createDeferred<void>(),
      release: createDeferred<void>(),
      later: createDeferred<void>(),
    });
    let barrier = barriers();
    const methods = new WeakMap<object, { method?: string; checks: number }>();
    const realm = vm.createContext({});
    const objects = new Map<string, unknown>();
    const evaluated: unknown[] = [];
    const frame = { id: targetId, loaderId: "loader", url: "https://example.com/fixture" };
    let attachAttempts = 0;
    let send: (message: Record<string, unknown>) => void;
    const event = (id: number, name: unknown, isDefault: boolean) =>
      send({
        type: "cdpEvent",
        tabId: 1,
        method: "Runtime.executionContextCreated",
        params: { context: { id, name, auxData: { frameId: targetId, isDefault } } },
      });
    const requireTab = async (_tabId: number, epoch: object) => {
      const admission = methods.get(epoch)!;
      if (admission.method === "Page.getFrameTree" && ++admission.checks === 2) {
        barrier.held.resolve();
        await barrier.release.promise;
      }
      return { id: 1 };
    };
    vi.stubGlobal("chrome", {
      debugger: {
        sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
          switch (method) {
            case "Page.getFrameTree":
              return { frameTree: { frame } };
            case "Target.getTargetInfo":
              return { targetInfo: { targetId, title: "Fixture" } };
            case "Runtime.enable":
              event(1, "", true);
              break;
            case "Runtime.runIfWaitingForDebugger":
              barrier.later.resolve();
              break;
            case "Page.createIsolatedWorld":
              event(2, params.worldName, false);
              return { executionContextId: 2 };
            case "Runtime.evaluate": {
              objects.set("utility", vm.runInContext(String(params.expression), realm));
              return { result: { type: "object", objectId: "utility" } };
            }
            case "Runtime.callFunctionOn": {
              const args = (params.arguments as Array<{ value?: unknown; objectId?: string }>).map(
                (arg) => (arg.objectId ? objects.get(arg.objectId) : arg.value),
              );
              const fn = vm.runInContext(`(${String(params.functionDeclaration)})`, realm);
              const value = await fn.apply(objects.get(String(params.objectId)), args);
              evaluated.push(value);
              return { result: { type: "object", value } };
            }
          }
          return {};
        },
      },
    });
    const handler = createRelayCommandHandler({
      send: (message) => send(message),
      isCurrent: () => true,
      attachDebugger: async () => ({ targetId, assertCurrent: () => {} }),
      detachDebugger: async () => {},
      createTab: async () => {},
      focusWindowForTab: async () => {},
      scheduleTabsSync: () => {},
      captureDebugger: () => () => {},
      captureAccess: (_tabId, method) => {
        const epoch = { revision: 1, groupRevision: 0, tabRevision: 1 };
        methods.set(epoch, { method, checks: 0 });
        return epoch;
      },
      requireAccessibleTab: requireTab,
      requireNavigatedTab: requireTab,
      navigateTab: async () => {},
    });
    await withConnectedDaemon(
      async ({ extension }) => {
        await startBrowserControlServiceFromConfig();
        const ctx = createBrowserControlContext();
        expect(ctx.state().extensionRelays?.get("chrome")?.ownership).toBe(ownership);
        const profile = ctx.forProfile("chrome");
        const finishListing = async (attempts: number) => {
          const listing = expect(profile.listTabs()).resolves.toEqual([
            expect.objectContaining({ targetId }),
          ]);
          void listing.catch(() => {});
          await barrier.held.promise;
          // Unrelated bootstrap commands must progress while frame-tree publication waits.
          await barrier.later.promise;
          barrier.release.resolve();
          await listing;
          expect(attachAttempts).toBe(attempts);
        };
        await finishListing(2);
        barrier = barriers();
        extension.send(JSON.stringify({ type: "detached", tabId: 1, reason: "renderer replaced" }));
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        await finishListing(3);

        const abort = new AbortController();
        const evaluation = executeActViaPlaywright({
          cdpUrl: profile.profile.cdpUrl,
          targetId,
          action: { kind: "evaluate", fn: "() => 42" },
          evaluateEnabled: true,
          signal: abort.signal,
        });
        void evaluation.catch(() => {});
        try {
          await expect.poll(() => evaluated, { timeout: 1_000 }).toEqual([42]);
          await expect(evaluation).resolves.toMatchObject({ result: 42 });
        } finally {
          abort.abort(new Error("test finished"));
          await evaluation.catch(() => {});
        }
      },
      ownership === "owned"
        ? async () => {
            const state = await startBrowserControlServiceFromConfig();
            const relay = state?.extensionRelays?.get("chrome");
            const stopped = createDeferred<void>();
            return {
              port: relay?.ownership === "owned" ? relay.port : null,
              stop: () => {
                void stopBrowserControlService().then(stopped.resolve, stopped.reject);
              },
              done: stopped.promise,
            };
          }
        : undefined,
      (command, reply) => {
        send = reply;
        if (command.type === "attach" && attachAttempts++ === 0) {
          reply({
            type: "error",
            seq: command.seq,
            message: "tab generation changed during initial auto-attach",
          });
          return true;
        }
        if (command.type === "cdp") {
          void handler(command);
          return true;
        }
        return false;
      },
    );
  },
);
