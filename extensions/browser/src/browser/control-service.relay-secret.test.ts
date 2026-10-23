// Browser control must keep serving when the host-local extension relay secret is unusable.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({ browser: { enabled: true } }));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return { ...actual, captureRuntimeConfigAsyncReader: () => async () => cfg };
});
// mock-isolation: runtime refresh reads the operator's on-disk config instead of this fixture.
vi.mock("./config-refresh-source.js", () => ({ loadBrowserConfigForRuntimeRefresh: () => cfg }));
// mock-isolation: browser auth bootstrap persists a generated Gateway token to config.
vi.mock("./control-auth.js", () => ({
  ensureBrowserControlAuth: async () => ({ generatedToken: false }),
}));

const { startBrowserControlServiceFromConfig, stopBrowserControlService } =
  await import("../control-service.js");
const { resolveProfile } = await import("./config.js");
const { ensureExtensionRelayForProfile } = await import("./extension-relay/relay-lifecycle.js");

const MALFORMED = "not-a-relay-token\n";
let stateDir = "";
let secretPath = "";

beforeEach(() => {
  stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-relay-service-")));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  fs.mkdirSync(path.join(stateDir, "credentials"), { mode: 0o700 });
  secretPath = path.join(stateDir, "credentials", "browser-extension-relay.secret");
  fs.writeFileSync(secretPath, MALFORMED, { mode: 0o600 });
});

afterEach(async () => {
  await stopBrowserControlService();
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

it("starts Browser control and fails only the extension profile on a malformed relay secret", async () => {
  const state = await startBrowserControlServiceFromConfig();
  if (!state) {
    throw new Error("expected Browser control to start");
  }
  expect(resolveProfile(state.resolved, "openclaw")?.driver).not.toBe("extension");
  expect(state.extensionRelays?.has("chrome") ?? false).toBe(false);

  const chrome = resolveProfile(state.resolved, "chrome");
  if (!chrome) {
    throw new Error("expected the built-in extension profile");
  }
  await expect(ensureExtensionRelayForProfile(state, chrome)).rejects.toThrow(
    `Browser extension relay secret ${secretPath} does not contain a 64-character lowercase hex token.`,
  );
  expect(fs.readFileSync(secretPath, "utf8")).toBe(MALFORMED);
});
