import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import {
  chromeProductRoots,
  type ExtensionInstallDeps,
} from "../browser/extension-install-layout.js";
import {
  FOUNDATION_STORE_ID,
  predictedId,
  useExtensionInstallFixture,
  writeChromePreferences,
} from "../browser/extension-install.test-support.js";
import * as core from "./core-api.js";

const boundary = vi.hoisted(() => ({
  deps: undefined as ExtensionInstallDeps | undefined,
  install: vi.fn(),
  readToken: vi.fn(),
  connect: vi.fn(),
  ensureToken: vi.fn(),
}));
vi.mock("../browser/extension-install.js", async (original) => {
  const real = await original<typeof import("../browser/extension-install.js")>();
  return {
    ...real,
    browserExtensionStatus: (p: Parameters<typeof real.browserExtensionStatus>[0]) =>
      real.browserExtensionStatus({ ...p, deps: boundary.deps }),
    installChromeExtensionBootstrap: boundary.install,
  };
});
vi.mock("../browser/extension-relay/relay-auth.js", async (original) => ({
  ...(await original<typeof import("../browser/extension-relay/relay-auth.js")>()),
  readExtensionRelayToken: boundary.readToken,
  ensureExtensionRelayToken: boundary.ensureToken,
}));
vi.mock("../browser/extension-relay/owner-client.js", () => ({
  RelayOwnerClient: { connect: boundary.connect },
}));
const fixture = useExtensionInstallFixture();
const { defaultRuntime: capture, resetRuntimeCapture } = createCliRuntimeCapture();
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  boundary.deps = undefined;
  resetRuntimeCapture();
});

async function setup(platform: "linux" | "darwin") {
  const f = await fixture(platform);
  const real = await vi.importActual<typeof import("../browser/extension-install.js")>(
    "../browser/extension-install.js",
  );
  const root = chromeProductRoots(f.deps)[0]!;
  await fs.mkdir(root.userDataDir, { recursive: true, mode: 0o700 });
  let now = 0;
  const deps = {
    ...f.deps,
    env: { ...f.deps.env, OPENCLAW_STATE_DIR: f.stateDir },
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  const seeded = await real.installChromeExtensionBootstrap({
    ...f,
    deps,
    browserProfile: "work",
    waitMs: 1000,
    requestStoreInstall: false,
  });
  const registration = seeded.registrations.find((entry) => entry.product === root.product)!;
  const manifest = JSON.parse(await fs.readFile(registration.manifestPath, "utf8")) as {
    path: string;
    allowed_origins: string[];
  };
  const installedId = await predictedId(seeded.installedCopy.path, platform);
  const oldBundleId = await predictedId(f.bundledDir, platform);
  const preferences = await writeChromePreferences({
    userDataDir: root.userDataDir,
    profile: "Default",
    entries: { [installedId]: { location: 4, path: seeded.installedCopy.path, state: 1 } },
  });
  const configPath = path.join(f.stateDir, "openclaw.json");
  const cfg = {
    browser: {
      profiles: {
        work: { driver: "extension" as const, cdpPort: 19444 },
        other: { driver: "extension" as const, cdpPort: 19555 },
      },
    },
  };
  await fs.writeFile(configPath, JSON.stringify(cfg), { mode: 0o600 });
  const keyPath = path.join(f.stateDir, "credentials", "browser-extension-relay.secret");
  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 19 + 5) & 255)).toString("hex");
  await fs.writeFile(keyPath, key + "\n", { mode: 0o600 });
  const preservedPaths = [keyPath, configPath, preferences];
  const preserved = await Promise.all(preservedPaths.map((file) => fs.readFile(file)));
  const keyInode = (await fs.stat(keyPath)).ino;
  // Real package relocation changes the bundle ID and removes the old entrypoint.
  const nextPackage = path.join(f.root, "package-v2");
  await fs.rename(path.join(f.root, "package"), nextPackage);
  const bundledDir = path.join(nextPackage, "extensions", "browser", "chrome-extension");
  const pluginRoot = path.dirname(bundledDir);
  const nativeHostPath = path.join(nextPackage, "native-host-entry.js");
  boundary.deps = { ...deps, nativeHostPath };
  boundary.install.mockImplementation(
    (p: Parameters<typeof real.installChromeExtensionBootstrap>[0]) =>
      real.installChromeExtensionBootstrap({ ...p, deps: boundary.deps }),
  );
  const auth = await vi.importActual<typeof import("../browser/extension-relay/relay-auth.js")>(
    "../browser/extension-relay/relay-auth.js",
  );
  boundary.readToken.mockImplementation(() => auth.readExtensionRelayToken(deps.env));
  boundary.ensureToken.mockImplementation(() => {
    throw new Error("Setup must not rotate the fixture pairing key");
  });
  boundary.connect.mockResolvedValue({
    status: async () => ({ ready: true, identity: { extensionVersion: "fixture" } }),
    close: async () => {},
  });
  const config = vi.spyOn(core, "getRuntimeConfig").mockReturnValue(cfg);
  const json = vi.spyOn(core.defaultRuntime, "writeJson").mockImplementation(capture.writeJson);
  vi.spyOn(core.defaultRuntime, "error").mockImplementation(capture.error);
  const exit = vi.spyOn(core.defaultRuntime, "exit").mockImplementation(capture.exit);
  const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
  async function run(action: string, profile?: string) {
    const program = new Command();
    registerBrowserExtensionCommands(program.command("browser"), () => ({}), pluginRoot);
    await program.parseAsync(
      [
        "browser",
        "extension",
        "setup",
        "--action",
        action,
        "--json",
        "--wait-ms",
        "1000",
        ...(profile ? ["--browser-profile", profile] : []),
      ],
      { from: "user" },
    );
  }
  async function assertPairingPreserved() {
    expect(await Promise.all(preservedPaths.map((file) => fs.readFile(file)))).toEqual(preserved);
    expect((await fs.stat(keyPath)).ino).toBe(keyInode);
    expect(auth.readExtensionRelayToken(deps.env)).toBe(key);
    expect(boundary.ensureToken).not.toHaveBeenCalled();
    expect(JSON.stringify(json.mock.calls)).not.toContain(key);
  }
  return {
    ...f,
    real,
    deps: boundary.deps,
    root,
    bundledDir,
    pluginRoot,
    nativeHostPath,
    manifest,
    manifestPath: registration.manifestPath,
    installedId,
    oldBundleId,
    json,
    exit,
    config,
    run,
    assertPairingPreserved,
  };
}

