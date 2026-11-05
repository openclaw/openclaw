import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexAppServerRuntimeIdentity } from "./client.js";
import type { CodexAppServerStartOptions as StartOptions } from "./config.js";
import {
  captureCodexAppServerRuntimeArtifactBeforeStart as captureArtifact,
  finalizeCodexAppServerRuntimeArtifact as finalizeArtifact,
  validateCodexAppServerRuntimeArtifact as validateArtifact,
} from "./runtime-artifact.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

function startOptions(command: string, overrides: Partial<StartOptions> = {}): StartOptions {
  return {
    transport: "stdio",
    command,
    commandSource: "config",
    args: ["app-server"],
    headers: {},
    ...overrides,
  };
}

function spawnIdentity(options: StartOptions, nativeCommand?: string) {
  return {
    command: options.command,
    argsFingerprint: createHash("sha256").update(JSON.stringify(options.args)).digest("hex"),
    ...(options.commandSource ? { commandSource: options.commandSource } : {}),
    ...(options.managedCommandOrder ? { managedCommandOrder: options.managedCommandOrder } : {}),
    ...(nativeCommand ? { nativeCommand } : {}),
  };
}

function captureBefore(options: StartOptions, signal?: AbortSignal) {
  return captureArtifact({ startOptions: options, spawnIdentity: spawnIdentity(options), signal });
}

async function expectMutationInvalidates(
  binding: Awaited<ReturnType<typeof captureBinding>>["binding"],
  file: string,
  replacement: string,
) {
  await expect(validateArtifact(binding)).resolves.toBe(true);
  await fs.writeFile(file, replacement);
  await expect(validateArtifact(binding)).resolves.toBe(false);
}

const runtimeIdentity: CodexAppServerRuntimeIdentity = {
  serverVersion: CODEX_APP_SERVER_VERSION,
  userAgent: "codex-test",
  codexHome: "/remote/codex-home",
  platformFamily: "unix",
  platformOs: "linux",
};

async function captureBinding(
  options: StartOptions,
  nativeCommand?: string,
  identity = runtimeIdentity,
) {
  const selection = { startOptions: options, spawnIdentity: spawnIdentity(options, nativeCommand) };
  const before = await captureArtifact(selection);
  const binding = await finalizeArtifact({
    before,
    ...selection,
    runtimeIdentity: identity,
  });
  return { binding };
}

