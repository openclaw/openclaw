import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import {
  createSandboxBrowserConfig,
  createSandboxSshConfig,
  createSandboxTestContext,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveConfig, type MxcConfig } from "../src/config.js";
import { createMxcSandboxBackendFactory } from "../src/mxc-backend-factory.js";
import { createMxcSandboxBackendHandle, mxcSandboxBackendManager } from "../src/mxc-backend.js";
import { loadSandboxBaselinePolicy } from "../src/sandbox-policy-loader.js";

const { spawnCommandMock } = vi.hoisted(() => ({ spawnCommandMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runCommandBuffered: spawnCommandMock,
}));

vi.mock("../src/binary-resolver.js", () => ({
  resolveMxcBinaryPath: (configuredPath?: string) => configuredPath ?? "mxc-test-binary",
}));

const baseConfig = resolveConfig({ timeoutSeconds: 120 });

let cwd = "/workspace";
type Handle = ReturnType<typeof createMxcSandboxBackendHandle>;
type HandleOptions = Partial<Parameters<typeof createMxcSandboxBackendHandle>[0]>;
type Payload = {
  config: {
    containerId: string;
    process: { commandLine: string; cwd: string; timeout: number; env: string[] };
    filesystem: { readonlyPaths: string[]; readwritePaths: string[] };
    network: unknown;
    processContainer: unknown;
    ui: unknown;
  };
  options: { debug: boolean; executablePath: string; usePty?: boolean };
};

const describeOnWindows = describe.runIf(process.platform === "win32");

const testDirs = useAutoCleanupTempDirTracker(afterEach);
const makeTestDir = (prefix = "mxc-test-") => testDirs.make(prefix);

function makeHandle(overrides: HandleOptions = {}) {
  return createMxcSandboxBackendHandle({
    config: baseConfig,
    runtimeId: "openclaw-mxc-test-abc12345",
    workdir: cwd,
    ...overrides,
  });
}

function buildSpec(
  handle: Handle,
  overrides: Partial<Parameters<typeof handle.buildExecSpec>[0]> = {},
) {
  return handle.buildExecSpec({ command: "echo hello", env: {}, usePty: false, ...overrides });
}

async function execConfig(overrides: HandleOptions = {}) {
  return decodePayload((await buildSpec(makeHandle(overrides))).argv).config;
}

async function finalize(handle: Handle, token: unknown) {
  await handle.finalizeExec?.({ status: "completed", exitCode: 0, timedOut: false, token });
}

function makeBridge(
  workdir = cwd,
  overrides: Partial<Parameters<NonNullable<Handle["createFsBridge"]>>[0]["sandbox"]> = {},
) {
  const handle = makeHandle({ workdir });
  const bridge = handle.createFsBridge?.({
    sandbox: {
      workspaceDir: workdir,
      agentWorkspaceDir: workdir,
      workspaceAccess: "rw",
      containerName: handle.runtimeId,
      containerWorkdir: workdir,
      docker: { binds: [] },
      backend: handle,
      ...overrides,
    },
  });
  return expectDefined(bridge, "MXC filesystem bridge");
}

const successfulCommand = {
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
};

type CapturedCommand = {
  config: Payload["config"];
  file: string;
  script: string;
  options: { baseEnv?: NodeJS.ProcessEnv; input?: Uint8Array | string };
};

const readText = (file: string) => readFileSync(file, "utf-8");
function trySymlink(
  target: string,
  link: string,
  kind: "file" | "dir" = "dir",
  verify = true,
): boolean {
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : kind);
  } catch {
    return false;
  }
  return !verify || lstatSync(link).isSymbolicLink();
}

function writeFixture(root: string, relative: string, contents: string) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function sandboxPolicyConfig(policy: unknown, config: MxcConfig = baseConfig): MxcConfig {
  return { ...config, mxcPolicyPaths: [writePolicy(policy)] };
}
const writePolicy = (policy: unknown) =>
  writeFixture(makeTestDir(), "policy.json", JSON.stringify(policy));
