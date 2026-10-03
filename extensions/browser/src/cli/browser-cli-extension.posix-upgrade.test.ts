import "../browser/extension-install-fixture.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import * as runtimeConfigSnapshot from "openclaw/plugin-sdk/runtime-config-snapshot";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../../test-support.js";
import {
  chromeProductRoots,
  type InstallFixture,
} from "../browser/extension-install-fixture.test-support.js";
import {
  FOUNDATION_STORE_ID,
  predictedId,
  useExtensionInstallFixture,
  writeChromePreferences,
} from "../browser/extension-install.test-support.js";

const boundary = vi.hoisted(() => ({
  deps: undefined as InstallFixture | undefined,
  install: vi.fn(),
  readToken: vi.fn(),
  connect: vi.fn(),
  ensureToken: vi.fn(),
}));
vi.mock("../browser/extension-install.js", async (original) => {
  const real = await original<typeof import("../browser/extension-install.js")>();
  const fixture = await import("../browser/extension-install-fixture.test-support.js");
  return {
    ...real,
    browserExtensionStatus: (p: Parameters<typeof real.browserExtensionStatus>[0]) =>
      fixture.browserExtensionStatus({ ...p, deps: boundary.deps }),
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
const readFiles = (files: string[]) => Promise.all(files.map((file) => fs.readFile(file)));
async function preserveFiles(...files: string[]) {
  const before = await readFiles(files);
  return async () => expect(await readFiles(files)).toEqual(before);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  boundary.deps = undefined;
  resetRuntimeCapture();
});

async function setup(
  platform: "linux" | "darwin",
  options: { legacy?: boolean; relocate?: boolean; registeredConfig?: "custom" | "default" } = {},
) {
  const f = await fixture(platform);
  const real = await import("../browser/extension-install-fixture.test-support.js");
  const root = chromeProductRoots(f.deps)[0]!;
  await fs.mkdir(root.userDataDir, { recursive: true, mode: 0o700 });
  const registeredConfigPath =
    options.registeredConfig === "custom"
      ? path.join(f.root, "saved custom config.json")
      : options.registeredConfig === "default"
        ? path.join(f.stateDir, "openclaw.json")
        : undefined;
  let now = 0;
  const deps = {
    ...f.deps,
    env: {
      ...f.deps.env,
      OPENCLAW_STATE_DIR: f.stateDir,
      OPENCLAW_CONFIG_PATH: registeredConfigPath,
    },
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  const seeded = await real.installChromeExtensionBootstrap({
    ...f,
    deps,
    browserProfile: options.legacy ? undefined : "work",
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
  const configPath = registeredConfigPath ?? path.join(f.stateDir, "openclaw.json");
  const cfg = {
    browser: {
      defaultProfile: "other",
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
  const assertFilesPreserved = await preserveFiles(...preservedPaths);
  const keyInode = (await fs.stat(keyPath)).ino;
  // Real package relocation changes the bundle ID and removes the old entrypoint.
  const nextPackage = path.join(f.root, options.relocate === false ? "package" : "package-v2");
  if (options.relocate !== false) {
    await fs.rename(path.join(f.root, "package"), nextPackage);
  }
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
  const config = vi.spyOn(runtimeConfigSnapshot, "getRuntimeConfig").mockReturnValue(cfg);
  const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(capture.writeJson);
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(capture.error);
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(capture.exit);
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
    await assertFilesPreserved();
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
    error,
    exit,
    config,
    run,
    assertPairingPreserved,
  };
}

describe("POSIX bundle migration", () => {
  const platform = "linux";
  it.each([
    { legacy: true, action: "inspect", profile: undefined },
    { legacy: true, action: "install", profile: "other" },
  ])(
    "refuses $action from a different config before effects (legacy=$legacy, profile=$profile)",
    async ({ legacy, action, profile }) => {
      const f = await setup(platform, { legacy, registeredConfig: "custom", relocate: false });
      const callerConfigPath = path.join(f.stateDir, "openclaw.json");
      const callerConfig = {
        browser: {
          defaultProfile: "other",
          profiles: {
            other: { driver: "extension" as const, cdpPort: 19555 },
            work: { driver: "extension" as const, cdpPort: 29444 },
          },
        },
      };
      await fs.writeFile(callerConfigPath, JSON.stringify(callerConfig), { mode: 0o600 });
      boundary.deps = { ...f.deps, env: { ...f.deps.env, OPENCLAW_CONFIG_PATH: undefined } };
      f.config.mockReturnValue(callerConfig);
      const copy = path.join(f.stateDir, "browser", "chrome-extension", "background.js");
      const paths = [f.manifestPath, f.manifest.path, callerConfigPath, copy];
      const assertUnchanged = await preserveFiles(...paths);
      const copyInode = (await fs.stat(copy)).ino;
      await expect(f.run(action, profile)).rejects.toThrow("__exit__:1");
      expect(f.error).toHaveBeenCalledWith(expect.stringContaining("OPENCLAW_CONFIG_PATH"));
      expect(boundary.readToken).not.toHaveBeenCalled();
      expect(boundary.connect).not.toHaveBeenCalled();
      await assertUnchanged();
      expect((await fs.stat(copy)).ino).toBe(copyInode);
      await f.assertPairingPreserved();
    },
  );

  it("accepts an implicit default config matching the explicitly registered default", async () => {
    const f = await setup(platform, { registeredConfig: "default", relocate: false });
    boundary.deps = { ...f.deps, env: { ...f.deps.env, OPENCLAW_CONFIG_PATH: undefined } };
    const launcherBefore = await fs.readFile(f.manifest.path);
    await f.run("install");
    expect(f.exit).not.toHaveBeenCalled();
    const current = JSON.parse(await fs.readFile(f.manifestPath, "utf8")) as { path: string };
    expect(await fs.readFile(current.path)).toEqual(launcherBefore);
    await f.assertPairingPreserved();
  });

  it("rechecks the saved browser binding when automatic installation begins", async () => {
    const f = await setup(platform, { relocate: false });
    let replacement: Buffer | undefined;
    boundary.install.mockImplementationOnce(async (params) => {
      await f.real.installChromeExtensionBootstrap({
        ...f,
        browserProfile: "other",
        waitMs: 1000,
        requestStoreInstall: false,
      });
      replacement = await fs.readFile(f.manifestPath);
      return f.real.installChromeExtensionBootstrap({ ...params, deps: boundary.deps });
    });
    await expect(f.run("install")).rejects.toThrow("__exit__:1");
    expect(await fs.readFile(f.manifestPath)).toEqual(replacement);
    const status = await f.real.browserExtensionStatus(f);
    expect(status.registrations.find((entry) => entry.product === f.root.product)).toMatchObject({
      state: "owned",
      browserProfile: "other",
    });
    await f.assertPairingPreserved();
  });

  it.each([
    { platform: "linux", legacy: true, action: "verify" },
    { platform: "darwin", legacy: false, action: "install" },
  ] as const)(
    "retains work through selector-free $action on $platform (legacy=$legacy)",
    async ({ platform: testPlatform, legacy, action }) => {
      const f = await setup(testPlatform, { legacy });
      const nextId = await predictedId(f.bundledDir, testPlatform);
      expect(nextId).not.toBe(f.oldBundleId);
      const beforeManifest = await fs.readFile(f.manifestPath);
      const beforeLauncher = await fs.readFile(f.manifest.path);
      expect(beforeLauncher.toString().includes("'--browser-profile' 'work'")).toBe(!legacy);
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
    const selected = JSON.parse(await fs.readFile(f.manifestPath, "utf8")) as { path: string };
    expect(await fs.readFile(selected.path, "utf8")).toContain("'--browser-profile' 'other'");
    await f.assertPairingPreserved();
  });
  it("refuses verification for a different profile without rewriting a healthy registration", async () => {
    const f = await setup(platform, { relocate: false });
    const assertUnchanged = await preserveFiles(f.manifestPath, f.manifest.path);
    await expect(f.run("verify", "other")).rejects.toThrow("__exit__:1");
    expect(boundary.install).not.toHaveBeenCalled();
    expect(boundary.readToken).not.toHaveBeenCalled();
    expect(boundary.connect).not.toHaveBeenCalled();
    expect(f.json).not.toHaveBeenCalled();
    await assertUnchanged();
    await f.assertPairingPreserved();
  });
  it.each([
    "malformed-launcher",
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
    if (kind === "missing-profile") {
      f.config.mockReturnValue({
        browser: { profiles: { other: { driver: "extension", cdpPort: 19555 } } },
      });
    }
    const assertUnchanged = await preserveFiles(f.manifestPath, f.manifest.path);
    await expect(f.run("install")).rejects.toThrow("__exit__:1");
    expect(boundary.install).not.toHaveBeenCalled();
    await assertUnchanged();
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
    const assertUnchanged = await preserveFiles(...paths);
    await expect(f.run("install")).rejects.toThrow("__exit__:1");
    expect(boundary.install).not.toHaveBeenCalled();
    await assertUnchanged();
    await f.assertPairingPreserved();
  });
  it("does not let explicit selection bypass a foreign registration", async () => {
    const f = await setup(platform);
    await fs.writeFile(
      f.manifestPath,
      JSON.stringify({ ...f.manifest, path: "/foreign/native-host" }),
    );
    const assertUnchanged = await preserveFiles(f.manifestPath, f.manifest.path);
    await f.run("install", "other");
    expect(f.json).toHaveBeenCalledWith(expect.objectContaining({ phase: "blocked" }));
    await assertUnchanged();
    await f.assertPairingPreserved();
  });
});
