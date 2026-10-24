import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import {
  chromeProductRoots,
  installStableChromeExtension,
  installChromeExtensionBootstrap,
} from "./extension-install-fixture.test-support.js";
import {
  predictedId,
  useExtensionInstallFixture,
  useNativeHostLaunchFixture,
  writeChromePreferences,
} from "./extension-install.test-support.js";

const fixture = useExtensionInstallFixture();
const nativeHostFixture = useNativeHostLaunchFixture();
const nonce = Buffer.alloc(16, 7).toString("base64url");
const writePrivate = (file: string, content: string, mode = 0o600) =>
  fs.writeFile(file, content, { mode });
const writeJson = (file: string, value: unknown) =>
  writePrivate(file, `${JSON.stringify(value)}\n`);

function nativeFrame(request: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(request));
  const frame = Buffer.alloc(payload.length + 4);
  frame[os.endianness() === "LE" ? "writeUInt32LE" : "writeUInt32BE"](payload.length);
  payload.copy(frame, 4);
  return frame;
}

function nativeResponse({ status, stderr, stdout }: SpawnSyncReturns<Buffer>): unknown {
  expect(status, stderr.toString("utf8")).toBe(0);
  const length = os.endianness() === "LE" ? stdout.readUInt32LE() : stdout.readUInt32BE();
  expect(stdout).toHaveLength(length + 4);
  return JSON.parse(stdout.subarray(4).toString("utf8"));
}

// POSIX launcher/CLI proof. The Windows PE/ACL/registry lane needs a real Windows host.
describe.skipIf(process.platform === "win32")("native host registration", () => {
  it("does not inspect or migrate configuration before rejecting a malformed native request", async () => {
    const value = await fixture();
    const original = "{ deliberately invalid config";
    const config = path.join(value.root, "invalid-config.json");
    await writePrivate(config, original);
    const unread = path.join(value.root, "not-read-before-framing");
    const origin = "chrome-extension://kcdjddhmeafeomebliikmbpblkmkfoig/";
    const child = spawnSync(
      process.execPath,
      [
        path.resolve("openclaw.mjs"),
        "browser",
        "extension",
        "native-host",
        "--manifest",
        unread,
        "--launcher",
        unread,
        "--expected-origin",
        origin,
        origin,
      ],
      {
        input: nativeFrame({ v: 1, op: "bootstrap", nonce: "!" }),
        timeout: 20_000,
        env: {
          HOME: value.homeDir,
          OPENCLAW_STATE_DIR: value.stateDir,
          OPENCLAW_CONFIG_PATH: config,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
      },
    );
    expect(nativeResponse(child)).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await fs.readFile(config, "utf8")).toBe(original);
    await expect(fs.stat(value.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("launches with the exact custom installation context when Chrome has no selectors", async () => {
    const value = await fixture();
    const stateDir = path.join(value.root, "custom state's dir");
    const configPath = path.join(value.root, "custom config's dir", "openclaw.json");
    const context = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath };
    const token = relayTestKey(4);
    const deps = {
      ...value.deps,
      stateDir,
      ...(await nativeHostFixture(
        value.root,
        path.resolve("dist/extensions/browser/native-host-entry.js"),
      )),
      env: { ...value.deps.env, ...context },
    };
    const install = (browserProfile?: string) =>
      installChromeExtensionBootstrap({ ...value, waitMs: 1_000, deps, browserProfile });
    await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await writePrivate(
      path.join(stateDir, "credentials", "browser-extension-relay.secret"),
      `${token}\n`,
    );
    await writeJson(configPath, {
      browser: { profiles: { e2e: { driver: "extension", cdpPort: 19_031 } } },
    });
    const installed = await installStableChromeExtension(value.bundledDir, deps);
    const chromium = chromeProductRoots(deps).find((root) => root.product === "chromium");
    if (!chromium) {
      throw new Error("missing Chromium fixture root");
    }
    const extensionId = await predictedId(installed, deps.platform);
    await writeChromePreferences({
      userDataDir: chromium.userDataDir,
      profile: "Default",
      entries: { [extensionId]: { location: 4, path: installed } },
    });
    const status = await install("e2e");
    const registration = status.registrations.find((entry) => entry.product === "chromium")!;
    expect(registration, status.issues.join("\n")).toMatchObject({ state: "owned" });
    const manifest = JSON.parse(await fs.readFile(registration.manifestPath, "utf8")) as {
      path: string;
    };

    // Documented ordinary repair must retain the canonical setup's saved profile.
    await install();
    const gatewayStatePath = path.join(stateDir, "state", "openclaw.sqlite");
    const configBefore = await fs.readFile(configPath);
    await expect(fs.stat(gatewayStatePath)).rejects.toMatchObject({ code: "ENOENT" });
    const host = spawnSync(manifest.path, [`chrome-extension://${extensionId}/`], {
      input: nativeFrame({ v: 1, op: "bootstrap", nonce }),
      env: {
        HOME: value.homeDir,
        TMPDIR: os.tmpdir(),
      },
      timeout: 20_000,
    });
    await expect(fs.stat(gatewayStatePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(configPath)).toEqual(configBefore);
    expect(nativeResponse(host)).toEqual({
      v: 1,
      ok: true,
      nonce,
      pairingString: `ws://127.0.0.1:18789/browser/extension?profile=e2e&gateway=ws%3A%2F%2F127.0.0.1%3A18789#${token}`,
    });
  });
});