const loadPolicy = (...policyPaths: string[]) => loadSandboxBaselinePolicy({ policyPaths });

function decodePayload(argv: readonly string[]): Payload {
  const file = expectDefined(argv[argv.indexOf("--payload-file") + 1], "launcher payload file");
  const decoded: Payload = JSON.parse(readText(file));
  rmSync(path.dirname(file), { force: true, recursive: true });
  return decoded;
}

const shell = (
  params: Partial<Parameters<Handle["runShellCommand"]>[0]> = {},
  overrides: HandleOptions = {},
) =>
  makeHandle(overrides).runShellCommand({
    script: "type con",
    stdin: "",
    allowFailure: false,
    ...params,
  });
const readOnly = (result: Promise<unknown>) => expect(result).rejects.toThrow(/read-only/u);
const rejects = (result: Promise<unknown>, error?: RegExp) => expect(result).rejects.toThrow(error);

function backendConfig(
  overrides: Partial<CreateSandboxBackendParams["cfg"]> = {},
): CreateSandboxBackendParams["cfg"] {
  return {
    mode: "all",
    backend: "mxc",
    scope: "session",
    workspaceAccess: "rw",
    workspaceRoot: "/workspace-root",
    dockerTmpfsSource: "configured",
    docker: createSandboxTestContext().docker,
    ssh: createSandboxSshConfig("/tmp", { updateHostKeys: false }),
    browser: createSandboxBrowserConfig(),
    tools: {},
    prune: { idleHours: 0, maxAgeDays: 0 },
    ...overrides,
  };
}

function createBackend(overrides: Partial<CreateSandboxBackendParams> = {}) {
  return createMxcSandboxBackendFactory(baseConfig)({
    sessionKey: "agent:main:main",
    scopeKey: "mxc-test",
    workspaceDir: cwd,
    agentWorkspaceDir: cwd,
    cfg: backendConfig(),
    ...overrides,
  });
}

const originalEnv = process.env;
function setEnv(overrides: Record<string, string | undefined>) {
  process.env = { ...originalEnv, ...overrides };
}
const windowsEnv = {
  SystemRoot: "C:\\Windows",
  SystemDrive: "C:",
  USERPROFILE: "C:\\Users\\openclaw",
};
const envEntries = (env: Record<string, string>) =>
  Object.entries(env).map(([key, value]) => `${key}=${value}`);
const includes = (actual: readonly string[], expected: readonly string[]) =>
  expect(actual).toEqual(expect.arrayContaining([...expected]));

test("hashes workspace-qualified scopes without truncating their identity", async () => {
  const handle = await createBackend({ scopeKey: `agent:main:workspace:${"a".repeat(32)}` });

  expect(handle.runtimeId).toMatch(/^openclaw-mxc-workspace-[a-f0-9]{32}$/u);
});

