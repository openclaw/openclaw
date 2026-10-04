// Browser tests cover runtime lifecycle.unhandled rejections plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeBrowserServerState } from "./server-context.test-harness.js";

const relay = vi.hoisted(() => ({
  artifactsAvailable: true,
  dispose: vi.fn(),
}));

vi.mock("./extension-relay/gateway-relay-route.js", () => {
  if (!relay.artifactsAvailable) {
    throw new Error("installed Gateway extension relay chunk was removed");
  }
  return { disposeGatewayExtensionRelay: relay.dispose };
});

const { getUnhandledRejectionHandlers, registerUnhandledRejectionHandlerMock, resetHandlers } =
  vi.hoisted(() => {
    let handlers: Array<(reason: unknown) => boolean> = [];
    return {
      getUnhandledRejectionHandlers: () => handlers,
      registerUnhandledRejectionHandlerMock: vi.fn((handler: (reason: unknown) => boolean) => {
        handlers.push(handler);
        return () => {
          handlers = handlers.filter((candidate) => candidate !== handler);
        };
      }),
      resetHandlers: () => {
        handlers = [];
      },
    };
  });

const stopKnownBrowserProfilesMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  registerUnhandledRejectionHandler: registerUnhandledRejectionHandlerMock,
}));

vi.mock("./server-lifecycle.js", () => ({
  stopKnownBrowserProfiles: stopKnownBrowserProfilesMock,
}));

const { createBrowserRuntimeState, stopBrowserRuntime } = await import("./runtime-lifecycle.js");
const { getGatewayExtensionRelayModule } = await import("./extension-relay.runtime.js");

beforeEach(() => {
  getGatewayExtensionRelayModule.clear();
  resetHandlers();
  registerUnhandledRejectionHandlerMock.mockClear();
  stopKnownBrowserProfilesMock.mockClear();
  relay.dispose.mockClear();
});

afterEach(() => {
  relay.artifactsAvailable = true;
});

describe("browser unhandled rejection lifecycle", () => {
  it.each([false, true])(
    "closes after installation rotation without loading relay code (relay acquired: %s)",
    async (acquired) => {
      const state = await createBrowserRuntimeState({
        resolved: makeBrowserServerState().resolved,
        port: 18791,
      });
      if (acquired) {
        await getGatewayExtensionRelayModule();
      }
      relay.artifactsAvailable = false;
      const clearState = vi.fn();

      await stopBrowserRuntime({
        current: state,
        getState: () => state,
        clearState,
        onWarn: vi.fn(),
      });

      expect(clearState).toHaveBeenCalledOnce();
      expect(relay.dispose).toHaveBeenCalledTimes(acquired ? 1 : 0);
    },
  );

  it("matches direct and nested Playwright dialog-race protocol errors", async () => {
    const state = await createBrowserRuntimeState({
      resolved: { profiles: {} } as never,
      port: 18791,
    });
    const handler = getUnhandledRejectionHandlers()[0];
    const direct = Object.assign(
      new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing"),
      { method: "Page.handleJavaScriptDialog" },
    );
    const nested = new Error("browser action failed", {
      cause: Object.assign(new Error("No dialog is showing"), {
        method: "Page.handleJavaScriptDialog",
      }),
    });
    const wrapped = {
      error: new Error("Protocol error (Dialog.handleJavaScriptDialog): No dialog is showing"),
    };

    expect(handler?.(direct)).toBe(true);
    expect(handler?.(nested)).toBe(true);
    expect(handler?.(wrapped)).toBe(true);
    await stopBrowserRuntime({
      current: state,
      getState: () => state,
      clearState: vi.fn(),
      onWarn: vi.fn(),
    });
  });

  it("keeps non-dialog and non-race Playwright errors unhandled", async () => {
    const state = await createBrowserRuntimeState({
      resolved: { profiles: {} } as never,
      port: 18791,
    });
    const handler = getUnhandledRejectionHandlers()[0];
    expect(
      handler?.(Object.assign(new Error("No dialog is showing"), { method: "Page.navigate" })),
    ).toBe(false);
    expect(
      handler?.(new Error("Protocol error (Page.handleJavaScriptDialog): Target closed")),
    ).toBe(false);
    expect(handler?.(new Error("No dialog is showing"))).toBe(false);
    await stopBrowserRuntime({
      current: state,
      getState: () => state,
      clearState: vi.fn(),
      onWarn: vi.fn(),
    });
  });

  it("registers during startup and unregisters during shutdown", async () => {
    stopKnownBrowserProfilesMock.mockImplementationOnce(async () => {
      expect(getUnhandledRejectionHandlers()).toHaveLength(1);
    });
    const state = await createBrowserRuntimeState({
      resolved: { profiles: {} } as never,
      port: 18791,
    });

    expect(registerUnhandledRejectionHandlerMock).toHaveBeenCalledTimes(1);
    expect(getUnhandledRejectionHandlers()).toHaveLength(1);
    expect(
      getUnhandledRejectionHandlers()[0]?.(
        new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing"),
      ),
    ).toBe(true);

    const clearState = vi.fn();
    await stopBrowserRuntime({
      current: state,
      getState: () => state,
      clearState,
      onWarn: vi.fn(),
    });

    expect(stopKnownBrowserProfilesMock).toHaveBeenCalledTimes(1);
    expect(clearState).toHaveBeenCalledTimes(1);
    expect(getUnhandledRejectionHandlers()).toStrictEqual([]);
  });
});
