import assert from "node:assert/strict";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRecord } from "openclaw/plugin-sdk/plugin-test-runtime";
import "../test-support/browser-security.mock.js";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn<() => OpenClawConfig>(() => ({})),
  sourceConfig: null as OpenClawConfig | null,
  pluginRecord: undefined as
    | Pick<PluginRecord, "id" | "status" | "activationReason" | "error" | "failurePhase">
    | undefined,
  startBrowserControlServiceFromConfig: vi.fn<() => Promise<null>>(async () => null),
  dispatch: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: mocks.loadConfig,
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
  contains: string[],
  omits = ["Restart", "not installed", "not yet loaded"],
) {
  const result = await fetchBrowserJson("/tabs").catch((error: unknown) => error);
  assert(result instanceof Error, "Expected browser control refusal");
  for (const text of contains) {
    expect(result.message).toContain(text);
  }
  for (const text of omits) {
    expect(result.message).not.toContain(text);
  }
}

beforeEach(() => {
  mocks.loadConfig.mockReset().mockReturnValue({});
  mocks.sourceConfig = null;
  mocks.pluginRecord = undefined;
  mocks.startBrowserControlServiceFromConfig.mockReset().mockResolvedValue(null);
  mocks.dispatch.mockReset();
});

it.each([
  [
    { plugins: { enabled: false } },
    ["plugins.enabled=false", "plugins.enabled=true", "openclaw plugins enable browser"],
  ],
  [
    { plugins: { deny: ["browser"] } },
    ["plugins.deny", "Remove", "openclaw plugins enable browser"],
  ],
  [
    { plugins: { entries: { browser: { enabled: false } } } },
    ["plugins.entries.browser.enabled=false", "openclaw plugins enable browser"],
  ],
  [{ browser: { enabled: false } }, ["browser.enabled=false", "browser.enabled=true"]],
  [{}, ["openclaw doctor"]],
] satisfies [OpenClawConfig, string[]][])(
  "explains unavailable config %j at the local dispatch boundary",
  async (config, contains) => {
    mocks.loadConfig.mockReturnValue(config);

    await expectThrownBrowserFetchError(contains);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  },
);

it("explains the source policy that refused startup despite runtime auto-enable", async () => {
  mocks.loadConfig.mockReturnValue({ plugins: { allow: ["browser"] } });
  mocks.sourceConfig = { plugins: { allow: ["telegram"] } };

  await expectThrownBrowserFetchError([
    '"browser" is not in plugins.allow',
    "Add",
    "openclaw plugins enable browser",
  ]);
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it.each([
  { status: "error", failurePhase: "register", error: "registration timed out" },
  { status: "error", error: "plugin not installed: browser" },
  { status: "disabled", activationReason: "capability consent required" },
] as const)("preserves recorded $status refusal details", async (record) => {
  mocks.pluginRecord = { id: "browser", ...record };

  await expectThrownBrowserFetchError(
    [
      record.status === "error" ? record.error : record.activationReason,
      "openclaw doctor",
      "Do NOT retry the browser tool",
    ],
    ["Restart", "Retry the browser tool once"],
  );
});
