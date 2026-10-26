import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { startLazyPluginServiceModule } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { registerBrowserPlugin } from "./plugin-registration.js";

const { upgradeExtension, upgradeScreencast, stopControl, startEager, startCleanup } = vi.hoisted(
  () => ({
    upgradeExtension: vi.fn(async () => true),
    upgradeScreencast: vi.fn(async () => true),
    stopControl: vi.fn(async () => undefined),
    startEager: vi.fn<typeof startLazyPluginServiceModule>().mockResolvedValue(null),
    startCleanup: vi.fn(() => async () => {}),
  }),
);
const upgradeArgs = [{} as IncomingMessage, {} as Duplex, Buffer.alloc(0)] as const;

vi.mock("./register.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./register.runtime.js")>()),
  stopBrowserControlService: stopControl,
}));
vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  startLazyPluginServiceModule: startEager,
}));
// mock-isolation: Lifecycle assertions must not schedule real tab sweeps.
vi.mock("./src/browser/session-tab-cleanup.js", () => ({
  startTrackedBrowserTabCleanupTimer: startCleanup,
}));
// mock-isolation: Exercise registration activity without starting real relay sockets.
vi.mock("./src/browser/extension-relay/gateway-relay-route.js", () => ({
  handleGatewayExtensionUpgrade: upgradeExtension,
}));
// mock-isolation: Exercise registration activity without creating a WebSocket server.
vi.mock("./src/browser/screencast/upgrade.js", () => ({
  handleBrowserScreencastUpgrade: upgradeScreencast,
}));
vi.mock("./src/browser/session-tab-store.js", () => ({
  initializeBrowserSessionTabStore: vi.fn(),
  drainBrowserSessionTabStore: vi.fn(async () => undefined),
}));
vi.mock("./src/browser/system-profile-import-state.js", () => ({
  configureSystemProfileImportStateStore: vi.fn(),
}));

function registerLifecycle(eager = false, path = "/browser/screencast") {
  if (eager) {
    vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", "1");
  }
  const api = createTestPluginApi({
    runtime: { state: { openKeyedStore: vi.fn() } } as never,
    registerHttpRoute: vi.fn(),
    registerService: vi.fn(),
  });
  registerBrowserPlugin(api);
  const route = vi.mocked(api.registerHttpRoute).mock.calls.findLast(([r]) => r.path === path)?.[0];
  const service = vi.mocked(api.registerService).mock.calls.at(-1)?.[0];
  if (!route?.handleUpgrade || !service?.stop) {
    throw new Error("expected browser relay route and service lifecycle");
  }
  const scheduler = createTestPluginServiceScheduler();
  const context = { config: {}, stateDir: "/tmp/browser-startup", logger: console, scheduler };
  const lifecycle = {
    handleUpgrade: route.handleUpgrade,
    start: () => service.start(context),
    stop: () => service.stop?.(context),
  };
  onTestFinished(async () => {
    try {
      await lifecycle.stop();
    } finally {
      await scheduler.stop();
    }
  });
  return lifecycle;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

it("keeps shutdown lazy until direct websocket activity prepares teardown", async () => {
  await registerLifecycle().stop();
  expect(stopControl).not.toHaveBeenCalled();
  for (const path of ["/browser/screencast", "/browser/extension"]) {
    const { handleUpgrade, stop } = registerLifecycle(false, path);
    await expect(handleUpgrade(...upgradeArgs)).resolves.toBe(true);
    await stop();
  }
  expect(upgradeScreencast).toHaveBeenCalledWith(...upgradeArgs);
  expect(upgradeExtension).toHaveBeenCalledWith(...upgradeArgs);
  expect(stopControl).toHaveBeenCalledTimes(2);
});

it.each([true, false])("gates cleanup on eager success=%s", async (success) => {
  const entered = createDeferred<void>();
  const ready = createDeferred<void>();
  startEager.mockImplementationOnce(async () => {
    entered.resolve();
    await ready.promise;
    return null;
  });
  const lifecycle = registerLifecycle(true);
  const settled = Promise.resolve(lifecycle.start()).catch((error: unknown) => error);
  const failure = new Error("eager startup failed");
  try {
    await entered.promise;
    expect(startCleanup).not.toHaveBeenCalled();
  } finally {
    if (success) {
      ready.resolve();
    } else {
      ready.reject(failure);
    }
    await settled;
    await lifecycle.stop();
  }
  expect(await settled).toBe(success ? undefined : failure);
  expect(startCleanup).toHaveBeenCalledTimes(success ? 1 : 0);
});

it("validates eager browser override specifiers", async () => {
  await registerLifecycle(true).start();
  const validate = startEager.mock.lastCall?.[0].validateOverrideSpecifier;
  expect(validate?.(" ./server.js ")).toBe("./server.js");
  const unsafe = ["data:text/javascript,boom", "HTTPS://example.invalid/mod.mjs", "node:fs"];
  for (const specifier of unsafe) {
    expect(() => validate?.(specifier)).toThrow(
      "Refusing unsafe browser control override specifier",
    );
  }
});

it.each([true, false])("retries failed cleanup (eager=%s)", async (eager) => {
  const stop = eager ? vi.fn(async () => undefined) : stopControl;
  stop.mockRejectedValueOnce(new Error("cleanup failed"));
  const lifecycle = registerLifecycle(eager);
  if (eager) {
    startEager.mockResolvedValueOnce({ stop });
    await lifecycle.start();
  } else {
    await lifecycle.handleUpgrade(...upgradeArgs);
  }
  await expect(lifecycle.stop()).rejects.toThrow("cleanup failed");
  await expect(lifecycle.stop()).resolves.toBeUndefined();
  expect(stop).toHaveBeenCalledTimes(2);
  if (eager) {
    expect(stopControl).not.toHaveBeenCalled();
  }
});
