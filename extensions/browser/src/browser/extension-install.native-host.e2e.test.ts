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

const BUILT_NATIVE_HOST_PATH = path.resolve("dist/extensions/browser/native-host-entry.js");
const fixture = useExtensionInstallFixture();
const nativeHostFixture = useNativeHostLaunchFixture();
const origin = "chrome-extension://kcdjddhmeafeomebliikmbpblkmkfoig/";
const nonce = Buffer.alloc(16, 7).toString("base64url");
const writePrivate = (file: string, content: string, mode = 0o600) =>
  fs.writeFile(file, content, { mode });
const writeJson = (file: string, value: unknown) =>
  writePrivate(file, `${JSON.stringify(value)}\n`);
const extensionArgs = (...args: string[]) => [
  path.resolve("openclaw.mjs"),
  "browser",
  "extension",
  ...args,
];

async function cliFixture(configText = "{ invalid config") {
  const value = await fixture();
  const config = path.join(value.root, "invalid-config.json");
  await writePrivate(config, configText);
  return {
    ...value,
    config,
    invoke: (args: string[], request?: unknown) =>
      spawnSync(process.execPath, args, {
        input: request === undefined ? undefined : nativeFrame(request),
        timeout: 20_000,
        env: {
          HOME: value.homeDir,
          OPENCLAW_STATE_DIR: value.stateDir,
          OPENCLAW_CONFIG_PATH: config,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
      }),
  };
}

function nativeFrame(request: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(request));
  const frame = Buffer.alloc(payload.length + 4);
  frame[os.endianness() === "LE" ? "writeUInt32LE" : "writeUInt32BE"](payload.length);
  payload.copy(frame, 4);
  return frame;
}

function nativeResponse(child: SpawnSyncReturns<Buffer>): unknown {
  const { status, stderr, stdout } = child;
  expect(status, stderr.toString("utf8")).toBe(0);
  const length = os.endianness() === "LE" ? stdout.readUInt32LE() : stdout.readUInt32BE();
  expect(stdout).toHaveLength(length + 4);
  return JSON.parse(stdout.subarray(4).toString("utf8"));
}

function nativeArgs(
  manifest: string,
  launcher: string,
  expectedOrigins = [origin],
  caller = origin,
  ...extraArgs: string[]
) {
  return extensionArgs(
    "native-host",
    "--manifest",
    manifest,
    "--launcher",
    launcher,
    ...expectedOrigins.flatMap((expected) => ["--expected-origin", expected]),
    ...extraArgs,
    caller,
  );
}

