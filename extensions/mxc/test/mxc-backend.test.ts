import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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

const { spawnCommandMock, mockedHomeDir } = vi.hoisted(() => ({
  spawnCommandMock: vi.fn(),
  mockedHomeDir: { value: undefined as string | undefined },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockedHomeDir.value ?? actual.homedir() };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

// mock-isolation: backend fixtures control command results without launching sandbox processes.
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runCommandBuffered: spawnCommandMock }));

vi.mock("../src/binary-resolver.js", () => ({
  resolveMxcBinaryPath: (configuredPath?: string) => configuredPath ?? "mxc-test-binary",
}));

const baseConfig: MxcConfig = {
  containment: "process",
  network: "none",
  timeoutSeconds: 120,
  timeoutSecondsConfigured: true,
  debug: false,
};

const baseParams = {
  config: baseConfig,
  runtimeId: "openclaw-mxc-test-abc12345",
  workdir: "/workspace",
};
type Handle = ReturnType<typeof createMxcSandboxBackendHandle>;
type HandleOptions = Partial<Parameters<typeof createMxcSandboxBackendHandle>[0]>;
type Payload = {
  config: {
    version: string;
    containerId: string;
    containment: string;
    process: { commandLine: string; cwd: string; timeout: number; env: string[] };
    filesystem: { readonlyPaths: string[]; readwritePaths: string[]; deniedPaths?: string[] };
    network: unknown;
    processContainer: unknown;
    ui: unknown;
    lxc?: unknown;
  };
  options: { debug: boolean; executablePath: string; usePty?: boolean };
};

const describeOnWindows = describe.runIf(process.platform === "win32");

const testDirs: string[] = [];

function makeTestDir(prefix = "mxc-test-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  testDirs.push(dir);
  return dir;
}