describeOnWindows("createMxcSandboxBackendHandle (Windows-only MXC backend tests)", () => {
  beforeEach(() => {
    spawnCommandMock.mockReset().mockResolvedValue(successfulCommand);
    cwd = makeTestDir("mxc-test-workspace-");
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test.each([false, true])("buildExecSpec launcher (PTY=%s)", async (usePty) => {
    const handle = makeHandle();
    const spec = await buildSpec(handle, { usePty });
    expect(spec).toMatchObject({
      argv: [
        process.execPath,
        expect.stringMatching(/mxc-spawn-launcher\.mjs$/),
        "--payload-file",
        expect.any(String),
      ],
      stdinMode: usePty ? "pipe-open" : "pipe-closed",
    });

    const { config: cfg, options } = decodePayload(spec.argv);
    const expectedShell = process.env.ComSpec?.trim() || "cmd.exe";
    expect(cfg).toMatchObject({
      process: {
        commandLine: `${expectedShell} /d /s /c "echo hello"`,
        cwd,
        timeout: 120_000,
      },
      network: { defaultPolicy: "block", enforcementMode: "capabilities" },
    });
    expect(cfg.processContainer).toEqual({
      leastPrivilege: true,
      capabilities: [],
      ui: {
        isolation: "container",
        desktopSystemControl: false,
        systemSettings: "none",
        ime: false,
      },
    });
    expect(cfg.ui).toEqual({ disable: true, clipboard: "none", injection: false });
    expect(options).toEqual({
      debug: false,
      executablePath: "mxc-test-binary",
      ...(!usePty ? { usePty: false } : {}),
    });
    await finalize(handle, spec.finalizeToken);
  });

  test.each(["directory", "missing/child", "file", "file/child", "outside", "symlink"])(
    "validates execution workdir: %s",
    async (kind) => {
      const root = cwd;
      let workdir = kind === "directory" ? `${root}/directory` : path.join(root, kind);
      if (kind === "directory") {
        mkdirSync(workdir);
      }
      if (kind.startsWith("file")) {
        writeFixture(root, "file", "content");
      }
      if (kind === "outside" || kind === "symlink") {
        const outside = makeTestDir();
        if (kind === "outside") {
          workdir = outside;
        } else if (!trySymlink(outside, workdir, "dir", false)) {
          return;
        }
      }
      const handle = makeHandle();
      expect(handle.workdirValidation).toBe("backend");
      await expect(handle.validateWorkdir?.(workdir)).resolves.toBe(
        kind === "directory" ? path.resolve(workdir) : null,
      );
      if (kind !== "directory") {
        await rejects(
          buildSpec(handle, { workdir }),
          kind === "outside" || kind === "symlink"
            ? /outside the sandbox workspace/u
            : kind === "file"
              ? /not a directory/u
              : /does not exist/u,
        );
      }
    },
  );

  test("isolates secret payloads and curates case-insensitive env overrides", async () => {
    const defaults = {
      ...windowsEnv,
      APPDATA: "C:\\Users\\openclaw\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\openclaw\\AppData\\Local",
      ProgramData: "C:\\ProgramData",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      NUMBER_OF_PROCESSORS: "8",
    };
    setEnv({
      ...defaults,
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      OPENCLAW_MXC_SECRET_TEST: "do-not-leak",
      OPENCLAW_MXC_HOST_SECRET_TEST: "host-secret",
    });
    const overrides = {
      CUSTOM_ENV: "caller",
      comspec: "C:\\Tools\\custom-cmd.exe",
      SECRET_TOKEN: "secret-env-value",
    };
    const handle = makeHandle();
    const spec = await buildSpec(handle, { command: "printf secret-command", env: overrides });
    expect(JSON.stringify(spec.argv)).not.toMatch(/secret-command|SECRET_TOKEN|secret-env-value/u);
    expect(spec.env.OPENCLAW_MXC_HOST_SECRET_TEST).toBeUndefined();
    expect(spec.argv[2]).toBe("--payload-file");
    const payloadFile = expectDefined(spec.argv[3], "launcher payload");
    expect(readText(payloadFile)).toContain("secret-env-value");
    const payload: Payload = JSON.parse(readText(payloadFile));
    const env = payload.config.process.env;
    includes(env, envEntries({ ...defaults, ...overrides }));
    expect(env.filter((entry) => entry.toLowerCase().startsWith("comspec="))).toHaveLength(1);
    expect(env.some((entry) => entry.startsWith("OPENCLAW_MXC_SECRET_TEST="))).toBe(false);
    const envKeys = env.map((entry) => entry.slice(0, entry.indexOf("=")));
    expect(envKeys).toEqual([...envKeys].toSorted((a, b) => a.localeCompare(b)));
    await finalize(handle, spec.finalizeToken);
    expect(existsSync(path.dirname(payloadFile))).toBe(false);
  });

  test("default network grants outbound capability", async () => {
    const cfg = await execConfig({ config: { ...baseConfig, network: "default" } });
    expect(cfg).toMatchObject({
      network: { defaultPolicy: "allow", enforcementMode: "capabilities" },
      processContainer: { capabilities: ["internetClient"] },
    });
  });

  test("caps AppContainer names at 64 characters", async () => {
    const cfg = await execConfig({ runtimeId: `openclaw-mxc-${"a".repeat(80)}-12345678` });
    // MXC names the AppContainer profile after the containerId.
    expect(cfg.containerId.length).toBeLessThanOrEqual(64);
  });

  test.each(["none", "ro", "rw"] as const)(
    "mounts distinct workspace roots with %s access",
    async (workspaceAccess) => {
      const sandbox = makeTestDir("mxc-distinct-sandbox-");
      const agent = makeTestDir("mxc-distinct-agent-");
      const cfg = await execConfig({ workdir: sandbox, agentWorkspaceDir: agent, workspaceAccess });
      const { readonlyPaths: readonly, readwritePaths: readwrite } = cfg.filesystem;
      const writable = workspaceAccess === "rw";
      expect(readwrite.includes(path.resolve(agent))).toBe(writable);
      expect(readwrite).not.toContain(path.resolve(sandbox));
      expect(readonly.includes(path.resolve(sandbox))).toBe(!writable);
      expect(readonly.includes(path.resolve(agent))).toBe(workspaceAccess === "ro");
      expect(cfg.process.cwd).toBe(path.resolve(writable ? agent : sandbox));
    },
  );

  test("rejects writable policy paths overlapping read-only roots", async () => {
    const skillPath = path.join(cwd, "skills");
    mkdirSync(skillPath, { recursive: true });
    const handle = makeHandle({
      config: sandboxPolicyConfig({ filesystem: { additionalReadwritePaths: [skillPath] } }),
      workspaceAccess: "none",
    });

    await expect(buildSpec(handle)).rejects.toThrow(/overlaps read-only path/u);
  });

  test("rejects configured paths that disappear before launch", async () => {
    const extraPath = makeTestDir("mxc-disappearing-policy-path-");
    const config = sandboxPolicyConfig({ filesystem: { additionalReadwritePaths: [extraPath] } });
    const handle = makeHandle({ config, workspaceAccess: "none" });

    rmSync(extraPath, { recursive: true, force: true });

    const pending = buildSpec(handle);
    await expect(pending).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining(extraPath) }),
    );
    await expect(pending).rejects.toThrow("additionalReadwritePaths[0]");
  });

  test("filesystem bridge preserves exclusive creates and bounds reads", async () => {
    const bridge = makeBridge();
    const create = (data: string, filePath = "notes/file") =>
      expectDefined(bridge.createFileExclusive?.({ filePath, data }), "exclusive create");
    expect(await create("first")).toBe("created");
    expect(await create("replacement")).toBe("exists");
    expect(readText(path.join(cwd, "notes/file"))).toBe("first");
    expect((await Promise.all([create("one", "race"), create("two", "race")])).toSorted()).toEqual([
      "created",
      "exists",
    ]);
    const file = { filePath: "notes/file", cwd };
    await expect(bridge.readFile({ ...file, maxBytes: 5 })).resolves.toEqual(Buffer.from("first"));
    await rejects(bridge.readFile({ ...file, maxBytes: 4 }));
    expect(await bridge.stat(file)).toMatchObject({ type: "file", size: 5 });
    await bridge.rename({ from: file.filePath, to: "renamed" });
    expect(readText(path.join(cwd, "renamed"))).toBe("first");
    await bridge.remove({ filePath: "renamed" });
    expect(existsSync(path.join(cwd, "renamed"))).toBe(false);
    await expect(
      bridge.writeFile({ filePath: path.join(cwd, "..", "escape.txt"), data: "escape" }),
    ).rejects.toThrow(/Path escapes sandbox root/u);
  });

  test("protects skill mounts from mkdir, remove and rename", async () => {
    const workdir = cwd,
      agentDir = makeTestDir(),
      skillsDir = makeTestDir();
    const skill = "skills/demo/SKILL.md",
      mounted = `.openclaw/sandbox-skills/${skill}`;
    const files = [
      [agentDir, skill, "workspace"],
      [agentDir, `.agents/${skill}`, "agent"],
      [skillsDir, skill, "materialized"],
      [workdir, mounted, "shadow"],
    ] as const;
    for (const [root, file, content] of files) {
      writeFixture(root, file, content);
    }
    const bridge = makeBridge(workdir, {
      agentWorkspaceDir: agentDir,
      skillsWorkspaceDir: skillsDir,
    });

    await bridge.writeFile({ filePath: "normal.txt", data: "ok" });
    expect(readText(path.join(agentDir, "normal.txt"))).toBe("ok");
    expect(existsSync(path.join(workdir, "normal.txt"))).toBe(false);
    // Native-tool read/write and mount shadowing are covered by fs-bridge.test.ts.
    await readOnly(bridge.mkdirp({ filePath: "skills/new" }));
    await readOnly(bridge.remove({ filePath: `.agents/${skill}` }));
    await readOnly(bridge.rename({ from: "normal.txt", to: `${mounted}.new` }));
    await readOnly(bridge.rename({ from: skill, to: "normal-skill.md" }));
    expect(files.map(([root, file]) => readText(path.join(root, file)))).toEqual(
      files.map((entry) => entry[2]),
    );
  });

  test("stat rejects dangling links but accepts missing files", async () => {
    const workdir = cwd;
    const missingTarget = path.join(tmpdir(), "mxc-missing-outside-target");
    if (!trySymlink(missingTarget, path.join(workdir, "dangling-link"), "file")) {
      return;
    }
    const bridge = makeBridge();
    await rejects(bridge.stat({ filePath: "dangling-link" }), /path alias escape blocked/u);
    await expect(bridge.stat({ filePath: "missing.txt" })).resolves.toBeNull();
  });

  test("rejects mutations through symlinked parents", async () => {
    const workdir = cwd,
      outsideDir = makeTestDir();
    writeFixture(workdir, "normal.txt", "safe");
    writeFixture(outsideDir, "victim.txt", "outside");

    if (!trySymlink(outsideDir, path.join(workdir, "outside-link"))) {
      return;
    }

    const bridge = makeBridge();

    await rejects(bridge.mkdirp({ filePath: "outside-link/new-dir" }));
    await rejects(bridge.remove({ filePath: "outside-link/victim.txt" }));
    await rejects(bridge.rename({ from: "normal.txt", to: "outside-link/renamed.txt" }));
  });

  test.each(["none", "ro"] as const)(
    "rejects writes with %s workspace access",
    async (workspaceAccess) => {
      const bridge = makeBridge(cwd, { workspaceAccess });

      await readOnly(bridge.writeFile({ filePath: "notes.txt", data: "blocked" }));
    },
  );

  test.each(["default", "explicit"])("caps %s timeouts at the sandbox baseline", async (mode) => {
    const config = mode === "default" ? resolveConfig({}) : baseConfig;
    const cfg = await execConfig({
      config: sandboxPolicyConfig({ process: { timeoutSeconds: 45 } }, config),
    });
    expect(cfg.process.timeout).toBe(45_000);
  });

  test("runShellCommand isolates its env and argument bridge in writable temp", async () => {
    const tempRoot = makeTestDir();
    setEnv({
      ...windowsEnv,
      TEMP: tempRoot,
      TMP: undefined,
      OPENCLAW_MXC_SECRET_TEST: "do-not-leak",
    });
    const captured: CapturedCommand[] = [];
    spawnCommandMock.mockImplementationOnce(
      async (argv: string[], options: CapturedCommand["options"]) => {
        const { config } = decodePayload(argv);
        const file = expectDefined(
          /""([^"]+\.cmd)"/u.exec(config.process.commandLine)?.[1],
          "command file",
        );
        captured.push({ config, file, script: readText(file), options });
        return successfulCommand;
      },
    );
    await shell(
      {
        args: ["C:\\workspace\\%USERPROFILE%\\file.txt", "0"],
        stdin: "shell-input",
      },
      { workspaceAccess: "ro" },
    );

    const { config, file, script, options } = expectDefined(captured[0], "captured command");
    const { env, commandLine } = config.process;
    expect(script.startsWith("@echo off\r\ntype con")).toBe(true);
    expect(commandLine).toMatch(/ \/c ""[^"]*\.openclaw-mxc-cmd-[^"]+\.cmd" /u);
    expect(commandLine).toContain('"C:\\workspace\\%%USERPROFILE%%\\file.txt" "0"');
    includes(env, envEntries(windowsEnv));
    expect(env.some((entry) => entry.startsWith("OPENCLAW_MXC_SECRET_TEST="))).toBe(false);
    expect(options.baseEnv?.SystemRoot).toBe("C:\\Windows");
    expect(options.baseEnv?.OPENCLAW_MXC_SECRET_TEST).toBeUndefined();
    expect(options.input).toEqual(Buffer.from("shell-input", "utf-8"));
    expect(existsSync(path.dirname(file))).toBe(false);
    expect(isPathInside(tempRoot, file)).toBe(true);
    expect(isPathInside(cwd, file)).toBe(false);
    const { readwritePaths, readonlyPaths } = config.filesystem;
    const sandboxTempDir = readwritePaths.find((entry) => isPathInside(tempRoot, entry));
    expect(readwritePaths).not.toContain(tempRoot);
    expect(sandboxTempDir).toEqual(expect.any(String));
    expect(sandboxTempDir ? isPathInside(sandboxTempDir, file) : false).toBe(true);
    includes(config.process.env, [`TEMP=${sandboxTempDir}`, `TMP=${sandboxTempDir}`]);
    expect(readonlyPaths).toContain(path.resolve(cwd));
  });

  test.each([
    ["exit", 7, null, false, "", 7],
    ["timeout", null, "SIGTERM", true, "partial-", 1],
  ] as const)(
    "preserves %s output when failure is allowed",
    async (kind, code, signal, killed, prefix, expectedCode) => {
      const stdout = Buffer.from(`${prefix}out`),
        stderr = Buffer.from(`${prefix}err`);
      spawnCommandMock.mockResolvedValueOnce({
        code,
        signal,
        killed,
        termination: kind,
        stdout,
        stderr,
      });
      await expect(
        shell({ script: kind === "exit" ? "exit 7" : "sleep", allowFailure: true }),
      ).resolves.toEqual({ stdout, stderr, code: expectedCode });
    },
  );

  test("rejects abnormal executor results despite exit code zero", async () => {
    spawnCommandMock.mockResolvedValueOnce({
      ...successfulCommand,
      termination: "error",
      stdout: Buffer.from("partial-out"),
      stderr: Buffer.from("partial-err"),
      error: new Error("stdout stream failed"),
    });
    await expect(shell({ script: "echo partial" })).rejects.toMatchObject({
      message: "stdout stream failed",
      status: 1,
      stdout: Buffer.from("partial-out"),
      stderr: Buffer.from("partial-err"),
    });
  });

  test("factory rejects writable overlays before skill targets exist", async () => {
    const workdir = makeTestDir("mxc-factory-workspace-");
    const skillsWorkspaceDir = makeTestDir("mxc-factory-skills-");
    mkdirSync(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });
    const handle = await createBackend({
      workspaceDir: workdir,
      agentWorkspaceDir: workdir,
      skillsWorkspaceDir,
    });

    await expect(buildSpec(handle)).rejects.toThrow(/overlaps read-only path/u);
  });

  test("factory rejects unsupported Docker bind mounts", async () => {
    const cfg = backendConfig({
      workspaceAccess: "none",
      docker: { ...backendConfig().docker, binds: ["/host/path:/workspace/path:ro"] },
    });

    await expect(createBackend({ cfg })).rejects.toThrow(
      /does not support sandbox\.docker\.binds/u,
    );
  });
});

describeOnWindows("mxcSandboxBackendManager", () => {
  test("describeRuntime reports per-command runtimes as not running", async () => {
    const info = await mxcSandboxBackendManager.describeRuntime({
      entry: {} as never,
      config: {} as never,
    });
    expect(info).toMatchObject({
      running: false,
      actualConfigLabel: "mxc-process",
      configLabelMatch: true,
    });
  });
});

function expectPolicyError(file: string, detail: string) {
  try {
    loadPolicy(file);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: expect.stringContaining(file) });
    expect(error).toMatchObject({ message: expect.stringContaining(detail) });
    return;
  }
  throw new Error("Expected policy loader failure.");
}

