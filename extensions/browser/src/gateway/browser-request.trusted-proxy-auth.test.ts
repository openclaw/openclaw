// Starting Browser control under trusted-proxy auth must not write Gateway auth config.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeRequest } from "./browser-request.test-support.js";

// mock-isolation: these tests start Browser control, not a Chrome process.
vi.mock("../browser/chrome.js", () => ({
  diagnoseChromeCdp: vi.fn(async () => ({ ok: false })),
  formatChromeCdpDiagnostic: vi.fn(() => "not reachable"),
  isChromeCdpReady: vi.fn(async () => false),
  isChromeReachable: vi.fn(async () => false),
  launchOpenClawChrome: vi.fn(async () => {
    throw new Error("launch should not be needed for status");
  }),
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw-browser"),
  stopOpenClawChrome: vi.fn(async () => {}),
}));

const { browserHandlers } = await import("./browser-request.js");
const { stopBrowserControlService } = await import("../control-service.js");
const { startBrowserControlServerFromConfig, stopBrowserControlServer } =
  await import("../server.js");
const { getBridgeAuthForPort } = await import("../browser/bridge-auth-registry.js");
const { captureRuntimeConfigAsyncReader, clearConfigCache, clearRuntimeConfigSnapshot } =
  await import("openclaw/plugin-sdk/runtime-config-snapshot");

let root = "";
let configPath = "";
let gatewayPort = 0;

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

function writeTrustedProxyConfig() {
  const config = {
    gateway: {
      mode: "local",
      port: gatewayPort,
      trustedProxies: ["127.0.0.1"],
      auth: {
        mode: "trusted-proxy",
        trustedProxy: { userHeader: "x-forwarded-user", allowLoopback: true },
      },
    },
    browser: { enabled: true, defaultProfile: "openclaw" },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function configFiles() {
  return fs.readdirSync(path.dirname(configPath)).filter((name) => name.includes("openclaw"));
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-browser-tp-")));
  configPath = path.join(root, "config", "openclaw.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // Browser control derives its port from the Gateway port (+2); keep both free.
  gatewayPort = (await freePort()) - 2;
  writeTrustedProxyConfig();
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  // Credential bootstrap is skipped under test environments; exercise the production path.
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VITEST", "0");
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  // The Gateway prepares its runtime snapshot from the config file at startup.
  await captureRuntimeConfigAsyncReader()();
});

afterEach(async () => {
  await stopBrowserControlService();
  await stopBrowserControlServer();
  vi.unstubAllEnvs();
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  fs.rmSync(root, { recursive: true, force: true });
});

it("lazily starts Browser control on the first request without writing Gateway auth", async () => {
  const before = fs.readFileSync(configPath, "utf8");
  const filesBefore = configFiles();
  const respond = vi.fn();

  await browserHandlers["browser.request"](
    makeRequest({ method: "GET", path: "/", query: { profile: "openclaw" } }, { respond }),
  );

  const [ok, result] = expectDefined(respond.mock.calls[0], "browser response");
  expect(ok).toBe(true);
  expect(result).toMatchObject({ enabled: true, profile: "openclaw" });
  expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  expect(configFiles()).toEqual(filesBefore);
});

it("authenticates the HTTP listener with a process-local password instead of gateway.auth.password", async () => {
  const before = fs.readFileSync(configPath, "utf8");

  const state = await startBrowserControlServerFromConfig();

  const port = expectDefined(state?.port, "browser control port");
  const auth = expectDefined(getBridgeAuthForPort(port), "listener credential");
  expect(auth.token).toBeUndefined();
  expect(auth.password).toMatch(/^[a-f0-9]{48}$/);
  const url = `http://127.0.0.1:${port}/?profile=openclaw`;
  expect((await fetch(url)).status).toBe(401);
  const authorized = await fetch(url, {
    headers: { "x-openclaw-password": expectDefined(auth.password, "password") },
  });
  expect(authorized.status).toBe(200);
  expect(await authorized.json()).toMatchObject({ enabled: true, profile: "openclaw" });
  expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  expect(before).not.toContain("password");
});