describe.each(["linux", "darwin"] as const)("POSIX bundle migration on %s", (platform) => {
  it.each(["inspect", "verify", "install"])(
    "retains validated work selection through selector-free %s",
    async (action) => {
      const f = await setup(platform);
      const nextId = await predictedId(f.bundledDir, platform);
      expect(nextId).not.toBe(f.oldBundleId);
      const beforeManifest = await fs.readFile(f.manifestPath);
      const beforeLauncher = await fs.readFile(f.manifest.path);
      await f.run(action);
      expect(f.exit).not.toHaveBeenCalled();
      if (action === "install") {
        expect(boundary.install).toHaveBeenCalledOnce();
        const repaired = JSON.parse(await fs.readFile(f.manifestPath, "utf8"));
        expect(repaired.allowed_origins).toEqual(
          [f.installedId, nextId, FOUNDATION_STORE_ID]
            .toSorted()
            .map((id) => "chrome-extension://" + id + "/"),
        );
        const launcher = await fs.readFile(repaired.path, "utf8");
        expect(launcher).toContain("'--browser-profile' 'work'");
        expect(launcher).toContain(f.nativeHostPath);
        expect(launcher).not.toContain(f.oldBundleId);
        const status = await f.real.browserExtensionStatus(f);
        expect(
          status.registrations.find((entry) => entry.product === f.root.product),
        ).toMatchObject({ state: "owned", browserProfile: "work", issue: undefined });
      } else {
        expect(boundary.install).not.toHaveBeenCalled();
        expect(await fs.readFile(f.manifestPath)).toEqual(beforeManifest);
        expect(await fs.readFile(f.manifest.path)).toEqual(beforeLauncher);
        expect(f.json).toHaveBeenCalledWith(
          expect.objectContaining({
            installation: expect.objectContaining({ nativeHostRegistered: false }),
          }),
        );
      }
      if (action === "verify") {
        expect(boundary.connect).toHaveBeenCalledWith(
          expect.objectContaining({ profile: "work", port: 19444 }),
        );
      } else {
        expect(boundary.readToken).not.toHaveBeenCalled();
      }
      expect(f.json).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ profile: "work", relayPort: 19444 }),
        }),
      );
      await f.assertPairingPreserved();
    },
  );
  it("honors an explicit different extension profile rather than treating omission as that choice", async () => {
    const f = await setup(platform);
    await f.run("install", "other");
    expect(f.json).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ profile: "other", relayPort: 19555 }),
      }),
    );
    expect(await fs.readFile(f.manifest.path, "utf8")).toContain("'--browser-profile' 'other'");
    await f.assertPairingPreserved();
  });
  it.each([
    "malformed-launcher",
    "foreign-manifest",
    "extra-origin",
    "missing-profile",
    ...(process.platform === "win32" ? [] : ["unsafe-mode"]),
  ])("refuses unresolved %s before an automatic installation", async (kind) => {
    const f = await setup(platform);
    if (kind === "unsafe-mode") {
      await fs.chmod(f.manifest.path, 0o755);
    }
    if (kind === "malformed-launcher") {
      await fs.appendFile(f.manifest.path, "echo foreign-command\n");
    }
    if (kind === "foreign-manifest") {
      await fs.writeFile(
        f.manifestPath,
        JSON.stringify({ ...f.manifest, path: "/foreign/native-host" }),
      );
    }
    if (kind === "extra-origin") {
      const origin = "chrome-extension://" + "p".repeat(32) + "/";
      const origins = [...f.manifest.allowed_origins, origin].toSorted();
      const launcher = await fs.readFile(f.manifest.path, "utf8");
      const prior = f.manifest.allowed_origins
        .map((entry) => " '--expected-origin' '" + entry + "'")
        .join("");
      const next = origins.map((entry) => " '--expected-origin' '" + entry + "'").join("");
      expect(launcher).toContain(prior);
      await fs.writeFile(f.manifest.path, launcher.replace(prior, next));
      await fs.writeFile(
        f.manifestPath,
        JSON.stringify({ ...f.manifest, allowed_origins: origins }),
      );
    }
    if (kind === "missing-profile") {
      f.config.mockReturnValue({
        browser: { profiles: { other: { driver: "extension", cdpPort: 19555 } } },
      });
    }
    const before = await Promise.all(
      [f.manifestPath, f.manifest.path].map((file) => fs.readFile(file)),
    );
    await expect(f.run("install")).rejects.toThrow("__exit__:1");
    expect(boundary.install).not.toHaveBeenCalled();
    expect(
      await Promise.all([f.manifestPath, f.manifest.path].map((file) => fs.readFile(file))),
    ).toEqual(before);
    await f.assertPairingPreserved();
  });
  it("refuses mixed owned and foreign roots before migrating either", async () => {
    const f = await setup(platform);
    const other = chromeProductRoots(f.deps).find((entry) => entry.product === "chromium")!;
    await fs.mkdir(other.nativeManifestDir, { recursive: true, mode: 0o700 });
    const foreign = path.join(other.nativeManifestDir, path.basename(f.manifestPath));
    await fs.writeFile(
      foreign,
      JSON.stringify({ name: "foreign", path: "/foreign/native-host", allowed_origins: [] }),
      { mode: 0o600 },
    );
    const paths = [f.manifestPath, f.manifest.path, foreign];
    const before = await Promise.all(paths.map((file) => fs.readFile(file)));
    await expect(f.run("install")).rejects.toThrow("__exit__:1");
    expect(boundary.install).not.toHaveBeenCalled();
    expect(await Promise.all(paths.map((file) => fs.readFile(file)))).toEqual(before);
    await f.assertPairingPreserved();
  });
  it("does not let explicit selection bypass a foreign registration", async () => {
    const f = await setup(platform);
    await fs.writeFile(
      f.manifestPath,
      JSON.stringify({ ...f.manifest, path: "/foreign/native-host" }),
    );
    const before = await Promise.all(
      [f.manifestPath, f.manifest.path].map((file) => fs.readFile(file)),
    );
    await f.run("install", "other");
    expect(f.json).toHaveBeenCalledWith(expect.objectContaining({ phase: "blocked" }));
    expect(
      await Promise.all([f.manifestPath, f.manifest.path].map((file) => fs.readFile(file))),
    ).toEqual(before);
    await f.assertPairingPreserved();
  });
});
