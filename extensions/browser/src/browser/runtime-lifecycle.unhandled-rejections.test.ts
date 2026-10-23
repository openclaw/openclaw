import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const start = () =>
  createBrowserRuntimeState({ resolved: makeBrowserServerState().resolved, port: 18791 });
const stop = (current: Awaited<ReturnType<typeof start>>, clearState = vi.fn()) =>
  stopBrowserRuntime({ current, clearState, onWarn: vi.fn() });
const dialogRace = () =>
  new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing");

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

it.each([false, true])(
  "closes after installation rotation without loading relay code (relay acquired: %s)",
  async (acquired) => {
    const state = await start();
    if (acquired) {
      await getGatewayExtensionRelayModule();
    }
    relay.artifactsAvailable = false;
    const clearState = vi.fn();

    await stop(state, clearState);

    expect(clearState).toHaveBeenCalledOnce();
    expect(relay.dispose).toHaveBeenCalledTimes(acquired ? 1 : 0);
  },
);

const protocolError = (method: string, message = "No dialog is showing") =>
  Object.assign(new Error(message), { method });
it.each([
  [Object.assign(dialogRace(), { method: "Page.handleJavaScriptDialog" }), true],
  [
    new Error("browser action failed", { cause: protocolError("Page.handleJavaScriptDialog") }),
    true,
  ],
  [
    { error: new Error("Protocol error (Dialog.handleJavaScriptDialog): No dialog is showing") },
    true,
  ],
  [protocolError("Page.navigate"), false],
  [new Error("Protocol error (Page.handleJavaScriptDialog): Target closed"), false],
  [new Error("No dialog is showing"), false],
] as const)("classifies Playwright rejection %#", async (error, handled) => {
  const state = await start();
  expect(getUnhandledRejectionHandlers()[0]?.(error)).toBe(handled);
  await stop(state);
});

it("registers during startup and unregisters during shutdown", async () => {
  stopKnownBrowserProfilesMock.mockImplementationOnce(async () => {
    expect(getUnhandledRejectionHandlers()).toHaveLength(1);
  });
  const state = await start();

  expect(registerUnhandledRejectionHandlerMock).toHaveBeenCalledTimes(1);
  expect(getUnhandledRejectionHandlers()).toHaveLength(1);
  expect(getUnhandledRejectionHandlers()[0]?.(dialogRace())).toBe(true);

  const clearState = vi.fn();
  await stop(state, clearState);

  expect(stopKnownBrowserProfilesMock).toHaveBeenCalledTimes(1);
  expect(clearState).toHaveBeenCalledTimes(1);
  expect(getUnhandledRejectionHandlers()).toStrictEqual([]);
});
