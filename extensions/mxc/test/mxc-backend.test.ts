import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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

const { spawnCommandMock, mockedHomeDir } = vi.hoisted(() => ({
  spawnCommandMock: vi.fn(),
  mockedHomeDir: { value: undefined as string | undefined },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockedHomeDir.value ?? actual.homedir(),
  };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandBuffered: spawnCommandMock,
}));

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

const describeOnWindows = describe.runIf(process.platform === "win32");

const testDirs: string[] = [];

function makeTestDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  testDirs.push(dir);
  return dir;
}

function makeHandle(overrides: Partial<Parameters<typeof createMxcSandboxBackendHandle>[0]> = {}) {
  return createMxcSandboxBackendHandle({ ...baseParams, ...overrides });
}

function buildSpec(
  handle: ReturnType<typeof makeHandle>,
  overrides: Partial<Parameters<typeof handle.buildExecSpec>[0]> = {},
) {
  return handle.buildExecSpec({ command: "echo hello", env: {}, usePty: false, ...overrides });
}

async function buildConfig(handle: ReturnType<typeof makeHandle>) {
  return decodeConfig((await buildSpec(handle)).argv);
}

async function finalize(handle: ReturnType<typeof makeHandle>, token: unknown) {
  await handle.finalizeExec?.({ status: "completed", exitCode: 0, timedOut: false, token });
}

function makeBridge(
  workdir: string,
  overrides: Partial<
    Parameters<NonNullable<ReturnType<typeof makeHandle>["createFsBridge"]>>[0]["sandbox"]
  > = {},
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
  expect(bridge).toBeDefined();
  return bridge;
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
  config: Record<string, unknown>;
  process: Record<string, unknown>;
  file: string;
  script: string;
  options: { baseEnv?: NodeJS.ProcessEnv; input?: Uint8Array | string };
};

