import { createRequire } from "node:module";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { slackPlugin } from "../channel.js";
import {
  disposeSlackTestRuntime,
  getSlackHandlerOrThrow,
  getSlackTestState,
  resetSlackTestState,
  startSlackMonitor,
  stopSlackMonitor,
} from "../monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");

const PROXY_ENV_KEYS = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

function loadSocketModeEnvHttpProxyAgent(): typeof import("undici").EnvHttpProxyAgent {
  const requireFromTest = createRequire(import.meta.url);
  const requireFromBolt = createRequire(requireFromTest.resolve("@slack/bolt/package.json"));
  const requireFromSocketMode = createRequire(
    requireFromBolt.resolve("@slack/socket-mode/package.json"),
  );
  return (requireFromSocketMode("undici") as typeof import("undici")).EnvHttpProxyAgent;
}

beforeEach(async () => {
  await resetSlackTestState();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackPlugin }]),
  );
});

afterEach(async () => {
  try {
    await resetSlackTestState();
  } finally {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  }
});

afterAll(() => {
  disposeSlackTestRuntime();
});

it("hands Socket Mode a dispatcher from its own undici copy", async () => {
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("HTTPS_PROXY", "http://proxy.example.com:3128");

  const monitor = startSlackMonitor(monitorSlackProvider);
  try {
    await getSlackHandlerOrThrow("message");
    expect(getSlackTestState().socketModeReceiverArgs?.dispatcher).toBeInstanceOf(
      loadSocketModeEnvHttpProxyAgent(),
    );
  } finally {
    await stopSlackMonitor(monitor);
  }
});