describeOnWindows("sandbox policy admission", () => {
  test("layers policy paths with spaces, retaining provenance and the smallest timeout", async () => {
    const ro1 = makeTestDir("read only-"),
      ro2 = writeFixture(makeTestDir(), "secret file.txt", "readonly");
    const rw1 = makeTestDir("write dir-"),
      shared = makeTestDir(),
      rw2 = makeTestDir();
    const first = writePolicy({
      filesystem: {
        additionalReadonlyPaths: [`  ${ro1}  `],
        additionalReadwritePaths: [rw1, shared],
      },
      process: { timeoutSeconds: 90 },
    });
    const second = writePolicy({
      filesystem: { additionalReadonlyPaths: [ro2], additionalReadwritePaths: [rw2, shared] },
      process: { timeoutSeconds: 120 },
    });
    const policy = loadPolicy(first, second);
    const source = (file: string, index: number) =>
      `${file}.filesystem.additionalReadwritePaths[${index}]`;
    expect(policy.configuredPaths.readonlyPaths.map((entry) => entry.path)).toEqual([ro1, ro2]);
    expect(policy.configuredPaths.readwritePaths).toEqual([
      { path: rw1, sources: [source(first, 0)] },
      { path: shared, sources: [source(first, 1), source(second, 1)] },
      { path: rw2, sources: [source(second, 0)] },
    ]);
    expect(policy.process.timeoutSeconds).toBe(90);
    const workdir = makeTestDir();
    const cfg = await execConfig({
      workdir,
      config: { ...baseConfig, mxcPolicyPaths: [first, second] },
    });
    includes(cfg.filesystem.readwritePaths, [path.resolve(workdir), rw1, shared, rw2]);
    includes(cfg.filesystem.readonlyPaths, [ro1, ro2]);
  });
  test.each([
    [undefined, "does not exist"],
    ["{", "Failed to load sandbox policy file at"],
    ["[]", "must be a JSON object"],
    [JSON.stringify({ network: { additionalDeniedHosts: ["metadata"] } }), "is not supported"],
    [JSON.stringify({ filesystem: { restrictToProjectDir: false } }), "restrictToProjectDir"],
    [JSON.stringify({ filesystem: { additionalReadonlyPaths: [" "] } }), "must not be blank"],
    [
      JSON.stringify({ filesystem: { additionalReadwritePaths: ["relative"] } }),
      "absolute Windows path",
    ],
    ["missing-path", "does not exist on the host"],
  ] as const)("fails closed with path-inclusive policy errors: %s", (content, detail) => {
    const file = path.join(makeTestDir(), "policy.json");
    if (content !== undefined) {
      writeFileSync(
        file,
        content === "missing-path"
          ? JSON.stringify({
              filesystem: { additionalReadonlyPaths: [path.join(makeTestDir(), "missing")] },
            })
          : content,
      );
    }
    expectPolicyError(file, detail);
  });
});