// POSIX launcher/CLI proof. The Windows PE/ACL/registry lane needs a real Windows host.
describe.skipIf(process.platform === "win32")("native host registration", () => {
  it("does not inspect or migrate configuration before rejecting a malformed native request", async () => {
    const original = "{ deliberately invalid config";
    const value = await cliFixture(original);
    const unread = path.join(value.root, "not-read-before-framing");
    const child = value.invoke(nativeArgs(unread, unread), { v: 1, op: "bootstrap", nonce: "!" });
    expect(nativeResponse(child)).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await fs.readFile(value.config, "utf8")).toBe(original);
    await expect(fs.stat(value.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["bootstrap", "ensure_relay"])(
    "rejects an unauthorized %s caller before config, keys or database creation",
    async (op) => {
      const value = await cliFixture();
      const directory = path.join(value.stateDir, "browser", "native-messaging");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const launcher = path.join(directory, "host");
      const manifest = path.join(directory, "manifest.json");
      await writePrivate(launcher, "fixture owned launcher", 0o700);
      await writeJson(manifest, {
        name: "ai.openclaw.browser_bootstrap",
        description: "OpenClaw browser extension bootstrap",
        path: launcher,
        type: "stdio",
        allowed_origins: [origin],
      });
      const before = (await fs.readdir(value.homeDir, { recursive: true })).toSorted();
      const request = {
        v: 1,
        op,
        nonce,
        ...(op === "ensure_relay" ? { relayPort: 19031 } : {}),
      };
      const args = nativeArgs(
        manifest,
        launcher,
        [origin],
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      );
      const invoke = () => value.invoke(args, request);
      const denied = invoke();
      const refusal = { v: 1, ok: false, code: "origin_forbidden" };
      expect(nativeResponse(denied)).toEqual(refusal);
      expect(denied.stdout).toHaveLength(4 + Buffer.byteLength(JSON.stringify(refusal)));
      // An admitted origin cannot bypass a changed/unsafe manifest or launcher.
      args[args.length - 1] = origin;
      await fs.chmod(launcher, 0o777);
      const unsafe = invoke();
      expect(nativeResponse(unsafe)).toEqual({ v: 1, ok: false, code: "manifest_invalid" });
      expect((await fs.readdir(value.homeDir, { recursive: true })).toSorted()).toEqual(before);
      expect(await fs.readFile(value.config, "utf8")).toBe("{ invalid config");
    },
  );

  it.each([
    ["status", "--json"],
    ["setup", "--action", "inspect", "--json"],
    ["pair", "--json"],
  ])("preserves invalid-config diagnostics for ordinary extension command %j", async (...args) => {
    const value = await cliFixture();
    const child = value.invoke(extensionArgs(...args));
    expect(child.status).toBe(1);
    const stderr = child.stderr.toString("utf8");
    expect(stderr).toContain("[openclaw] The CLI command failed.");
    expect(stderr).toContain(`Invalid config at ${value.config}:`);
    expect(stderr).toContain(
      "- <root>: JSON5 parse failed: SyntaxError: JSON5: invalid character 'c' at 1:11",
    );
    expect(stderr).toContain("[openclaw] For help, run `openclaw doctor`.");
    expect(await fs.readFile(value.config, "utf8")).toBe("{ invalid config");
  });

  it.each(["launcher", "cli"])(
    "launches %s with the exact custom installation context when Chrome has no selectors",
    async (entryMode) => {
      const value = await fixture();
      const stateDir = path.join(value.root, "custom state's dir");
      const configPath = path.join(value.root, "custom config's dir", "openclaw.json");
      const context = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath };
      const relayPort = 19_031;
      const token = relayTestKey(4);
      const deps = {
        ...value.deps,
        stateDir,
        ...(await nativeHostFixture(value.root, BUILT_NATIVE_HOST_PATH)),
        env: { ...value.deps.env, ...context },
      };
      const install = (
        options: Partial<Parameters<typeof installChromeExtensionBootstrap>[0]> = {},
      ) => installChromeExtensionBootstrap({ ...value, waitMs: 1_000, deps, ...options });
      await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
      await writePrivate(
        path.join(stateDir, "credentials", "browser-extension-relay.secret"),
        `${token}\n`,
      );
      await writeJson(configPath, {
        browser: { profiles: { e2e: { driver: "extension", cdpPort: relayPort } } },
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
      const status = await install({ browserProfile: "e2e" });
      const registration = status.registrations.find((entry) => entry.product === "chromium")!;
      expect(registration, status.issues.join("\n")).toMatchObject({ state: "owned" });
      const manifest = JSON.parse(await fs.readFile(registration.manifestPath, "utf8")) as {
        path: string;
      };

      const cliArgs = nativeArgs(
        registration.manifestPath,
        manifest.path,
        registration.extensionIds.map((id) => `chrome-extension://${id}/`),
        `chrome-extension://${extensionId}/`,
        "--browser-profile",
        "e2e",
      );
      // Documented ordinary repair must retain the canonical setup's saved profile.
      await install();
      const savedManifest = await fs.readFile(registration.manifestPath);
      const savedLauncher = await fs.readFile(manifest.path);
      await expect(
        install({
          browserProfile: "e2e",
          requireCurrentLaunchContext: true,
          deps: { ...deps, env: { ...deps.env, OPENCLAW_CONFIG_PATH: undefined } },
        }),
      ).rejects.toThrow("OPENCLAW_CONFIG_PATH");
      expect(await fs.readFile(registration.manifestPath)).toEqual(savedManifest);
      expect(await fs.readFile(manifest.path)).toEqual(savedLauncher);
      const gatewayStatePath = path.join(stateDir, "state", "openclaw.sqlite");
      const configBefore = await fs.readFile(configPath);
      await expect(fs.stat(gatewayStatePath)).rejects.toMatchObject({ code: "ENOENT" });
      const host = spawnSync(
        entryMode === "launcher" ? manifest.path : process.execPath,
        entryMode === "launcher" ? [`chrome-extension://${extensionId}/`] : cliArgs,
        {
          input: nativeFrame({ v: 1, op: "bootstrap", nonce }),
          env: {
            HOME: value.homeDir,
            TMPDIR: os.tmpdir(),
            ...(entryMode === "cli" ? context : {}),
          },
          timeout: 20_000,
        },
      );
      await expect(fs.stat(gatewayStatePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(configPath)).toEqual(configBefore);
      expect(nativeResponse(host)).toEqual({
        v: 1,
        ok: true,
        nonce,
        pairingString: `ws://127.0.0.1:18789/browser/extension?profile=e2e&gateway=ws%3A%2F%2F127.0.0.1%3A18789#${token}`,
      });
    },
  );
});
