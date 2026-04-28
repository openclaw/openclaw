import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeEnvMocks = vi.hoisted(() => ({
  registerUnhandledRejectionHandler: vi.fn(),
  unregisterUnhandledRejectionHandler: vi.fn(),
}));

const lifecycleMocks = vi.hoisted(() => ({
  ensureExtensionRelayForProfiles: vi.fn(async () => {}),
  stopKnownBrowserProfiles: vi.fn(async () => {}),
  stopTrackedTabCleanup: vi.fn(),
  startTrackedBrowserTabCleanupTimer: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  registerUnhandledRejectionHandler: runtimeEnvMocks.registerUnhandledRejectionHandler,
}));

vi.mock("./server-lifecycle.js", () => ({
  ensureExtensionRelayForProfiles: lifecycleMocks.ensureExtensionRelayForProfiles,
  stopKnownBrowserProfiles: lifecycleMocks.stopKnownBrowserProfiles,
}));

vi.mock("./session-tab-cleanup.js", () => ({
  startTrackedBrowserTabCleanupTimer: lifecycleMocks.startTrackedBrowserTabCleanupTimer,
}));

vi.mock("./pw-ai-state.js", () => ({
  isPwAiLoaded: () => false,
}));

vi.mock("./pw-ai-module.js", () => ({
  getPwAiModule: vi.fn(),
}));

const { createBrowserRuntimeState, stopBrowserRuntime } = await import("./runtime-lifecycle.js");

beforeEach(() => {
  runtimeEnvMocks.registerUnhandledRejectionHandler.mockReset();
  runtimeEnvMocks.unregisterUnhandledRejectionHandler.mockReset();
  runtimeEnvMocks.registerUnhandledRejectionHandler.mockReturnValue(
    runtimeEnvMocks.unregisterUnhandledRejectionHandler,
  );
  lifecycleMocks.ensureExtensionRelayForProfiles.mockClear();
  lifecycleMocks.stopKnownBrowserProfiles.mockClear();
  lifecycleMocks.stopTrackedTabCleanup.mockClear();
  lifecycleMocks.startTrackedBrowserTabCleanupTimer.mockReset();
  lifecycleMocks.startTrackedBrowserTabCleanupTimer.mockReturnValue(
    lifecycleMocks.stopTrackedTabCleanup,
  );
});

describe("browser runtime unhandled-rejection handling", () => {
  it("registers a browser-owned Playwright dialog race handler and unregisters on stop", async () => {
    const state = await createBrowserRuntimeState({
      resolved: { profiles: {} } as never,
      port: 18791,
      onWarn: vi.fn(),
    });

    expect(runtimeEnvMocks.registerUnhandledRejectionHandler).toHaveBeenCalledTimes(1);
    const handler = runtimeEnvMocks.registerUnhandledRejectionHandler.mock.calls[0]?.[0];
    expect(typeof handler).toBe("function");

    const handlesUnhandledRejection = handler as ((reason: unknown) => boolean) | undefined;
    const dialogRaceError = new Error(
      "Protocol error (Page.handleJavaScriptDialog): No dialog is showing",
    );

    for (const reason of [
      dialogRaceError,
      { cause: dialogRaceError },
      { reason: dialogRaceError },
      { original: dialogRaceError },
      { error: dialogRaceError },
      { data: dialogRaceError },
      { errors: [dialogRaceError] },
    ]) {
      expect(handlesUnhandledRejection?.(reason)).toBe(true);
    }

    expect(handler?.(new Error("No dialog is showing"))).toBe(false);
    expect(
      handlesUnhandledRejection?.(
        new Error("Page.handleJavaScriptDialog rejected because no dialog is showing"),
      ),
    ).toBe(false);

    const clearState = vi.fn();
    await stopBrowserRuntime({
      current: state,
      getState: () => state,
      clearState,
      onWarn: vi.fn(),
    });

    expect(runtimeEnvMocks.unregisterUnhandledRejectionHandler).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.stopTrackedTabCleanup).toHaveBeenCalledTimes(1);
    expect(clearState).toHaveBeenCalledTimes(1);
  });
});