async function writeFixtureFiles(files: Record<string, string>, executable = false) {
  for (const [file, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
    if (executable) {
      await fs.chmod(file, 0o755);
    }
  }
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const makeRoot = () => tempDirs.make("openclaw-codex-artifact-");
const propertyRestores: (() => void)[] = [];
afterEach(() => {
  propertyRestores.splice(0).forEach((restore) => restore());
  vi.restoreAllMocks();
});

function overrideProperty(target: object, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { ...original, configurable: true, value });
  propertyRestores.push(() =>
    original ? Object.defineProperty(target, key, original) : Reflect.deleteProperty(target, key),
  );
}

async function nativeArtifact(contents = "native-v1", commandName = "codex") {
  const root = makeRoot();
  const command = path.join(root, commandName);
  await writeFixtureFiles({ [command]: contents });
  return { command, root };
}

async function packageArtifact() {
  const artifact = await nativeArtifact("native-v1", "bin/codex");
  await fs.writeFile(path.join(artifact.root, "codex-package.json"), "{}\n");
  return artifact;
}

const supportsPosix = process.platform !== "win32";

async function createNpmLauncherFixture(root: string) {
  const packageRoot = path.join(root, "node_modules", "@openai", "codex");
  const launcher = path.join(packageRoot, "bin", "codex.js");
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const triple = `${arch === "arm64" ? "aarch64" : "x86_64"}-${platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
  const nativeName = `@openai/codex-${platform}-${arch}`;
  const nativePackage = path.join(packageRoot, "node_modules", nativeName);
  const native = path.join(nativePackage, "vendor", triple, "bin", "codex");
  const binDir = path.join(root, "bin");
  await writeFixtureFiles({
    [path.join(packageRoot, "package.json")]: JSON.stringify({
      name: "@openai/codex",
      bin: { codex: "bin/codex.js" },
    }),
    [path.join(nativePackage, "package.json")]: JSON.stringify({ name: nativeName }),
    [launcher]: "#!/usr/bin/env node\n",
    [native]: "native-v1",
    [path.join(binDir, "node")]: "node-v1",
  });
  await fs.chmod(launcher, 0o755);
  await fs.chmod(path.join(binDir, "node"), 0o755);
  const command = path.join(binDir, "codex");
  await fs.symlink(launcher, command);
  return { launcher, native, binDir };
}

it("rejects cancellation while opening an empty runtime artifact", async () => {
  const { command } = await nativeArtifact("");
  const options = startOptions(command);
  const controller = new AbortController();
  const reason = new Error("Runtime capture canceled");
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === command && typeof args[1] === "number") {
      controller.abort(reason);
    }
    return handle;
  });
  await expect(captureBefore(options, controller.signal)).rejects.toBe(reason);
});

it.runIf(process.platform === "darwin" || process.platform === "linux").each([
  ["resolved-managed", "package-entrypoint"],
  ["config", "relative"],
] as const)("binds the official npm launcher selected by %s via %s", async (source, selection) => {
  const root = makeRoot();
  const { launcher, native, binDir } = await createNpmLauncherFixture(root);
  const options = startOptions(selection === "package-entrypoint" ? launcher : "bin/codex", {
    commandSource: source,
    cwd: root,
    env: { PATH: binDir },
  });
  const { binding } = await captureBinding(options);
  await expectMutationInvalidates(binding, native, "native-v2");
});

it.runIf(supportsPosix)("binds Bun without Node on the managed child PATH", async () => {
  const root = makeRoot();
  const { launcher, binDir } = await createNpmLauncherFixture(root);
  const bunPath = path.join(binDir, "bun");
  await fs.writeFile(bunPath, "bun-v1");
  await fs.rm(path.join(binDir, "node"));
  overrideProperty(process, "execPath", bunPath);
  overrideProperty(process.versions, "bun", "1.4.3");
  const { binding } = await captureBinding(
    startOptions(launcher, {
      commandSource: "resolved-managed",
      env: { PATH: binDir },
    }),
  );
  await expectMutationInvalidates(binding, bunPath, "bun-v2");
});

it.runIf(supportsPosix).each(["custom.js", "node_modules/@openai/codex/bin/custom.js"])(
  "rejects an unrecognized configured script at %s",
  async (relativePath) => {
    const root = makeRoot();
    await createNpmLauncherFixture(root);
    const command = path.join(root, relativePath);
    await fs.mkdir(path.dirname(command), { recursive: true });
    await fs.writeFile(command, "#!/usr/bin/env node\n");
    await expect(captureBinding(startOptions(command))).rejects.toThrow(
      "cannot attest a custom script launcher",
    );
  },
);

it.runIf(supportsPosix)("resolves relative launchers and shebangs from spawn cwd", async () => {
  const root = makeRoot();
  const spawnCwd = path.join(root, "workspace");
  const command = path.join(spawnCwd, "bin", "codex");
  const interpreter = path.join(spawnCwd, "interpreters", "fixture-node");
  const nativeCommand = path.join(spawnCwd, "native", "codex-native");
  await writeFixtureFiles(
    {
      [command]: "#!/usr/bin/env fixture-node\n",
      [interpreter]: "interpreter-v1",
      [nativeCommand]: "native-v1",
    },
    true,
  );
  const options = startOptions("codex", {
    cwd: spawnCwd,
    env: { PATH: ["bin", "interpreters"].join(path.delimiter) },
  });
  const { binding } = await captureBinding(options, path.join("native", "codex-native"));
  await expectMutationInvalidates(binding, interpreter, "interpreter-v2");
});

it("attests that an adjacent code-mode host is absent", async () => {
  const { command, root } = await nativeArtifact();
  const codeModeHost = path.join(root, "codex-code-mode-host");
  const { binding } = await captureBinding(startOptions(command));
  await expectMutationInvalidates(binding, codeModeHost, "host-v1");
});

it("binds the complete canonical package tree", async () => {
  const { root, command } = await packageArtifact();
  const binDir = path.join(root, "bin");
  const resourcesDir = path.join(root, "codex-resources");
  await writeFixtureFiles({
    [path.join(binDir, "codex-code-mode-host")]: "host-v1",
    [path.join(resourcesDir, "bwrap")]: "resource-v1",
    [path.join(root, "codex-path", "rg")]: "rg-v1",
    [path.join(root, "codex-package.json")]: '{"layoutVersion":1}\n',
  });
  const { binding } = await captureBinding(startOptions(command));
  await expectMutationInvalidates(binding, path.join(resourcesDir, "bwrap"), "resource-v2");
});

it("detects candidate bytes changing between spawn snapshots", async () => {
  const { command } = await nativeArtifact();
  const options = startOptions(command);
  const before = await captureBefore(options);
  await fs.writeFile(command, "native-v2");
  await expect(
    finalizeArtifact({
      before,
      startOptions: options,
      spawnIdentity: spawnIdentity(options),
      runtimeIdentity: { serverVersion: CODEX_APP_SERVER_VERSION },
    }),
  ).rejects.toThrow("changed during startup");
});

it("ignores the retired code-mode host override and binds the native adjacent host", async () => {
  const { command, root } = await nativeArtifact();
  const codeModeHost = path.join(root, "codex-code-mode-host");
  const retiredOverride = path.join(root, "custom-code-mode-host");
  await fs.writeFile(codeModeHost, "host-v1");
  const options = startOptions(command, {
    env: { CODEX_CODE_MODE_HOST_PATH: retiredOverride },
  });
  const { binding } = await captureBinding(options);
  await fs.writeFile(retiredOverride, "unused-host");
  expect((await captureBinding(options)).binding).toEqual(binding);
  await fs.writeFile(codeModeHost, "host-v2");
  await expect(validateArtifact(binding)).resolves.toBe(false);
});

it("keeps raw argv out of the server-minted artifact id", async () => {
  const { command } = await nativeArtifact();
  const secret = "provider.api_key=super-secret-value";
  const options = startOptions(command, { args: ["-c", secret, "app-server"] });
  const { binding } = await captureBinding(options);
  expect(binding.id).not.toContain(secret);
  expect(JSON.stringify(binding)).not.toContain("super-secret-value");
});

const remoteStart = startOptions("codex", {
  transport: "websocket",
  url: "wss://codex.example.test/socket?token=endpoint-secret",
  authToken: "connection-secret",
  headers: { "x-service-token": "header-secret" },
});

it.each([
  [{ url: "wss://other.example.test/socket" }, false],
  [{ authToken: "rotated-token" }, false],
  [{ headers: { "x-service-token": "rotated-header" } }, false],
  [{ transport: "unix", url: "unix:///tmp/codex.sock" }, false],
  [
    {
      command: "/another/codex",
      args: ["app-server", "--local"],
      env: { PATH: "/local/path", CODEX_HOME: "/local/home" },
      codexHome: "/local/home",
    },
    true,
  ],
] satisfies [Partial<StartOptions>, boolean][])(
  "validates remote selection changes %j as %s",
  async (change, valid) => {
    const { binding } = await captureBinding(remoteStart);
    await expect(validateArtifact(binding, undefined, remoteStart)).resolves.toBe(true);
    await expect(validateArtifact(binding, undefined, { ...remoteStart, ...change })).resolves.toBe(
      valid,
    );
    await expect(validateArtifact(binding)).resolves.toBe(false);
  },
);

it("binds the home-resolved canonical Unix socket", async () => {
  const start = {
    ...remoteStart,
    transport: "unix" as const,
    url: "unix://",
    env: { CODEX_HOME: "/remote/first-home" },
  };
  const { binding } = await captureBinding(start);
  for (const [url, home, valid] of [
    ["unix://", "/remote/second-home", false],
    ["unix:///remote/first-home/app-server-control/app-server-control.sock", "/ignored", true],
  ] as const) {
    await expect(
      validateArtifact(binding, undefined, { ...start, url, env: { CODEX_HOME: home } }),
    ).resolves.toBe(valid);
  }
});

it.each([
  { serverVersion: "9.0.0" },
  { userAgent: "different codex" },
  { codexHome: "/remote/other-home" },
  { platformFamily: "windows" },
  { platformOs: "darwin" },
])("binds initialized remote identity changes %j", async (change) => {
  expect(
    (await captureBinding(remoteStart, undefined, { ...runtimeIdentity, ...change })).binding,
  ).not.toEqual((await captureBinding(remoteStart)).binding);
});

it.each([
  [{ authToken: "rotated-token" }, runtimeIdentity, "changed during startup"],
  [{}, undefined, "did not report an initialized runtime identity"],
] as const)("rejects incomplete remote startup %j", async (change, identity, error) => {
  const before = await captureBefore(remoteStart);
  const options = { ...remoteStart, ...change };
  await expect(
    finalizeArtifact({
      before,
      startOptions: options,
      spawnIdentity: spawnIdentity(options),
      runtimeIdentity: identity,
    }),
  ).rejects.toThrow(error);
});

it("requires an explicit remote endpoint", async () => {
  await expect(captureBefore({ ...remoteStart, url: undefined })).rejects.toThrow(
    "configured socket endpoint",
  );
});

it("keeps endpoint and credential material out of the serialized binding", async () => {
  const { binding } = await captureBinding(remoteStart);
  const descriptor = Buffer.from(binding.id.split(":").at(-1)!, "base64url").toString("utf8");
  expect(JSON.parse(descriptor)).toEqual({
    kind: "configured-connection",
    transport: "websocket",
    selectionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    runtimeIdentityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
});

it("rejects corrupt and noncanonical configured bindings", async () => {
  const { binding } = await captureBinding(remoteStart);
  for (const invalid of [
    { ...binding, fingerprint: "0".repeat(64) },
    { ...binding, id: `${binding.id}=` },
    { ...binding, id: "codex-app-server:connection:v1:bad" },
    { ...binding, id: `codex-app-server:connection:v1:${"a".repeat(2048)}` },
  ]) {
    await expect(validateArtifact(invalid, undefined, remoteStart)).resolves.toBe(false);
  }
});

it("rejects an app-server proxy with a subcommand-shaped socket before local artifact capture", async () => {
  const options = startOptions("codex", {
    args: ["app-server", "proxy", "--sock", "app-server"],
  });
  await expect(captureBinding(options)).rejects.toThrow("proxy attestation is unsupported");
});

it.each([
  ["preload", "--require=/tmp/super-secret-inject.js", "--require"],
  ["mixed safe and unsafe", "--no-warnings --import=/tmp/inject.mjs", "--import"],
  ["invalid boolean value", "--no-warnings=true", "--no-warnings"],
])("fails closed for %s NODE_OPTIONS", async (_label, nodeOptions, option) => {
  const options = startOptions("codex", { env: { NODE_OPTIONS: nodeOptions } });
  const capture = captureBefore(options);
  await expect(capture).rejects.toThrow(`cannot attest NODE_OPTIONS option ${option}`);
  await expect(capture).rejects.not.toThrow("super-secret-inject.js");
});

it.each([
  ["unterminated quote", '--no-warnings "'],
  ["trailing quoted escape", '--no-warnings "\\'],
  ["tab delimiter", "--no-warnings\t--trace-warnings"],
])("fails closed for malformed Node tokenization: %s", async (_label, nodeOptions) => {
  const options = startOptions("codex", { env: { NODE_OPTIONS: nodeOptions } });
  await expect(captureBefore(options)).rejects.toThrow("cannot safely parse NODE_OPTIONS");
});

it.each([
  [
    "resource/warning",
    "--max-old-space-size=4096 --no-warnings --disable-warning=ExperimentalWarning",
  ],
  ["Discord network workaround", "--dns-result-order=ipv4first --no-network-family-autoselection"],
  ["underscore aliases", "--dns_result_order ipv6first --network_family_autoselection"],
  ["quoted Node syntax", '"--dns-result-order=verbatim" "" --no-warnings'],
])("allows bounded %s NODE_OPTIONS", async (_label, nodeOptions) => {
  const { command } = await nativeArtifact();
  const options = startOptions(command, { env: { NODE_OPTIONS: nodeOptions } });
  await expect(captureBinding(options)).resolves.toMatchObject({
    binding: { id: expect.stringMatching(/^codex-app-server:v1:/u) },
  });
});

it("binds the Windows npm shim, Node entrypoint, native binary, and adjacent host", async () => {
  const root = makeRoot();
  const nodePath = path.join(root, "node.exe");
  const shimPath = path.join(root, "codex.cmd");
  const entryPath = path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
  const packageRoot = path.join(root, "vendor", "x86_64-pc-windows-msvc");
  const binDir = path.join(packageRoot, "bin");
  const nativePath = path.join(binDir, "codex.exe");
  const hostPath = path.join(binDir, "codex-code-mode-host.exe");
  await writeFixtureFiles({
    [nodePath]: "node-v1",
    [entryPath]: "entry-v1",
    [nativePath]: "native-v1",
    [hostPath]: "host-v1",
    [path.join(packageRoot, "codex-package.json")]: "{}\n",
    [shimPath]: '@ECHO off\r\n"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
  });
  overrideProperty(process, "platform", "win32");
  overrideProperty(process, "execPath", nodePath);
  const options = startOptions("codex", {
    env: {
      PATH: root,
      PATHEXT: ".CMD;.EXE;.BAT",
      Codex_Code_Mode_Host_Path: path.join(root, "retired-host.exe"),
    },
  });
  const { binding } = await captureBinding(options, nativePath);
  for (const filePath of [nodePath, entryPath, nativePath, hostPath]) {
    const original = await fs.readFile(filePath);
    await fs.writeFile(filePath, Buffer.alloc(original.length, "x"));
    await expect(validateArtifact(binding)).resolves.toBe(false);
    await fs.writeFile(filePath, original);
    await expect(validateArtifact(binding)).resolves.toBe(true);
  }
});

it("rejects malformed and oversized server-minted ids without filesystem access", async () => {
  for (const id of ["codex-app-server:v1:wrong", `codex-app-server:v1:${"a".repeat(32 * 1024)}`]) {
    await expect(validateArtifact({ id, fingerprint: "0".repeat(64) })).resolves.toBe(false);
  }
});

it("binds the native executable behind a Windows forwarder independently of path sort order", async () => {
  const root = makeRoot();
  const nativeDir = path.join(root, "z-runtime");
  const command = path.join(root, "a-launch.cmd");
  const host = path.join(nativeDir, "codex-code-mode-host.exe");
  await writeFixtureFiles({
    [command]: '@ECHO off\r\n"%~dp0\\z-runtime\\codex.exe" %*\r\n',
    [path.join(nativeDir, "codex.exe")]: "native-v1",
    [host]: "host-v1",
  });
  overrideProperty(process, "platform", "win32");
  const { binding } = await captureBinding(startOptions(command));
  await expectMutationInvalidates(binding, host, "host-v2");
});

it("rejects packages beyond the bounded directory depth", async () => {
  const { root, command } = await packageArtifact();
  const deep = path.join(root, ...Array.from({ length: 66 }, (_, index) => `d${index}`));
  await fs.mkdir(deep, { recursive: true });
  await fs.writeFile(path.join(deep, "resource"), "x");
  const options = startOptions(command);
  await expect(captureBefore(options)).rejects.toThrow("bounded directory depth");
});

it.runIf(supportsPosix)("rejects symlinks inside a package artifact", async () => {
  const { root, command } = await packageArtifact();
  await fs.symlink(command, path.join(root, "linked-runtime"));
  const options = startOptions(command);
  await expect(captureBefore(options)).rejects.toThrow("unsupported entry");
});
