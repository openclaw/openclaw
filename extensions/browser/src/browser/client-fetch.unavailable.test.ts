import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import "../test-support/browser-security.mock.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn<() => OpenClawConfig>(() => ({})),
  sourceConfig: null as OpenClawConfig | null,
  pluginRecord: undefined as
    | {
        id: string;
        status: "disabled" | "error" | "loaded";
        activationReason?: string;
        error?: string;
        failurePhase?: "validation" | "load" | "register";
      }
    | undefined,
  startBrowserControlServiceFromConfig: vi.fn<() => Promise<null>>(async () => null),
  dispatch: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: mocks.loadConfig,
  getRuntimeConfigSourceSnapshot: () => mocks.sourceConfig,
}));
vi.mock("../control-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../control-service.js")>()),
  createBrowserControlContext: vi.fn(() => ({})),
  startBrowserControlServiceFromConfig: mocks.startBrowserControlServiceFromConfig,
}));
vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: () => ({ dispatch: mocks.dispatch }),
}));
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({
    pluginRegistry: { plugins: mocks.pluginRecord ? [mocks.pluginRecord] : [] },
  }),
}));

const { fetchBrowserJson } = await import("./client-fetch.js");

async function expectThrownBrowserFetchError(
  request: () => Promise<unknown>,
  expected: { contains: string[]; omits: string[] },
) {
  const result = await request().catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  if (!(result instanceof Error)) {
    throw new Error("Expected browser control refusal");
  }
  for (const text of expected.contains) {
    expect(result.message).toContain(text);
  }
  for (const text of expected.omits) {
    expect(result.message).not.toContain(text);
  }
}

describe("browser control availability diagnostics", () => {
  beforeEach(() => {
    mocks.loadConfig.mockReset().mockReturnValue({});
    mocks.sourceConfig = null;
    mocks.pluginRecord = undefined;
    mocks.startBrowserControlServiceFromConfig.mockReset().mockResolvedValue(null);
    mocks.dispatch.mockReset();
  });

  it.each([
    {
      name: "allowlist exclusion",
      config: { plugins: { allow: ["telegram"] } },
      contains: ['"browser" is not in plugins.allow', "Add", "openclaw plugins enable browser"],
    },
    {
      name: "global plugin disablement",
      config: { plugins: { enabled: false } },
      contains: [
        "plugins.enabled=false",
        "plugins.enabled=true",
        "openclaw plugins enable browser",
      ],
    },
    {
      name: "plugin denylist",
      config: { plugins: { deny: ["browser"] } },
      contains: ["plugins.deny", "Remove", "openclaw plugins enable browser"],
    },
    {
      name: "explicit plugin disablement",
      config: { plugins: { entries: { browser: { enabled: false } } } },
      contains: ["plugins.entries.browser.enabled=false", "openclaw plugins enable browser"],
    },
    {
      name: "browser config disablement",
      config: { browser: { enabled: false } },
      contains: ["browser.enabled=false", "browser.enabled=true"],
    },
    {
      name: "unrecorded availability",
      config: {},
      contains: ["openclaw doctor"],
    },
  ])("explains $name at the local dispatch boundary", async ({ config, contains }) => {
    mocks.loadConfig.mockReturnValue(config);
    mocks.startBrowserControlServiceFromConfig.mockResolvedValueOnce(null);

    await expectThrownBrowserFetchError(() => fetchBrowserJson("/tabs"), {
      contains,
      omits: ["Restart", "not installed", "not yet loaded"],
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("explains the source policy that refused startup despite runtime auto-enable", async () => {
    mocks.loadConfig.mockReturnValue({ plugins: { allow: ["browser"] } });
    mocks.sourceConfig = { plugins: { allow: ["telegram"] } };
    mocks.startBrowserControlServiceFromConfig.mockResolvedValueOnce(null);

    await expectThrownBrowserFetchError(() => fetchBrowserJson("/tabs"), {
      contains: ['"browser" is not in plugins.allow', "openclaw plugins enable browser"],
      omits: ["Restart"],
    });
  });

  it.each([
    { status: "error", failurePhase: "load", error: "Cannot find module browser-driver" },
    { status: "error", failurePhase: "register", error: "registration timed out" },
    { status: "error", error: "plugin not installed: browser" },
    { status: "disabled", activationReason: "capability consent required" },
  ] as const)("preserves recorded $status refusal details", async (record) => {
    mocks.pluginRecord = { id: "browser", ...record };
    mocks.startBrowserControlServiceFromConfig.mockResolvedValueOnce(null);

    await expectThrownBrowserFetchError(() => fetchBrowserJson("/tabs"), {
      contains: [
        record.status === "error" ? record.error : record.activationReason,
        "openclaw doctor",
        "Do NOT retry the browser tool",
      ],
      omits: ["Restart", "Retry the browser tool once"],
    });
  });
});