function makeHandle(overrides: HandleOptions = {}) {
  return createMxcSandboxBackendHandle({ ...baseParams, ...overrides });
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
  workdir: string,
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

function captureShellCommand() {
  let captured: CapturedCommand | undefined;
  spawnCommandMock.mockImplementationOnce(
    async (argv: string[], options: CapturedCommand["options"]) => {
      const { config } = decodePayload(argv);
      const file = expectDefined(
        /""([^"]+\.cmd)"/u.exec(config.process.commandLine)?.[1],
        "command file",
      );
      captured = { config, file, script: readText(file), options };
      return successfulCommand;
    },
  );
  return () => expectDefined(captured, "captured shell command");
}

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

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function decodePayload(argv: readonly string[]): Payload {
  const file = expectDefined(argv[argv.indexOf("--payload-file") + 1], "launcher payload file");
  const decoded: Payload = JSON.parse(readText(file));
  rmSync(path.dirname(file), { force: true, recursive: true });
  expect(decoded.config).toMatchObject({
    process: { env: expect.any(Array) },
    filesystem: { readonlyPaths: expect.any(Array), readwritePaths: expect.any(Array) },
  });
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
    workspaceDir: baseParams.workdir,
    agentWorkspaceDir: baseParams.workdir,
    cfg: backendConfig(),
    ...overrides,
  });
}

const originalEnv = process.env;
function setEnv(overrides: Record<string, string | undefined>) {
  process.env = { ...originalEnv, ...overrides };
}

test("hashes workspace-qualified scopes without truncating their identity", async () => {
  const handle = await createBackend({ scopeKey: `agent:main:workspace:${"a".repeat(32)}` });

  expect(handle.runtimeId).toMatch(/^openclaw-mxc-workspace-[a-f0-9]{32}$/u);
});

describeOnWindows("createMxcSandboxBackendHandle (Windows-only MXC backend tests)", () => {
  beforeEach(() => {
    spawnCommandMock.mockReset();
    spawnCommandMock.mockResolvedValue(successfulCommand);
    mockedHomeDir.value = makeTestDir("mxc-test-home-");
    baseParams.workdir = makeTestDir("mxc-test-workspace-");
  });

  afterEach(() => {
    process.env = originalEnv;
    mockedHomeDir.value = undefined;
  });

  test("buildExecSpec returns a launcher argv with Windows process containment by default", async () => {
    const handle = makeHandle();
    const spec = await buildSpec(handle);

    expect(spec).toMatchObject({
      argv: [
        process.execPath,
        expect.stringMatching(/mxc-spawn-launcher\.mjs$/),
        "--payload-file",
        expect.any(String),
      ],
      stdinMode: "pipe-closed",
    });
    expect(spec).not.toHaveProperty("requirePty");

    const payload = decodePayload(spec.argv);
    const cfg = payload.config;
    const expectedShell = process.env.ComSpec?.trim() || "cmd.exe";
    expect(cfg).toMatchObject({
      version: "0.7.0-alpha",
      containment: "process",
      process: {
        commandLine: `${expectedShell} /d /s /c "echo hello"`,
        cwd: baseParams.workdir,
        timeout: 120_000,
      },
      network: { defaultPolicy: "block", enforcementMode: "capabilities" },
    });
    expect(cfg.lxc).toBeUndefined();
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
    expect(cfg.filesystem.deniedPaths).toBeUndefined();
    expect(payload.options).toEqual({
      debug: false,
      executablePath: "mxc-test-binary",
      usePty: false,
    });
  });

  test("normalizes agent-tool workdirs before execution", async () => {
    const childDir = path.join(baseParams.workdir, "child");
    mkdirSync(childDir);
    const handle = makeHandle();

    expect(handle.workdirValidation).toBe("backend");
    await expect(handle.validateWorkdir?.(`${baseParams.workdir}/child`)).resolves.toBe(childDir);
    await expect(
      handle.validateWorkdir?.(path.join(baseParams.workdir, "missing")),
    ).resolves.toBeNull();
  });

  test("reports workdirs nested under a file as unavailable instead of throwing", async () => {
    // A file parent surfaces ENOTDIR on Linux (CI truth) and ENOENT on Windows.
    // Both must reach the contract's null result rather than a raw filesystem error.
    const filePath = path.join(baseParams.workdir, "not-a-directory.txt");
    writeFileSync(filePath, "content");
    const handle = makeHandle();

    await expect(handle.validateWorkdir?.(path.join(filePath, "child"))).resolves.toBeNull();
    await expect(handle.validateWorkdir?.(filePath)).resolves.toBeNull();
  });

  test("buildExecSpec keeps command and env payload out of process argv", async () => {
    setEnv({ OPENCLAW_MXC_HOST_SECRET_TEST: "host-secret" });
    const handle = makeHandle();
    const spec = await handle.buildExecSpec({
      command: "printf secret-command",
      env: { SECRET_TOKEN: "secret-env-value" },
      usePty: false,
    });

    const serializedArgv = JSON.stringify(spec.argv);
    expect(serializedArgv).not.toContain("secret-command");
    expect(serializedArgv).not.toContain("SECRET_TOKEN");
    expect(serializedArgv).not.toContain("secret-env-value");
    expect(spec.env.OPENCLAW_MXC_HOST_SECRET_TEST).toBeUndefined();
    expect(spec.argv[2]).toBe("--payload-file");

    const payloadFile = expectDefined(spec.argv[3], "launcher payload");
    expect(readText(payloadFile)).toContain("secret-env-value");
    await finalize(handle, spec.finalizeToken);
    expect(existsSync(path.dirname(payloadFile))).toBe(false);
  });

  test("Windows process containment emits ProcessContainer settings and curated env", async () => {
    setEnv({
      SystemRoot: "C:\\Windows",
      SystemDrive: "C:",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      USERPROFILE: "C:\\Users\\openclaw",
      APPDATA: "C:\\Users\\openclaw\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\openclaw\\AppData\\Local",
      ProgramData: "C:\\ProgramData",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      NUMBER_OF_PROCESSORS: "8",
      OPENCLAW_MXC_SECRET_TEST: "do-not-leak",
    });
    const handle = makeHandle();
    const spec = await handle.buildExecSpec({
      command: "echo hello",
      env: { CUSTOM_ENV: "caller", comspec: "C:\\Tools\\custom-cmd.exe" },
      usePty: false,
    });

    const env = decodePayload(spec.argv).config.process.env;
    expect(env).toEqual(
      expect.arrayContaining([
        "SystemRoot=C:\\Windows",
        "SystemDrive=C:",
        "USERPROFILE=C:\\Users\\openclaw",
        "APPDATA=C:\\Users\\openclaw\\AppData\\Roaming",
        "LOCALAPPDATA=C:\\Users\\openclaw\\AppData\\Local",
        "ProgramData=C:\\ProgramData",
        "ProgramFiles(x86)=C:\\Program Files (x86)",
        "NUMBER_OF_PROCESSORS=8",
        "CUSTOM_ENV=caller",
        "comspec=C:\\Tools\\custom-cmd.exe",
      ]),
    );
    expect(env.filter((entry) => entry.toLowerCase().startsWith("comspec="))).toHaveLength(1);
    expect(env.some((entry) => entry.startsWith("OPENCLAW_MXC_SECRET_TEST="))).toBe(false);
    const envKeys = env.map((entry) => entry.slice(0, entry.indexOf("=")));
    expect(envKeys).toEqual([...envKeys].toSorted((a, b) => a.localeCompare(b)));
  });

  test("buildExecSpec preserves PTY mode in launcher options", async () => {
    const handle = makeHandle();
    const spec = await buildSpec(handle, { usePty: true });

    expect(decodePayload(spec.argv).options).toEqual({
      debug: false,
      executablePath: "mxc-test-binary",
    });
    await finalize(handle, spec.finalizeToken);
  });

  test("network default allows outbound without baseline host-list policy", async () => {
    const cfg = await execConfig({ config: { ...baseConfig, network: "default" } });
    expect(cfg).toMatchObject({
      network: { defaultPolicy: "allow", enforcementMode: "capabilities" },
      processContainer: { capabilities: ["internetClient"] },
    });
  });

  test("Windows process containment caps long AppContainer names", async () => {
    const cfg = await execConfig({
      runtimeId: `openclaw-mxc-${"a".repeat(80)}-12345678`,
    });
    // MXC names the AppContainer profile after the containerId.
    expect(cfg.containerId.length).toBeLessThanOrEqual(64);
  });

  test.each(["none", "ro", "rw"] as const)(
    "workspace access %s honors distinct sandbox and agent roots",
    async (workspaceAccess) => {
      const sandbox = makeTestDir("mxc-distinct-sandbox-");
      const agent = makeTestDir("mxc-distinct-agent-");
      const cfg = await execConfig({ workdir: sandbox, agentWorkspaceDir: agent, workspaceAccess });
      const { readonlyPaths: readonly, readwritePaths: readwrite } = cfg.filesystem;
      if (workspaceAccess === "rw") {
        expect(readwrite).toContain(path.resolve(agent));
        expect(readwrite).not.toContain(path.resolve(sandbox));
        expect(cfg.process.cwd).toBe(path.resolve(agent));
      } else {
        expect(readonly).toContain(path.resolve(sandbox));
        expect(readwrite).not.toContain(path.resolve(agent));
        if (workspaceAccess === "ro") {
          expect(readonly).toContain(path.resolve(agent));
          expect(cfg.process.cwd).toBe(path.resolve(sandbox));
        } else {
          expect(readonly).not.toContain(path.resolve(agent));
        }
      }
    },
  );

  test("policy readwrite paths cannot overlap read-only workspace roots", async () => {
    const skillPath = path.join(baseParams.workdir, "skills");
    mkdirSync(skillPath, { recursive: true });
    const handle = makeHandle({
      config: sandboxPolicyConfig({ filesystem: { additionalReadwritePaths: [skillPath] } }),
      workspaceAccess: "none",
    });

    await expect(buildSpec(handle)).rejects.toThrow(/overlaps read-only path/u);
  });

  test("fails closed when an operator-configured filesystem path disappears before launch", async () => {
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

  test("creates a Windows host-backed filesystem bridge with workspaceAccess rw", async () => {
    const workdir = makeTestDir("mxc-fs-bridge-");
    const bridge = makeBridge(workdir);

    const createFileExclusive = expectDefined(
      bridge.createFileExclusive?.bind(bridge),
      "exclusive create",
    );
    await expect(
      createFileExclusive({ filePath: "notes/exclusive.txt", data: "first" }),
    ).resolves.toBe("created");
    await expect(
      createFileExclusive({ filePath: "notes/exclusive.txt", data: "replacement" }),
    ).resolves.toBe("exists");
    expect(readText(path.join(workdir, "notes", "exclusive.txt"))).toBe("first");
    const raceOutcomes = await Promise.all([
      createFileExclusive({ filePath: "notes/race.txt", data: "one" }),
      createFileExclusive({ filePath: "notes/race.txt", data: "two" }),
    ]);
    expect(raceOutcomes.toSorted()).toEqual(["created", "exists"]);

    const file = { filePath: "notes/one.txt", cwd: workdir };
    await bridge.writeFile({ ...file, data: "hello mxc" });
    expect(await bridge.readFile(file)).toEqual(Buffer.from("hello mxc"));
    await expect(bridge.readFile({ ...file, maxBytes: "hello mxc".length })).resolves.toEqual(
      Buffer.from("hello mxc"),
    );
    await expect(bridge.readFile({ ...file, maxBytes: "hello mxc".length - 1 })).rejects.toThrow();
    expect(await bridge.stat(file)).toMatchObject({ type: "file", size: "hello mxc".length });
    await bridge.rename({ from: "notes/one.txt", to: "notes/two.txt" });
    expect(readText(path.join(workdir, "notes", "two.txt"))).toBe("hello mxc");
    await bridge.remove({ filePath: "notes/two.txt" });
    expect(existsSync(path.join(workdir, "notes", "two.txt"))).toBe(false);
    await expect(
      bridge.writeFile({ filePath: path.join(workdir, "..", "escape.txt"), data: "escape" }),
    ).rejects.toThrow(/Path escapes sandbox root/u);
  });

  test("filesystem bridge protects skill overlays when workspaceAccess is rw", async () => {
    const workdir = makeTestDir("mxc-fs-bridge-skills-sandbox-");
    const agentDir = makeTestDir("mxc-fs-bridge-skills-agent-");
    const skillsDir = makeTestDir("mxc-fs-bridge-materialized-");
    const skill = "skills/demo/SKILL.md",
      mounted = `.openclaw/sandbox-skills/${skill}`;
    const files = [
      [agentDir, skill, "# Workspace skill\n"],
      [agentDir, `.agents/${skill}`, "# Agent skill\n"],
      [skillsDir, skill, "# Materialized skill\n"],
      [workdir, mounted, "# User-owned shadow\n"],
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
    await expect(bridge.readFile({ filePath: mounted })).resolves.toEqual(
      Buffer.from("# Materialized skill\n"),
    );
    await readOnly(bridge.writeFile({ filePath: skill, data: "owned" }));
    await readOnly(bridge.mkdirp({ filePath: "skills/new" }));
    await readOnly(bridge.remove({ filePath: `.agents/${skill}` }));
    await readOnly(
      bridge.rename({ from: "normal.txt", to: path.join(path.dirname(mounted), "new.md") }),
    );
    await readOnly(bridge.rename({ from: skill, to: "normal-skill.md" }));
    expect(files.map(([root, file]) => readText(path.join(root, file)))).toEqual(
      files.map((entry) => entry[2]),
    );
  });

  test("filesystem bridge stat rejects dangling symlinks before missing-file fallback", async () => {
    const workdir = makeTestDir("mxc-fs-bridge-stat-");
    const linkPath = path.join(workdir, "dangling-link");
    const missingTarget = path.join(tmpdir(), "mxc-missing-outside-target");
    if (!trySymlink(missingTarget, linkPath, "file")) {
      return;
    }
    const bridge = makeBridge(workdir);

    await expect(bridge.stat({ filePath: "dangling-link" })).rejects.toThrow(
      /path alias escape blocked/u,
    );
    await expect(bridge.stat({ filePath: "missing.txt" })).resolves.toBeNull();
  });

  test("filesystem bridge rejects mutations through a symlinked parent directory", async () => {
    const workdir = makeTestDir("mxc-fs-bridge-symlink-parent-");
    const outsideDir = makeTestDir("mxc-fs-bridge-symlink-target-");
    const linkPath = path.join(workdir, "outside-link");
    writeFileSync(path.join(workdir, "normal.txt"), "safe");
    writeFileSync(path.join(outsideDir, "victim.txt"), "outside");

    if (!trySymlink(outsideDir, linkPath)) {
      return;
    }

    const bridge = makeBridge(workdir);

    await expect(bridge.mkdirp({ filePath: "outside-link/new-dir" })).rejects.toThrow();
    await expect(bridge.remove({ filePath: "outside-link/victim.txt" })).rejects.toThrow();
    await expect(
      bridge.rename({ from: "normal.txt", to: "outside-link/renamed.txt" }),
    ).rejects.toThrow();
  });

  test.each(["none", "ro"] as const)(
    "filesystem bridge rejects writes when workspace access is %s",
    async (workspaceAccess) => {
      const workdir = makeTestDir("mxc-fs-bridge-ro-");
      const bridge = makeBridge(workdir, { workspaceAccess });

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

  test.each(["outside", "missing", "symlink"])("rejects %s execution workdirs", async (kind) => {
    let workdir =
      kind === "missing"
        ? path.join(baseParams.workdir, "new", "child")
        : makeTestDir("mxc-outside-");
    if (kind === "symlink") {
      const link = path.join(baseParams.workdir, "outside-link");
      if (!trySymlink(workdir, link, "dir", false)) {
        return;
      }
      workdir = link;
    }
    await expect(
      buildSpec(makeHandle(), {
        workdir,
        command: kind === "missing" ? "mkdir child" : "echo hello",
      }),
    ).rejects.toThrow(
      kind === "missing"
        ? /MXC sandbox workdir .*new.*child.* does not exist/u
        : /outside the sandbox workspace/u,
    );
  });

  test("Windows process containment preserves existing policy paths with spaces", async () => {
    const workdir = makeTestDir("mxc-win-dacl-workdir-");
    const readonlyRoot = makeTestDir("mxc-win-dacl-readonly-");
    const existingReadwritePathWithSpace = mkdtempSync(path.join(workdir, "write dir "));
    const existingReadonlyPathWithSpace = mkdtempSync(path.join(readonlyRoot, "secret dir "));
    const existingFile = path.join(readonlyRoot, "secret file.txt");
    writeFileSync(existingFile, "denied file contents");
    const cfg = await execConfig({
      workdir,
      config: sandboxPolicyConfig({
        filesystem: {
          additionalReadwritePaths: [existingReadwritePathWithSpace],
          additionalReadonlyPaths: [existingReadonlyPathWithSpace, existingFile],
        },
      }),
    });
    const { readwritePaths: readwrite, readonlyPaths: readonly } = cfg.filesystem;
    expect(readwrite).toContain(path.resolve(workdir));
    expect(readwrite).toContain(path.resolve(existingReadwritePathWithSpace));
    expect(readonly).toContain(existingReadonlyPathWithSpace);
    expect(readonly).toContain(existingFile);
  });

  test("runShellCommand uses curated Windows env and passes stdin through unchanged", async () => {
    setEnv({
      SystemRoot: "C:\\Windows",
      SystemDrive: "C:",
      USERPROFILE: "C:\\Users\\openclaw",
      OPENCLAW_MXC_SECRET_TEST: "do-not-leak",
    });
    const capture = captureShellCommand();
    await shell({
      args: ["C:\\workspace\\%USERPROFILE%\\file.txt", "0"],
      stdin: "shell-input",
    });

    const {
      config: {
        process: { env, commandLine },
      },
      file,
      script,
      options,
    } = capture();
    expect(script.startsWith("@echo off\r\ntype con")).toBe(true);
    expect(commandLine).toMatch(/ \/c ""[^"]*\.openclaw-mxc-cmd-[^"]+\.cmd" /u);
    expect(commandLine).toContain('"C:\\workspace\\%%USERPROFILE%%\\file.txt" "0"');
    expect(env).toContain("SystemRoot=C:\\Windows");
    expect(env).toContain("SystemDrive=C:");
    expect(env).toContain("USERPROFILE=C:\\Users\\openclaw");
    expect(env.some((entry) => entry.startsWith("OPENCLAW_MXC_SECRET_TEST="))).toBe(false);
    expect(options.baseEnv?.SystemRoot).toBe("C:\\Windows");
    expect(options.baseEnv?.OPENCLAW_MXC_SECRET_TEST).toBeUndefined();
    expect(options.input).toEqual(Buffer.from("shell-input", "utf-8"));
    expect(existsSync(path.dirname(file))).toBe(false);
  });

  test("runShellCommand writes argument bridge files under writable temp for read-only workspaces", async () => {
    const tempRoot = makeTestDir("mxc-cmd-temp-");
    setEnv({ TEMP: tempRoot, TMP: undefined });
    const capture = captureShellCommand();
    await shell({ args: ["0"] }, { workspaceAccess: "ro" });

    const { config, file: commandFile } = capture();
    expect(isPathInside(tempRoot, commandFile)).toBe(true);
    expect(isPathInside(baseParams.workdir, commandFile)).toBe(false);
    const { readwritePaths, readonlyPaths } = config.filesystem;
    const sandboxTempDir = readwritePaths.find((entry) => isPathInside(tempRoot, entry));
    expect(readwritePaths).not.toContain(tempRoot);
    expect(sandboxTempDir).toEqual(expect.any(String));
    expect(sandboxTempDir ? isPathInside(sandboxTempDir, commandFile) : false).toBe(true);
    expect(config.process.env).toEqual(
      expect.arrayContaining([`TEMP=${sandboxTempDir}`, `TMP=${sandboxTempDir}`]),
    );
    expect(readonlyPaths).toContain(path.resolve(baseParams.workdir));
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

  test("runShellCommand rejects abnormal executor results even with a zero code", async () => {
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

  test("factory rejects writable overlays before materialized skill targets exist", async () => {
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

describeOnWindows("mxcSandboxBackendManager (Windows-only MXC backend tests)", () => {
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
  test("fails closed for a missing policy file", () => {
    expect(() => loadPolicy(path.join(makeTestDir(), "missing.json"))).toThrow(/does not exist/u);
  });
  test("layers paths deterministically, retaining provenance and the smallest timeout", () => {
    const dir = makeTestDir();
    const directory = (name: string) => {
      const result = path.join(dir, name);
      mkdirSync(result);
      return result;
    };
    const ro1 = directory("readonly-first"),
      ro2 = directory("readonly-second");
    const rw1 = directory("readwrite-first"),
      shared = directory("readwrite-shared"),
      rw2 = directory("readwrite-second");
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
  });
  test("hardening cannot be disabled", () => {
    expect(() => loadPolicy(writePolicy({ filesystem: { restrictToProjectDir: false } }))).toThrow(
      /restrictToProjectDir/u,
    );
  });
  test.each([
    ["blank read-only", "additionalReadonlyPaths", "   ", "must not be blank"],
    ["relative read-write", "additionalReadwritePaths", "relative\\path", "absolute Windows path"],
    ["nonexistent read-only", "additionalReadonlyPaths", null, "does not exist on the host"],
  ] as const)("fails closed for %s paths", (_name, field, value, detail) => {
    expectPolicyError(
      writePolicy({
        filesystem: { [field]: [value ?? path.join(makeTestDir(), "missing-readonly")] },
      }),
      detail,
    );
  });
  test.each([
    ["{", "Failed to load sandbox policy file at"],
    ["[]", "must be a JSON object"],
    [JSON.stringify({ network: { additionalDeniedHosts: ["metadata"] } }), "is not supported"],
  ])("reports path-inclusive errors for malformed policy %s", (content, detail) => {
    expectPolicyError(writeFixture(makeTestDir(), "policy.json", content), detail);
  });
});
