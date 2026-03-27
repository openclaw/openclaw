import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureBrowserControlAuth: vi.fn(async () => ({ generatedToken: false })),
  createBrowserRuntimeState: vi.fn(async () => ({ ok: true })),
  isDefaultBrowserPluginEnabled: vi.fn(() => false),
}));

vi.mock("./control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
}));

vi.mock("./runtime-lifecycle.js", () => ({
  createBrowserRuntimeState: mocks.createBrowserRuntimeState,
  stopBrowserRuntime: vi.fn(async () => {}),
}));

let startBrowserControlServiceFromConfig: typeof import("../control-service.js").startBrowserControlServiceFromConfig;

vi.mock("../plugin-enabled.js", () => ({
  isDefaultBrowserPluginEnabled: mocks.isDefaultBrowserPluginEnabled,
}));

describe("startBrowserControlServiceFromConfig", () => {
  beforeEach(async () => {
    mocks.ensureBrowserControlAuth.mockClear();
    mocks.createBrowserRuntimeState.mockClear();
    mocks.isDefaultBrowserPluginEnabled.mockClear();
    vi.resetModules();
    ({ startBrowserControlServiceFromConfig } = await import("../control-service.js"));
  });

  it("does not start the default service when the browser plugin is disabled", async () => {
    const started = await startBrowserControlServiceFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureBrowserControlAuth).not.toHaveBeenCalled();
    expect(mocks.createBrowserRuntimeState).not.toHaveBeenCalled();
  });
});
