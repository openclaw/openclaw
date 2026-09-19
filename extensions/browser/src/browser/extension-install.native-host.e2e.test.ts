import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { chromeProductRoots, installStableChromeExtension } from "./extension-install-layout.js";
import { installChromeExtensionBootstrap } from "./extension-install.js";
import {
  predictedId,
  useExtensionInstallFixture,
  useNativeHostLaunchFixture,
  writeChromePreferences,
} from "./extension-install.test-support.js";

const BUILT_NATIVE_HOST_PATH = path.resolve("dist/extensions/browser/native-host-entry.js");
const fixture = useExtensionInstallFixture();
const nativeHostFixture = useNativeHostLaunchFixture();

// POSIX launcher/CLI proof. The Windows PE/ACL/registry lane needs a real Windows host.
describe.skipIf(process.platform === "win32")("native host registration", () => {
  it("does not inspect or migrate configuration before rejecting a malformed native request", async () => {
    const value = await fixture();
    const configPath = path.join(value.root, "malformed-config.json");
    const original = "{ deliberately invalid config";
    await fs.writeFile(configPath, original, { mode: 0o600 });
    const payload = Buffer.from(JSON.stringify({ v: 1, op: "bootstrap", nonce: "!" }));
    const frame = Buffer.alloc(payload.length + 4);
    if (os.endianness() === "LE") {
      frame.writeUInt32LE(payload.length);
    } else {
      frame.writeUInt32BE(payload.length);
    }
    payload.copy(frame, 4);
    const child = spawnSync(
      process.execPath,
      [
        path.resolve("openclaw.mjs"),
        "browser",
        "extension",
        "native-host",
        "--manifest",
        path.join(value.root, "not-read-before-framing.json"),
        "--launcher",
        path.join(value.root, "not-read-before-framing-host"),
        "--expected-origin",
        "chrome-extension://kcdjddhmeafeomebliikmbpblkmkfoig/",
        "chrome-extension://kcdjddhmeafeomebliikmbpblkmkfoig/",
      ],
      {
        input: frame,
        env: {
          HOME: value.homeDir,
          OPENCLAW_STATE_DIR: value.stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
        },
        timeout: 20_000,
      },
    );
    expect(child.status, child.stderr.toString("utf8")).toBe(0);
    const length =
      os.endianness() === "LE" ? child.stdout.readUInt32LE() : child.stdout.readUInt32BE();
    expect(child.stdout).toHaveLength(length + 4);
    expect(JSON.parse(child.stdout.subarray(4).toString("utf8"))).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    await expect(fs.stat(value.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["bootstrap", "ensure_relay"])(
    "rejects an unauthorized %s caller before config, keys or database creation",
    async (op) => {
      const value = await fixture();
      const directory = path.join(value.stateDir, "browser", "native-messaging");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const launcher = path.join(directory, "host");
      const manifest = path.join(directory, "manifest.json");
      const config = path.join(value.root, "invalid-config.json");
      const origin = "chrome-extension://kcdjddhmeafeomebliikmbpblkmkfoig/";
      await fs.writeFile(launcher, "fixture owned launcher", { mode: 0o700 });
      await fs.writeFile(
        manifest,
        JSON.stringify({
          name: "ai.openclaw.browser_bootstrap",
          description: "OpenClaw browser extension bootstrap",
          path: launcher,
          type: "stdio",
          allowed_origins: [origin],
        }),
        { mode: 0o600 },
      );
      await fs.writeFile(config, "{ invalid config", { mode: 0o600 });
      const before = (await fs.readdir(value.homeDir, { recursive: true })).toSorted();
      const payload = Buffer.from(
        JSON.stringify({
          v: 1,
          op,
          nonce: Buffer.alloc(16, 7).toString("base64url"),
          ...(op === "ensure_relay" ? { relayPort: 19031 } : {}),
        }),
      );
      const frame = Buffer.alloc(payload.length + 4);
      if (os.endianness() === "LE") {
        frame.writeUInt32LE(payload.length);
      } else {
        frame.writeUInt32BE(payload.length);
      }
      payload.copy(frame, 4);
      const args = [
        path.resolve("openclaw.mjs"),
        "browser",
        "extension",
        "native-host",
        "--manifest",
        manifest,
        "--launcher",
        launcher,
        "--expected-origin",
        origin,
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
      ];
      const invoke = () =>
        spawnSync(process.execPath, args, {
          input: frame,
          timeout: 20_000,
          env: {
            HOME: value.homeDir,
            OPENCLAW_STATE_DIR: value.stateDir,
            OPENCLAW_CONFIG_PATH: config,
          },
        });
      const denied = invoke();
      expect(denied.status, denied.stderr.toString("utf8")).toBe(0);
      expect(JSON.parse(denied.stdout.subarray(4).toString("utf8"))).toEqual({
        v: 1,
        ok: false,
        code: "origin_forbidden",
      });
      expect(denied.stdout).toHaveLength(
        4 +
          Buffer.byteLength(
            JSON.stringify({
              v: 1,
              ok: false,
              code: "origin_forbidden",
            }),
          ),
      );
      // An admitted origin cannot bypass a changed/unsafe manifest or launcher.
      args[args.length - 1] = origin;
      await fs.chmod(launcher, 0o777);
      const unsafe = invoke();
      expect(unsafe.status, unsafe.stderr.toString("utf8")).toBe(0);
      expect(JSON.parse(unsafe.stdout.subarray(4).toString("utf8"))).toEqual({
        v: 1,
        ok: false,
        code: "manifest_invalid",
      });
      expect((await fs.readdir(value.homeDir, { recursive: true })).toSorted()).toEqual(before);
      expect(await fs.readFile(config, "utf8")).toBe("{ invalid config");
    },
  );

  it.each([
    ["status", "--json"],
    ["setup", "--action", "inspect", "--json"],
    ["pair", "--json"],
  ])("preserves invalid-config diagnostics for ordinary extension command %j", async (...args) => {
    const value = await fixture();
    const config = path.join(value.root, "invalid-config.json");
    await fs.writeFile(config, "{ invalid config", { mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [path.resolve("openclaw.mjs"), "browser", "extension", ...args],
      {
        timeout: 20_000,
        env: {
          HOME: value.homeDir,
          OPENCLAW_STATE_DIR: value.stateDir,
          OPENCLAW_CONFIG_PATH: config,
        },
      },
    );
    expect(child.status).toBe(1);
    expect(child.stderr.toString("utf8")).toContain("Invalid config at");
    expect(await fs.readFile(config, "utf8")).toBe("{ invalid config");
  });

  it.each(["launcher", "cli"])(
    "launches %s with the exact custom installation context when Chrome has no selectors",
    async (entryMode) => {
      const value = await fixture();
      const stateDir = path.join(value.root, "custom state's dir");
      const configPath = path.join(value.root, "custom config's dir", "openclaw.json");
      const launchFixture = await nativeHostFixture(value.root, BUILT_NATIVE_HOST_PATH);
      const relayPort = 19_031;
      const token = relayTestKey(4);
      const deps = {
        ...value.deps,
        stateDir,
        ...launchFixture,
        env: {
          ...value.deps.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
        },
      };
      await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(stateDir, "credentials", "browser-extension-relay.secret"),
        `${token}\n`,
        { mode: 0o600 },
      );
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ browser: { profiles: { e2e: { driver: "extension", cdpPort: relayPort } } } })}\n`,
        { mode: 0o600 },
      );
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
      const status = await installChromeExtensionBootstrap({
        bundledDir: value.bundledDir,
        pluginRoot: value.pluginRoot,
        waitMs: 1_000,
        browserProfile: "e2e",
        deps,
      });
      const registration = status.registrations.find((entry) => entry.product === "chromium");
      expect(registration, status.issues.join("\n")).toMatchObject({ state: "owned" });
      const manifest = JSON.parse(await fs.readFile(registration?.manifestPath ?? "", "utf8")) as {
        path: string;
      };

      const nonce = Buffer.alloc(16, 7).toString("base64url");
      const requestBody = Buffer.from(JSON.stringify({ v: 1, op: "bootstrap", nonce }));
      const requestFrame = Buffer.alloc(requestBody.length + 4);
      if (os.endianness() === "LE") {
        requestFrame.writeUInt32LE(requestBody.length);
      } else {
        requestFrame.writeUInt32BE(requestBody.length);
      }
      requestBody.copy(requestFrame, 4);
      const cliArgs = [
        path.resolve("openclaw.mjs"),
        "browser",
        "extension",
        "native-host",
        "--manifest",
        registration?.manifestPath ?? "",
        "--launcher",
        manifest.path,
        ...status.registrations
          .find((candidate) => candidate.product === "chromium")!
          .extensionIds.flatMap((id) => ["--expected-origin", `chrome-extension://${id}/`]),
        "--browser-profile",
        "e2e",
        `chrome-extension://${extensionId}/`,
      ];
      // Documented ordinary repair must retain the canonical setup's saved profile.
      await installChromeExtensionBootstrap({
        bundledDir: value.bundledDir,
        pluginRoot: value.pluginRoot,
        deps,
        waitMs: 1000,
      });
      const gatewayStatePath = path.join(stateDir, "state", "openclaw.sqlite");
      const configBefore = await fs.readFile(configPath);
      await expect(fs.stat(gatewayStatePath)).rejects.toMatchObject({ code: "ENOENT" });
      const host = spawnSync(
        entryMode === "launcher" ? manifest.path : process.execPath,
        entryMode === "launcher" ? [`chrome-extension://${extensionId}/`] : cliArgs,
        {
          input: requestFrame,
          env: {
            HOME: value.homeDir,
            TMPDIR: os.tmpdir(),
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
          },
          timeout: 20_000,
        },
      );
      expect(host.status, host.stderr.toString("utf8")).toBe(0);
      await expect(fs.stat(gatewayStatePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(configPath)).toEqual(configBefore);
      const frameLength =
        os.endianness() === "LE" ? host.stdout.readUInt32LE() : host.stdout.readUInt32BE();
      expect(host.stdout).toHaveLength(frameLength + 4);
      expect(JSON.parse(host.stdout.subarray(4).toString("utf8"))).toEqual({
        v: 1,
        ok: true,
        nonce,
        pairingString: `ws://127.0.0.1:18789/browser/extension?profile=e2e&gateway=ws%3A%2F%2F127.0.0.1%3A18789#${token}`,
      });
    },
  );
});
