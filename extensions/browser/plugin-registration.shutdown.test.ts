import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "./plugin-registration.js";

const runtimeMocks = vi.hoisted(() => ({
  hasBrowserNodeHostWork: vi.fn(() => false),
  handleGatewayExtensionUpgrade: vi.fn(async () => true),
  handleBrowserScreencastUpgrade: vi.fn(async () => true),
  stopBrowserControlService: vi.fn(async () => undefined),
  startBrowserControlService: vi.fn(async () => {}),
  startTabCleanup: vi.fn(() => async () => {}),
}));

vi.mock("./register.runtime.js", () => ({
  hasBrowserNodeHostWork: runtimeMocks.hasBrowserNodeHostWork,
  stopBrowserControlService: runtimeMocks.stopBrowserControlService,
  createBrowserPluginService: () => ({
    id: "browser-control",
    start: runtimeMocks.startBrowserControlService,
    stop: runtimeMocks.stopBrowserControlService,
  }),
}));

vi.mock("./src/browser/session-tab-cleanup.js", () => ({
  startTrackedBrowserTabCleanupTimer: runtimeMocks.startTabCleanup,
}));

vi.mock("./src/browser/extension-relay/gateway-relay-route.js", () => ({
  handleGatewayExtensionUpgrade: runtimeMocks.handleGatewayExtensionUpgrade,
}));

vi.mock("./src/browser/screencast/upgrade.js", () => ({
  handleBrowserScreencastUpgrade: runtimeMocks.handleBrowserScreencastUpgrade,
}));

vi.mock("./src/browser/session-tab-store.js", () => ({
  initializeBrowserSessionTabStore: vi.fn(),
  drainBrowserSessionTabStore: vi.fn(async () => undefined),
}));

vi.mock("./src/browser/system-profile-import-state.js", () => ({
  configureSystemProfileImportStateStore: vi.fn(),
}));

function registerLifecycleCallbacks(path: string) {
  let route: Parameters<OpenClawPluginApi["registerHttpRoute"]>[0] | undefined;
  let service: OpenClawPluginService | undefined;
  registerBrowserPlugin(
    createTestPluginApi({
      runtime: {
        state: { openKeyedStore: vi.fn() },
      } as never,
      registerHttpRoute(value) {
        if (value.path === path) {
          route = value;
        }
      },
      registerService(value) {
        service = value;
      },
    }),
  );
  if (!route?.handleUpgrade || !service?.stop) {
    throw new Error("expected browser relay route and service lifecycle");
  }
  return { handleUpgrade: route.handleUpgrade, start: service.start, stop: service.stop };
}

describe("browser websocket shutdown registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps shutdown lazy until direct websocket activity prepares teardown", async () => {
    const coldLifecycle = registerLifecycleCallbacks("/browser/screencast");

    await coldLifecycle.stop({} as never);

    expect(runtimeMocks.stopBrowserControlService).not.toHaveBeenCalled();

    const req = {} as IncomingMessage;
    const socket = {} as Duplex;
    const head = Buffer.alloc(0);

    for (const path of ["/browser/screencast", "/browser/extension"]) {
      const { handleUpgrade, stop } = registerLifecycleCallbacks(path);
      await expect(handleUpgrade(req, socket, head)).resolves.toBe(true);
      await stop({} as never);
    }

    expect(runtimeMocks.handleBrowserScreencastUpgrade).toHaveBeenCalledWith(req, socket, head);
    expect(runtimeMocks.handleGatewayExtensionUpgrade).toHaveBeenCalledWith(req, socket, head);
    expect(runtimeMocks.stopBrowserControlService).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"] as const)(
    "admits periodic cleanup only after successful eager startup: %s",
    async (outcome) => {
      vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", "1");
      const entered = createDeferred<void>();
      const ready = createDeferred<void>();
      runtimeMocks.startBrowserControlService.mockImplementationOnce(async () => {
        entered.resolve();
        await ready.promise;
      });
      const lifecycle = registerLifecycleCallbacks("/browser/screencast");
      const context = { config: {}, stateDir: "/tmp/browser-startup", logger: console };
      const startup = lifecycle.start(context);
      const settled = Promise.resolve(startup).then(
        () => undefined,
        (error: unknown) => error,
      );
      const failure = new Error("eager startup failed");
      try {
        await entered.promise;
        expect(runtimeMocks.startTabCleanup).not.toHaveBeenCalled();
      } finally {
        if (outcome === "success") {
          ready.resolve();
        } else {
          ready.reject(failure);
        }
        await settled;
        await lifecycle.stop(context);
      }
      expect(await settled).toBe(outcome === "success" ? undefined : failure);
      expect(runtimeMocks.startTabCleanup).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
    },
  );
});