function captureShellCommand() {
  let captured: CapturedCommand | undefined;
  spawnCommandMock.mockImplementationOnce(
    async (argv: string[], options: CapturedCommand["options"]) => {
      const config = decodeConfig(argv);
      const process = object(config, "process");
      const file = expectDefined(
        /""([^"]+\.cmd)"/u.exec(String(process.commandLine))?.[1],
        "command file",
      );
      captured = { config, process, file, script: readText(file), options };
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
  const dir = makeTestDir("mxc-policy-");
  const policyPath = path.join(dir, "policy.json");
  writeFileSync(policyPath, `${JSON.stringify(policy)}\n`, "utf-8");
  return {
    ...config,
    mxcPolicyPaths: [policyPath],
  };
}

function decodePayload(argv: readonly string[]): {
  config: Record<string, unknown>;
  options: Record<string, unknown>;
} {
  const file = expectDefined(argv[argv.indexOf("--payload-file") + 1], "launcher payload file");
  const decoded = JSON.parse(readText(file)) as {
    config: Record<string, unknown>;
    options: Record<string, unknown>;
  };
  rmSync(path.dirname(file), { force: true, recursive: true });
  return decoded;
}

function decodeConfig(argv: readonly string[]): Record<string, unknown> {
  return decodePayload(argv).config;
}

function object(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  expect(field).toEqual(expect.any(Object));
  return field as Record<string, unknown>;
}

function strings(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  expect(field).toEqual(expect.any(Array));
  return field as string[];
}

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

const MXC_TEST_ENV_KEYS = [
  "APPDATA",
  "ComSpec",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OPENCLAW_MXC_HOST_SECRET_TEST",
  "OPENCLAW_MXC_SECRET_TEST",
  "ProgramData",
  "ProgramFiles(x86)",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
] as const;

type MxcTestEnvKey = (typeof MXC_TEST_ENV_KEYS)[number];

async function withProcessEnv(
  overrides: Partial<Record<MxcTestEnvKey, string | undefined>>,
  run: () => Promise<void>,
): Promise<void> {
  const originalEnv = process.env;
  // Synthetic host variables belong to the fixture, not the native Windows environment.
  process.env = { ...originalEnv, ...overrides };
  try {
    await run();
  } finally {
    process.env = originalEnv;
  }
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
    mockedHomeDir.value = undefined;
    for (const dir of testDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("buildExecSpec returns a launcher argv with Windows process containment by default", async () => {
    const handle = makeHandle();
    const spec = await buildSpec(handle);

    expect(spec.argv[0]).toBe(process.execPath);
    expect(spec.argv[1]).toMatch(/mxc-spawn-launcher\.mjs$/);
    expect(spec.argv[2]).toBe("--payload-file");
    expect(spec.argv.length).toBe(4);
    expect(spec.stdinMode).toBe("pipe-closed");
    expect((spec as { requirePty?: boolean }).requirePty).toBeUndefined();

    const payload = decodePayload(spec.argv);
    const cfg = payload.config;
    const filesystem = object(cfg, "filesystem");
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
    expect(cfg.ui).toEqual({
      disable: true,
      clipboard: "none",
      injection: false,
    });
    expect(filesystem.deniedPaths).toBeUndefined();
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
    await withProcessEnv({ OPENCLAW_MXC_HOST_SECRET_TEST: "host-secret" }, async () => {
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

      const payloadFile = spec.argv[3];
      expect(payloadFile).toEqual(expect.any(String));
      if (payloadFile === undefined) {
        throw new Error("expected launcher payload file");
      }
      expect(readText(payloadFile)).toContain("secret-env-value");
      if (process.platform !== "win32") {
        expect(statSync(payloadFile).mode & 0o777).toBe(0o600);
      }
      await finalize(handle, spec.finalizeToken);
      expect(existsSync(path.dirname(payloadFile))).toBe(false);
    });
  });

  test("Windows process containment emits ProcessContainer settings and curated env", async () => {
    await withProcessEnv(
      {
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
      },
      async () => {
        const handle = makeHandle();
        const spec = await handle.buildExecSpec({
          command: "echo hello",
          env: { CUSTOM_ENV: "caller", comspec: "C:\\Tools\\custom-cmd.exe" },
          usePty: false,
        });

        const cfg = decodeConfig(spec.argv);
        const env = strings(object(cfg, "process"), "env");
        expect(cfg).toMatchObject({
          containment: "process",
          processContainer: {
            ui: { isolation: "container" },
            leastPrivilege: true,
            capabilities: [],
          },
          network: { enforcementMode: "capabilities" },
        });
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
      },
    );
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
    const handle = makeHandle({
      config: { ...baseConfig, network: "default" },
    });

    const cfg = await buildConfig(handle);
    const network = object(cfg, "network");
    const processContainer = object(cfg, "processContainer");
    expect(network.defaultPolicy).toBe("allow");
    expect(network.enforcementMode).toBe("capabilities");
    expect(processContainer.capabilities).toEqual(["internetClient"]);
  });

  test("Windows process containment caps long AppContainer names", async () => {
    const handle = makeHandle({
      runtimeId: `openclaw-mxc-${"a".repeat(80)}-12345678`,
    });
    const spec = await buildSpec(handle);

    // MXC names the AppContainer profile after the containerId.
    const cfg = decodeConfig(spec.argv);
    expect(String(cfg.containerId).length).toBeLessThanOrEqual(64);
  });

  test.each(["none", "ro", "rw"] as const)(
    "workspace access %s honors distinct sandbox and agent roots",
    async (workspaceAccess) => {
      const sandbox = makeTestDir("mxc-distinct-sandbox-");
      const agent = makeTestDir("mxc-distinct-agent-");
      const cfg = await buildConfig(
        makeHandle({ workdir: sandbox, agentWorkspaceDir: agent, workspaceAccess }),
      );
      const filesystem = object(cfg, "filesystem");
      const readonly = strings(filesystem, "readonlyPaths");
      const readwrite = strings(filesystem, "readwritePaths");
      if (workspaceAccess === "rw") {
        expect(readwrite).toContain(path.resolve(agent));
        expect(readwrite).not.toContain(path.resolve(sandbox));
        expect(object(cfg, "process").cwd).toBe(path.resolve(agent));
      } else {
        expect(readonly).toContain(path.resolve(sandbox));
        expect(readwrite).not.toContain(path.resolve(agent));
        if (workspaceAccess === "ro") {
          expect(readonly).toContain(path.resolve(agent));
          expect(object(cfg, "process").cwd).toBe(path.resolve(sandbox));
        } else {
          expect(readonly).not.toContain(path.resolve(agent));
        }
      }
    },
  );

  test("workspaceAccess rw fails closed before materialized skill targets can be created", async () => {
    const workdir = makeTestDir("mxc-protected-skills-missing-target-");
    const skillsWorkspaceDir = makeTestDir("mxc-materialized-skills-source-");
    mkdirSync(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });
    const handle = makeHandle({
      workdir,
      agentWorkspaceDir: workdir,
      skillsWorkspaceDir,
      workspaceAccess: "rw",
    });

    await expect(buildSpec(handle)).rejects.toThrow(/overlaps read-only path/u);
  });

  test("policy readwrite paths cannot overlap read-only workspace roots", async () => {
    const skillPath = path.join(baseParams.workdir, "skills");
    mkdirSync(skillPath, { recursive: true });
    const handle = makeHandle({
      config: sandboxPolicyConfig({
        filesystem: {
          additionalReadwritePaths: [skillPath],
        },
      }),
      workspaceAccess: "none",
    });

    await expect(buildSpec(handle)).rejects.toThrow(/overlaps read-only path/u);
  });

  test("fails closed when an operator-configured filesystem path disappears before launch", async () => {
    const extraPath = makeTestDir("mxc-disappearing-policy-path-");
    const config = sandboxPolicyConfig({
      filesystem: {
        additionalReadwritePaths: [extraPath],
      },
    });
    const handle = makeHandle({
      config,
      workspaceAccess: "none",
    });

    rmSync(extraPath, { recursive: true, force: true });

    try {
      await buildSpec(handle);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(extraPath);
      expect((err as Error).message).toContain("additionalReadwritePaths[0]");
      return;
    }
    throw new Error("Expected buildExecSpec to fail for the missing configured path.");
  });

  test("creates a Windows host-backed filesystem bridge with workspaceAccess rw", async () => {
    const workdir = makeTestDir("mxc-fs-bridge-");
    const bridge = makeBridge(workdir);

    const createFileExclusive = bridge?.createFileExclusive?.bind(bridge);
    expect(createFileExclusive).toBeTypeOf("function");
    await expect(
      createFileExclusive!({ filePath: "notes/exclusive.txt", data: "first", cwd: workdir }),
    ).resolves.toBe("created");
    await expect(
      createFileExclusive!({
        filePath: "notes/exclusive.txt",
        data: "replacement",
        cwd: workdir,
      }),
    ).resolves.toBe("exists");
    expect(readText(path.join(workdir, "notes", "exclusive.txt"))).toBe("first");
    const raceOutcomes = await Promise.all([
      createFileExclusive!({ filePath: "notes/race.txt", data: "one", cwd: workdir }),
      createFileExclusive!({ filePath: "notes/race.txt", data: "two", cwd: workdir }),
    ]);
    expect(raceOutcomes.toSorted()).toEqual(["created", "exists"]);

    const file = { filePath: "notes/one.txt", cwd: workdir };
    await bridge?.writeFile({ ...file, data: "hello mxc" });
    expect(await bridge?.readFile(file)).toEqual(Buffer.from("hello mxc"));
    await expect(bridge?.readFile({ ...file, maxBytes: "hello mxc".length })).resolves.toEqual(
      Buffer.from("hello mxc"),
    );
    await expect(bridge?.readFile({ ...file, maxBytes: "hello mxc".length - 1 })).rejects.toThrow();
    expect(await bridge?.stat(file)).toMatchObject({
      type: "file",
      size: "hello mxc".length,
    });
    await bridge?.rename({ from: "notes/one.txt", to: "notes/two.txt", cwd: workdir });
    expect(readText(path.join(workdir, "notes", "two.txt"))).toBe("hello mxc");
    await bridge?.remove({ filePath: "notes/two.txt", cwd: workdir });
    expect(existsSync(path.join(workdir, "notes", "two.txt"))).toBe(false);
    await expect(
      bridge?.writeFile({
        filePath: path.join(workdir, "..", "escape.txt"),
        data: "escape",
        cwd: workdir,
      }),
    ).rejects.toThrow(/Path escapes sandbox root/u);
  });

  test("filesystem bridge blocks a distinct agent workspace when workspaceAccess is none", async () => {
    const sandboxWorkdir = mkdtempSync(path.join(tmpdir(), "mxc-fs-bridge-none-sandbox-"));
    const agentWorkspaceDir = mkdtempSync(path.join(tmpdir(), "mxc-fs-bridge-none-agent-"));
    const isolatedFile = path.join(sandboxWorkdir, "isolated.txt");
    const agentFile = path.join(agentWorkspaceDir, "agent.txt");
    writeFileSync(isolatedFile, "sandbox-only");
    writeFileSync(agentFile, "agent-secret");

    try {
      const handle = createMxcSandboxBackendHandle({
        ...baseParams,
        workdir: sandboxWorkdir,
        agentWorkspaceDir,
        workspaceAccess: "none",
      });
      const bridge = handle.createFsBridge?.({
        sandbox: {
          workspaceDir: sandboxWorkdir,
          agentWorkspaceDir,
          workspaceAccess: "none",
          containerName: handle.runtimeId,
          containerWorkdir: sandboxWorkdir,
          docker: { binds: [] },
          backend: handle,
        },
      });
      expect(bridge).toBeDefined();

      await expect(
        bridge?.readFile({ filePath: "isolated.txt", cwd: sandboxWorkdir }),
      ).resolves.toEqual(Buffer.from("sandbox-only"));
      await expect(bridge?.readFile({ filePath: agentFile, cwd: sandboxWorkdir })).rejects.toThrow(
        /Path escapes sandbox root/u,
      );
    } finally {
      rmSync(sandboxWorkdir, { recursive: true, force: true });
      rmSync(agentWorkspaceDir, { recursive: true, force: true });
    }
  });

  test("filesystem bridge exposes a distinct agent workspace as read-only when workspaceAccess is ro", async () => {
    const sandboxWorkdir = mkdtempSync(path.join(tmpdir(), "mxc-fs-bridge-ro-sandbox-"));
    const agentWorkspaceDir = mkdtempSync(path.join(tmpdir(), "mxc-fs-bridge-ro-agent-"));
    const agentFile = path.join(agentWorkspaceDir, "agent.txt");
    writeFileSync(agentFile, "agent-readable");

    try {
      const handle = createMxcSandboxBackendHandle({
        ...baseParams,
        workdir: sandboxWorkdir,
        agentWorkspaceDir,
        workspaceAccess: "ro",
      });
      const bridge = handle.createFsBridge?.({
        sandbox: {
          workspaceDir: sandboxWorkdir,
          agentWorkspaceDir,
          workspaceAccess: "ro",
          containerName: handle.runtimeId,
          containerWorkdir: sandboxWorkdir,
          docker: { binds: [] },
          backend: handle,
        },
      });
      expect(bridge).toBeDefined();

      await expect(bridge?.readFile({ filePath: agentFile, cwd: sandboxWorkdir })).resolves.toEqual(
        Buffer.from("agent-readable"),
      );
      await expect(
        bridge?.writeFile({ filePath: agentFile, cwd: sandboxWorkdir, data: "blocked" }),
      ).rejects.toThrow(/read-only/u);
    } finally {
      rmSync(sandboxWorkdir, { recursive: true, force: true });
      rmSync(agentWorkspaceDir, { recursive: true, force: true });
    }
  });

  test("filesystem bridge protects skill overlays when workspaceAccess is rw", async () => {
    const workdir = makeTestDir("mxc-fs-bridge-skills-sandbox-");
    const agentDir = makeTestDir("mxc-fs-bridge-skills-agent-");
    const skillsDir = makeTestDir("mxc-fs-bridge-materialized-");
    const workspaceSkill = writeFixture(agentDir, "skills/demo/SKILL.md", "# Workspace skill\n");
    const agentSkill = writeFixture(agentDir, ".agents/skills/demo/SKILL.md", "# Agent skill\n");
    const materialized = writeFixture(skillsDir, "skills/demo/SKILL.md", "# Materialized skill\n");
    const shadow = writeFixture(
      workdir,
      ".openclaw/sandbox-skills/skills/demo/SKILL.md",
      "# User-owned shadow\n",
    );
    const bridge = makeBridge(workdir, {
      agentWorkspaceDir: agentDir,
      skillsWorkspaceDir: skillsDir,
    });

    await bridge?.writeFile({ filePath: "normal.txt", data: "ok", cwd: workdir });
    expect(readText(path.join(agentDir, "normal.txt"))).toBe("ok");
    expect(existsSync(path.join(workdir, "normal.txt"))).toBe(false);
    await expect(
      bridge?.readFile({
        filePath: ".openclaw/sandbox-skills/skills/demo/SKILL.md",
        cwd: workdir,
      }),
    ).resolves.toEqual(Buffer.from("# Materialized skill\n"));
    await expect(
      bridge?.writeFile({ filePath: "skills/demo/SKILL.md", cwd: workdir, data: "owned" }),
    ).rejects.toThrow(/read-only/u);
    await expect(bridge?.mkdirp({ filePath: "skills/new", cwd: workdir })).rejects.toThrow(
      /read-only/u,
    );
    await expect(
      bridge?.remove({ filePath: ".agents/skills/demo/SKILL.md", cwd: workdir }),
    ).rejects.toThrow(/read-only/u);
    await expect(
      bridge?.rename({
        from: "normal.txt",
        to: ".openclaw/sandbox-skills/skills/demo/new.md",
        cwd: workdir,
      }),
    ).rejects.toThrow(/read-only/u);
    await expect(
      bridge?.rename({
        from: "skills/demo/SKILL.md",
        to: "normal-skill.md",
        cwd: workdir,
      }),
    ).rejects.toThrow(/read-only/u);
    expect(readText(workspaceSkill)).toBe("# Workspace skill\n");
    expect(readText(agentSkill)).toBe("# Agent skill\n");
    expect(readText(materialized)).toBe("# Materialized skill\n");
    expect(readText(shadow)).toBe("# User-owned shadow\n");
  });

  test("filesystem bridge stat rejects dangling symlinks before missing-file fallback", async () => {
    const workdir = makeTestDir("mxc-fs-bridge-stat-");
    const linkPath = path.join(workdir, "dangling-link");
    const missingTarget = path.join(tmpdir(), "mxc-missing-outside-target");
    if (!trySymlink(missingTarget, linkPath, "file")) {
      return;
    }
    const bridge = makeBridge(workdir);

    await expect(bridge?.stat({ filePath: "dangling-link", cwd: workdir })).rejects.toThrow(
      /path alias escape blocked/u,
    );
    await expect(bridge?.stat({ filePath: "missing.txt", cwd: workdir })).resolves.toBeNull();
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

    await expect(
      bridge?.mkdirp({ filePath: "outside-link/new-dir", cwd: workdir }),
    ).rejects.toThrow();
    await expect(
      bridge?.remove({ filePath: "outside-link/victim.txt", cwd: workdir }),
    ).rejects.toThrow();
    await expect(
      bridge?.rename({ from: "normal.txt", to: "outside-link/renamed.txt", cwd: workdir }),
    ).rejects.toThrow();
  });

  test.each(["none", "ro"] as const)(
    "filesystem bridge rejects writes when workspace access is %s",
    async (workspaceAccess) => {
      const workdir = makeTestDir("mxc-fs-bridge-ro-");
      const bridge = makeBridge(workdir, { workspaceAccess });

      await expect(
        bridge?.writeFile({ filePath: "notes.txt", data: "blocked", cwd: workdir }),
      ).rejects.toThrow(/read-only/u);
    },
  );

  test.each(["default", "explicit"])("caps %s timeouts at the sandbox baseline", async (mode) => {
    const config = mode === "default" ? resolveConfig({}) : baseConfig;
    const handle = makeHandle({
      config: sandboxPolicyConfig({ filesystem: {}, process: { timeoutSeconds: 45 } }, config),
    });
    expect(object(await buildConfig(handle), "process").timeout).toBe(45_000);
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
    const handle = makeHandle({
      workdir,
      config: sandboxPolicyConfig({
        filesystem: {
          additionalReadwritePaths: [existingReadwritePathWithSpace],
          additionalReadonlyPaths: [existingReadonlyPathWithSpace, existingFile],
        },
      }),
    });
    const filesystem = object(await buildConfig(handle), "filesystem");
    const readwrite = strings(filesystem, "readwritePaths");
    const readonly = strings(filesystem, "readonlyPaths");
    expect(readwrite).toContain(path.resolve(workdir));
    expect(readwrite).toContain(path.resolve(existingReadwritePathWithSpace));
    expect(readonly).toContain(existingReadonlyPathWithSpace);
    expect(readonly).toContain(existingFile);
  });

  test("runShellCommand uses curated Windows env and passes stdin through unchanged", async () => {
    await withProcessEnv(
      {
        SystemRoot: "C:\\Windows",
        SystemDrive: "C:",
        USERPROFILE: "C:\\Users\\openclaw",
        OPENCLAW_MXC_SECRET_TEST: "do-not-leak",
      },
      async () => {
        const capture = captureShellCommand();
        const handle = makeHandle();

        await handle.runShellCommand({
          script: "type con",
          args: ["C:\\workspace\\%USERPROFILE%\\file.txt", "0"],
          stdin: "shell-input",
          allowFailure: false,
        });

        const { process: proc, file, script, options } = capture();
        const env = strings(proc, "env");
        const commandLine = String(proc.commandLine);
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
      },
    );
  });

  test("runShellCommand writes argument bridge files under writable temp for read-only workspaces", async () => {
    const tempRoot = makeTestDir("mxc-cmd-temp-");
    await withProcessEnv(
      {
        TEMP: tempRoot,
        TMP: undefined,
      },
      async () => {
        const capture = captureShellCommand();
        const handle = makeHandle({
          workspaceAccess: "ro",
        });

        await handle.runShellCommand({
          script: "type con",
          args: ["0"],
          stdin: "",
          allowFailure: false,
        });

        const { process: processConfig, config, file: commandFile } = capture();
        const filesystemConfig = object(config, "filesystem");
        expect(isPathInside(tempRoot, commandFile)).toBe(true);
        expect(isPathInside(baseParams.workdir, commandFile)).toBe(false);
        const readwritePaths = strings(filesystemConfig, "readwritePaths");
        const sandboxTempDir = readwritePaths.find((entry) => isPathInside(tempRoot, entry));
        expect(readwritePaths).not.toContain(tempRoot);
        expect(sandboxTempDir).toEqual(expect.any(String));
        expect(sandboxTempDir ? isPathInside(sandboxTempDir, commandFile) : false).toBe(true);
        expect(strings(processConfig, "env")).toEqual(
          expect.arrayContaining([`TEMP=${sandboxTempDir}`, `TMP=${sandboxTempDir}`]),
        );
        expect(strings(filesystemConfig, "readonlyPaths")).toContain(
          path.resolve(baseParams.workdir),
        );
      },
    );
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
        makeHandle().runShellCommand({
          script: kind === "exit" ? "exit 7" : "sleep",
          stdin: "",
          allowFailure: true,
        }),
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
    const handle = makeHandle();

    await expect(
      handle.runShellCommand({ script: "echo partial", stdin: "", allowFailure: false }),
    ).rejects.toMatchObject({
      message: "stdout stream failed",
      status: 1,
      stdout: Buffer.from("partial-out"),
      stderr: Buffer.from("partial-err"),
    });
  });

  test("factory carries protected skill workspace context into the exec guard", async () => {
    const workdir = makeTestDir("mxc-factory-workspace-");
    const skillsWorkspaceDir = makeTestDir("mxc-factory-skills-");
    mkdirSync(path.join(skillsWorkspaceDir, "skills", "demo"), { recursive: true });
    mkdirSync(path.join(workdir, ".openclaw", "sandbox-skills", "skills", "demo"), {
      recursive: true,
    });
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
      docker: {
        ...backendConfig().docker,
        binds: ["/host/path:/workspace/path:ro"],
      },
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
