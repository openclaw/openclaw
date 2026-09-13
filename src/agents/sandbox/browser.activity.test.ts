import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildBrowserTestConfig } from "./browser.create.test-helpers.js";

const { startBridge } = vi.hoisted(() => ({
  startBridge:
    vi.fn<typeof import("../../plugin-sdk/browser-bridge.js").startBrowserBridgeServer>(),
}));
vi.mock("../../plugin-sdk/browser-bridge.js", () => ({
  startBrowserBridgeServer: startBridge,
  stopBrowserBridgeServer: vi.fn(),
}));
vi.mock("../../plugin-sdk/browser-profiles.js", () => ({
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS: 60_000,
  DEFAULT_BROWSER_EVALUATE_ENABLED: true,
  DEFAULT_OPENCLAW_BROWSER_COLOR: "#FF4500",
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME: "openclaw",
  resolveProfile: (
    resolved: import("../../plugin-sdk/browser-types.js").ResolvedBrowserConfig,
    name: string,
  ) => resolved.profiles[name] ?? null,
}));
vi.mock("./docker.js", async () => ({
  resolveDockerEnvPolicyEpoch: (await import("./sanitize-env-vars.js")).resolveDockerEnvPolicyEpoch,
  dockerContainerState: async () => ({ exists: true, running: true }),
  readDockerContainerEnvVar: async () => "test-browser-relay-secret",
  readDockerContainerLabel: async () => "existing-browser-config",
  readDockerPort: async (_name: string, port: number) => (port === 9222 ? 49100 : 49101),
  execDocker: () => {
    throw new Error("Existing hot browser must not be recreated");
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
let server: Server;

beforeEach(async () => {
  vi.resetModules();
  stateDir = tempDirs.make("openclaw-browser-activity-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  startBridge.mockImplementation(async ({ resolved }) => ({
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    state: { resolved },
  }));
});

afterEach(async () => {
  const { closeOpenClawStateDatabaseForTest } = await import("../../state/openclaw-state-db.js");
  closeOpenClawStateDatabaseForTest();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  vi.unstubAllEnvs();
});

it("keeps a reused CDP bridge authorized when noVNC is disabled, but rejects a replacement", async () => {
  const { ensureSandboxBrowser } = await import("./browser.js");
  const { buildSandboxContainerName, slugifySessionKey } = await import("./shared.js");
  const { readBrowserRegistryEntry, removeBrowserRegistryEntry, updateBrowserRegistry } =
    await import("./registry.js");
  const cfg = buildBrowserTestConfig(true);
  const scopeKey = "agent:main:browser-activity";
  const containerName = buildSandboxContainerName(
    cfg.browser.containerPrefix,
    slugifySessionKey(scopeKey),
  );
  const entry = {
    containerName,
    sessionKey: scopeKey,
    createdAtMs: Date.now() - 60_000,
    lastUsedAtMs: Date.now(),
    image: cfg.browser.image,
    configHash: "existing-browser-config",
    cdpPort: 49100,
    noVncPort: 49101,
  };
  await updateBrowserRegistry(entry);
  const params = {
    scopeKey,
    workspaceDir: stateDir,
    agentWorkspaceDir: stateDir,
    cfg,
    bridgeAuth: { token: "test-bridge-token" },
  };
  const initial = await ensureSandboxBrowser(params);
  const acquire = startBridge.mock.calls[0]?.[0].acquireRequestActivity;
  if (!acquire) {
    throw new Error("Browser must register request activity admission");
  }
  const initialLease = await acquire();
  expect(initialLease).not.toBeNull();
  await initialLease?.release();

  cfg.browser.noVncEnabled = false;
  const reused = await ensureSandboxBrowser(params);
  expect(reused?.bridgeUrl).toBe(initial?.bridgeUrl);
  expect(reused?.noVncUrl).toBeUndefined();
  expect(startBridge).toHaveBeenCalledOnce();
  expect((await readBrowserRegistryEntry(containerName))?.noVncPort).toBeUndefined();
  const reusedLease = await acquire();
  expect(reusedLease).not.toBeNull();
  await reusedLease?.release();

  await removeBrowserRegistryEntry(containerName);
  await updateBrowserRegistry({ ...entry, createdAtMs: entry.createdAtMs + 1 });
  await expect(acquire()).rejects.toThrow("was recycled");
});
