import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureBrowserControlAuth: vi.fn(async () => ({ generatedToken: false })),
  createBrowserRuntimeState: vi.fn(async () => ({ ok: true })),
  loadConfig: vi.fn(() => ({
    browser: {
      enabled: true,
    },
    plugins: {
      entries: {
        browser: {
          enabled: false,
        },
      },
    },
  })),
}));

vi.mock("openclaw/plugin-sdk/browser-support", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/browser-support")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("./config.js", () => ({
  resolveBrowserConfig: vi.fn(() => ({
    enabled: true,
    controlPort: 18791,
    profiles: { openclaw: { cdpPort: 18800 } },
  })),
}));

vi.mock("./control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
}));

vi.mock("./runtime-lifecycle.js", () => ({
  createBrowserRuntimeState: mocks.createBrowserRuntimeState,
  stopBrowserRuntime: vi.fn(async () => {}),
}));

let startBrowserControlServiceFromConfig: typeof import("../control-service.js").startBrowserControlServiceFromConfig;

describe("startBrowserControlServiceFromConfig", () => {
  beforeEach(async () => {
    mocks.ensureBrowserControlAuth.mockClear();
    mocks.createBrowserRuntimeState.mockClear();
    mocks.loadConfig.mockClear();
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
