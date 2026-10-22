import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { managedGitHubIdentityEnvironment } from "../github-tool-identity-env.js";
import type { CreateSandboxBackendParams, SandboxBackendHandle } from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => ({
  containerState: vi.fn(),
  ensureSandboxContainer: vi.fn(),
  execContainer: vi.fn(),
  execContainerRaw: vi.fn(),
  resolvePodmanSandboxRuntimeInfo: vi.fn(),
  validateSandboxContainerEngineTarget: vi.fn(),
}));

vi.mock("./docker.js", async () => {
  const actual = await vi.importActual<typeof import("./docker.js")>("./docker.js");
  return { ...actual, ...mocks };
});

vi.mock("./container-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./container-engine.js")>()),
  execContainer: mocks.execContainer,
}));

// These fixtures exercise ordinary engine execution; persistent transport ownership
// has its own protocol and real-container boundary proof.
// mock-isolation: Ordinary-engine fixtures must not discover or bind a real persistent Docker transport.
vi.mock("./docker-persistent-target.js", () => ({
  captureDockerPersistentTarget: async () => undefined,
  bindDockerPersistentTarget: vi.fn(),
  readDockerPersistentContainer: vi.fn(),
}));

const {
  createDockerSandboxBackend,
  createPodmanSandboxBackend,
  dockerSandboxBackendManager,
  podmanSandboxBackendManager,
} = await import("./docker-backend.js");

const containerId = "a".repeat(64);
const scopeKey = `agent:coder:workspace:${"a".repeat(32)}`;
const readOnlyResourceMounts = [
  { hostPath: "/host/attachments", containerPath: "/openclaw/attachments" },
];
const completed = { status: "completed", exitCode: 0, timedOut: false } as const;
const localTarget = { key: "local", globalArgs: [] };

function createConfig(backend?: "docker" | "podman", browserEnabled = true): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope: "session",
          workspaceAccess: "none",
          backend,
          docker: { image: "openclaw-sandbox:trixie-slim" },
          browser: {
            enabled: browserEnabled,
            image: "openclaw-sandbox-browser:trixie-slim",
          },
        },
      },
      entries: {},
    },
  };
}

function backendParams(
  overrides: Partial<CreateSandboxBackendParams> = {},
): CreateSandboxBackendParams {
  return {
    sessionKey: "agent:coder:main",
    scopeKey: "agent:coder:main",
    workspaceDir: "/workspace",
    agentWorkspaceDir: "/workspace",
    cfg: resolveSandboxConfigForAgent(createConfig()),
    ...overrides,
  };
}

async function createDockerExecBackend() {
  provision();
  return createDockerSandboxBackend(backendParams({ scopeKey, readOnlyResourceMounts }));
}

const finalize = (backend: SandboxBackendHandle, token: unknown) =>
  backend.finalizeExec?.({ ...completed, token });
const envFile = (spec: { argv: string[] }) => spec.argv[spec.argv.indexOf("--env-file") + 1]!;

function assertStaged(staged: string, expected: Record<string, string>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(staged).toContain(`${key}=${value}\n`);
  }
}

const mount = (type: string, source: string, destination: string, writable = true) => ({
  Type: type,
  Source: source,
  Destination: destination,
  RW: writable,
});

function assertMasked(
  bridge: { resolvePath: (input: { filePath: string }) => unknown },
  paths: string[],
) {
  for (const filePath of paths) {
    expect(() => bridge.resolvePath({ filePath })).toThrow("container-only");
  }
}

function provision(containerName = "sandbox-container") {
  mocks.ensureSandboxContainer.mockResolvedValueOnce({ containerName, containerId });
}

const bind = (source: string, target: string, writable: boolean) => ({ source, target, writable });
const engineResult = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const rawResult = (code = 0, stderr = "") => ({
  code,
  stdout: Buffer.alloc(0),
  stderr: Buffer.from(stderr),
});

function launch(spec: { argv: string[]; env?: NodeJS.ProcessEnv }, cwd: string) {
  const {
    status: code,
    stdout,
    stderr,
    error,
  } = spawnSync(spec.argv[0]!, spec.argv.slice(1), {
    cwd,
    env: { ...spec.env, PATH: `${cwd}${path.delimiter}${process.env.PATH}` },
    encoding: "utf8",
  });
  if (error) {
    throw error;
  }
  return { code, stdout, stderr };
}

async function mountedBridge(
  binds: ReturnType<typeof bind>[],
  tmpfs: Partial<Record<string, string>>,
  table: string,
  extraMounts: { Type: string; Source: string; Destination: string; RW: boolean }[] = [],
) {
  mocks.execContainer
    .mockResolvedValueOnce(
      engineResult(
        JSON.stringify({
          Mounts: [
            mount("bind", "/host/project", "/workspace"),
            ...extraMounts,
            ...binds.map(({ source, target, writable }) => mount("bind", source, target, writable)),
          ],
          Tmpfs: tmpfs,
        }),
      ),
    )
    .mockResolvedValueOnce(
      engineResult(
        "1 1 0:1 / / rw - overlay overlay rw\n2 1 8:1 /project /workspace rw - ext4 /dev/root rw\n" +
          table,
      ),
    );
  const backend = await createDockerExecBackend();
  return backend.createFsBridge!({
    sandbox: {
      workspaceDir: "/host/project",
      agentWorkspaceDir: "/host/project",
      workspaceAccess: "rw",
      containerName: backend.runtimeId,
      containerWorkdir: "/workspace",
      docker: {
        binds: binds.map(
          ({ source, target, writable }) => `${source}:${target}:${writable ? "rw" : "ro"}`,
        ),
      },
      backend,
    },
  });
}

function runtimeEntry(backendId = "docker") {
  const containerName = backendId === "podman" ? "sandbox-podman" : "sandbox-1";
  return {
    containerName,
    backendId,
    runtimeLabel: containerName,
    sessionKey: "agent:coder:main",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "openclaw-sandbox:trixie-slim",
    ...(backendId === "podman" ? { backendTarget: localTarget } : {}),
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.containerState.mockResolvedValue({ exists: true, running: true });
  mocks.execContainer.mockImplementation(async (_engine, args: string[]) => ({
    code: 0,
    stdout: args.includes('{"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}')
      ? JSON.stringify({ Mounts: [], Tmpfs: null })
      : args.includes("{{.Id}}")
        ? containerId
        : args.includes("/proc/self/mountinfo")
          ? "1 1 0:1 / / rw - overlay overlay rw\n2 1 8:1 /workspace /workspace rw - ext4 /dev/root rw\n"
          : "unused-image",
    stderr: "",
  }));
  mocks.resolvePodmanSandboxRuntimeInfo.mockResolvedValue({
    machine: false,
    rootless: true,
    target: localTarget,
  });
});

it.each(["allocation", "mount inspection", "engine validation"] as const)(
  "rechecks authority after awaited %s",
  async (stage) => {
    let current = true;
    const message = stage === "engine validation" ? "runtime revoked" : "runtime retired";
    const execute = mocks.execContainer.getMockImplementation()!;
    mocks.execContainer.mockImplementation(async (engine, args, options) => {
      const result = await execute(engine, args, options);
      if (
        stage === "mount inspection" &&
        args[0] === "inspect" &&
        args.some((arg: string) => arg.includes("Mounts"))
      ) {
        current = false;
      }
      return result;
    });
    mocks.ensureSandboxContainer.mockImplementationOnce(async () => {
      if (stage === "allocation") {
        current = false;
      }
      return { containerName: "sandbox-container", containerId };
    });
    const operation = createDockerSandboxBackend(
      backendParams({
        assertRuntimeCurrent: () => {
          if (!current) {
            throw new Error(message);
          }
        },
      }),
    );
    if (stage === "engine validation") {
      const backend = await operation;
      mocks.validateSandboxContainerEngineTarget.mockImplementationOnce(async () => {
        await Promise.resolve();
        current = false;
      });
      await expect(backend.runShellCommand({ script: "write should not run" })).rejects.toThrow(
        message,
      );
      expect(mocks.execContainerRaw).not.toHaveBeenCalled();
    } else {
      await expect(operation).rejects.toThrow(message);
      expect(mocks.execContainer.mock.calls.some(([, args]) => args[0] === "exec")).toBe(false);
    }
  },
);

it.each(["cleanup", "filesystem"])("pins %s to the allocated generation", async (operation) => {
  const execute = mocks.execContainer.getMockImplementation()!;
  mocks.execContainer.mockImplementation(async (engine, args, options) => {
    if (args.includes("{{.Id}}") && args.at(-1) === "sandbox-container") {
      return engineResult("b".repeat(64));
    }
    return execute(engine, args, options);
  });
  const backend = await createDockerExecBackend();
  mocks.execContainerRaw.mockResolvedValueOnce(rawResult());
  if (operation === "cleanup") {
    await backend.prepareProcessCleanup!({}).terminate();
  } else {
    await backend.runShellCommand({ script: "true" });
  }
  expect(mocks.execContainerRaw.mock.calls.at(-1)?.[1]?.[2]).toBe(containerId);
});

it.each(["removed", "stopped", "paused", "unreachable", "still present"] as const)(
  "settles cleanup only after confirmed termination: %s",
  async (state) => {
    const backend = await createDockerExecBackend();
    const cleanup = backend.prepareProcessCleanup!({});
    mocks.execContainerRaw.mockResolvedValueOnce(rawResult(125, "exec failed"));
    mocks.execContainer.mockResolvedValueOnce({
      code: state === "removed" || state === "unreachable" ? 1 : 0,
      stdout: JSON.stringify({
        Running: state === "still present",
        Paused: state === "paused",
        Pid: state === "stopped" ? 0 : 123,
      }),
      stderr: state === "removed" ? `Error: No such object: ${containerId}` : "engine unreachable",
    });
    if (state === "removed" || state === "stopped") {
      await expect(cleanup.terminate()).resolves.toBeUndefined();
    } else if (state === "unreachable") {
      await expect(cleanup.terminate()).rejects.toThrow("engine unreachable");
    } else {
      await expect(cleanup.terminate()).rejects.toThrow("exec failed");
    }
    expect(mocks.execContainer.mock.calls.at(-1)?.[1]).toEqual([
      "inspect",
      "-f",
      "{{json .State}}",
      containerId,
    ]);
  },
);

it("captures volume masks once after provisioning", async () => {
  const bridge = await mountedBridge(
    [bind("/host/export", "/workspace/cache/export", false)],
    { "/tmp": "rw" },
    "3 2 8:1 /volume /workspace/cache rw - ext4 /dev/root rw\n4 3 8:1 /export /workspace/cache/export ro - ext4 /dev/root rw",
    [mount("volume", "/engine/volume", "/workspace/cache")],
  );
  assertMasked(bridge, ["cache/marker", "/workspace/cache/marker"]);
  expect(bridge.resolvePath({ filePath: "cache/export/marker" }).hostPath).toBe(
    path.resolve("/host/export/marker"),
  );
  expect(mocks.execContainer).toHaveBeenCalledTimes(2);
  expect(mocks.ensureSandboxContainer.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.execContainer.mock.invocationCallOrder[0]!,
  );
});

type MaskFixture = {
  name: string;
  binds?: ReturnType<typeof bind>[];
  tmpfs?: Partial<Record<string, string>>;
  table: string;
  masked?: string[];
  readable?: string[];
};
it.each<MaskFixture>([
  {
    name: "tmpfs destination alias and retained retarget",
    tmpfs: { "/workspace/link": "rw" },
    table: "3 2 0:9 / /workspace/cache rw - tmpfs tmpfs rw",
    masked: ["/workspace/link/marker", "/workspace/cache/marker"],
    readable: ["/workspace/other/marker"],
  },
  {
    name: "different backing stacked on a declared bind",
    binds: [
      bind("/host/cache", "/workspace/cache", true),
      bind("/host/hidden", "/workspace/cache/hidden", true),
      bind("/host/live", "/workspace/cache/live", true),
    ],
    tmpfs: { "/workspace/aliases/link": "rw" },
    table: `3 2 8:1 /cache /workspace/cache rw - ext4 /dev/root rw
4 3 8:1 /hidden /workspace/cache/hidden rw - ext4 /dev/root rw
5 3 0:9 / /workspace/cache rw - tmpfs tmpfs rw
6 5 8:1 /live /workspace/cache/live rw - ext4 /dev/root rw`,
    masked: ["/workspace/cache/marker", "/workspace/cache/hidden/marker"],
    readable: ["/workspace/cache/live/marker"],
  },
  {
    name: "intervening tmpfs hides an older sibling bind",
    binds: [bind("/host/export", "/workspace/cache/export", true)],
    tmpfs: { "/workspace/aliases/deep/link": "rw" },
    table: `3 2 8:1 /export /workspace/cache/export rw - ext4 /dev/root rw
4 2 0:9 / /workspace/cache rw - tmpfs tmpfs rw`,
    masked: ["/workspace/cache/marker", "/workspace/cache/export/marker"],
    readable: ["/workspace/other/marker"],
  },
  {
    name: "bind attached inside the intervening tmpfs remains visible",
    binds: [bind("/host/export", "/workspace/cache/export", true)],
    tmpfs: { "/workspace/aliases/deep/link": "rw" },
    table: `3 2 0:9 / /workspace/cache rw - tmpfs tmpfs rw
4 3 8:1 /export /workspace/cache/export rw - ext4 /dev/root rw`,
    masked: ["/workspace/cache/marker"],
    readable: ["/workspace/cache/export/marker"],
  },
  {
    name: "identical recursive bind backing with a readonly top",
    binds: [bind("/host/export", "/workspace/export", false)],
    table: `3 2 8:1 /export /workspace/export rw - ext4 /dev/root rw
4 3 8:1 /export /workspace/export ro - ext4 /dev/root rw`,
    readable: ["/workspace/export/marker"],
  },
  {
    name: "readonly bind with mismatched realized access",
    binds: [bind("/host/export", "/workspace/export", false)],
    table: "3 2 8:1 /export /workspace/export rw - ext4 /dev/root rw",
    masked: ["/workspace/export/marker"],
  },
  {
    name: "escaped whitespace in realized bind paths",
    binds: [bind("/host/export ", "/workspace/export ", false)],
    table: "3 2 8:1 /export\\040 /workspace/export\\040 ro - ext4 /dev/root rw",
    readable: ["/workspace/export /marker"],
  },
  {
    name: "visible recursive child above a hidden older child",
    binds: [bind("/host/export", "/workspace/export", false)],
    table: `3 2 8:1 /export /workspace/export rw - ext4 /dev/root rw
4 2 8:1 /project /workspace rw - ext4 /dev/root rw
5 4 8:1 /export /workspace/export rw - ext4 /dev/root rw
6 5 8:1 /export /workspace/export ro - ext4 /dev/root rw`,
    readable: ["/workspace/export/marker"],
  },
  {
    name: "different backing above a hidden older bind",
    binds: [bind("/host/cache", "/workspace/cache", true)],
    tmpfs: { "/workspace/aliases/link": "rw" },
    table: `3 2 8:1 /cache /workspace/cache rw - ext4 /dev/root rw
4 2 8:1 /project /workspace rw - ext4 /dev/root rw
5 4 0:9 / /workspace/cache rw - tmpfs tmpfs rw`,
    masked: ["/workspace/cache/marker"],
    readable: ["/workspace/other/marker"],
  },
  {
    name: "bind destination alias without a realized lexical mount",
    binds: [bind("/host/export", "/workspace/link", true)],
    table: "3 2 8:1 /export /workspace/cache rw - ext4 /dev/root rw",
    masked: ["/workspace/link/marker", "/workspace/cache/marker"],
    readable: ["/workspace/other/marker"],
  },
])(
  "captures realized masks for $name",
  async ({ binds = [], tmpfs = {}, table, masked = [], readable = [] }) => {
    const bridge = await mountedBridge(binds, tmpfs, table);
    assertMasked(bridge, masked);
    for (const filePath of readable) {
      expect(bridge.resolvePath({ filePath }).containerPath).toBe(filePath);
    }
    expect(mocks.execContainer).toHaveBeenCalledTimes(2);
  },
);

it("rejects an unreadable filesystem snapshot", async () => {
  mocks.execContainer.mockRejectedValueOnce(new Error("inspect failed"));
  await expect(createDockerExecBackend()).rejects.toThrow("inspect failed");
});

it("binds Podman provisioning and later execs to the resolved target", async () => {
  provision("sandbox-podman");
  const podmanTarget = {
    key: `machine:${"a".repeat(32)}`,
    globalArgs: [
      "--url",
      "ssh://core@127.0.0.1:60001/run/user/501/podman/podman.sock",
      "--identity",
      "/tmp/podman-machine-key",
    ],
  };
  mocks.resolvePodmanSandboxRuntimeInfo.mockResolvedValueOnce({
    machine: true,
    rootless: true,
    target: podmanTarget,
  });
  const backend = await createPodmanSandboxBackend(
    backendParams({
      cfg: resolveSandboxConfigForAgent(createConfig("podman", false)),
    }),
  );
  const execSpec = await backend.buildExecSpec({ command: "true", env: {}, usePty: false });

  expect(mocks.ensureSandboxContainer).toHaveBeenCalledWith(
    expect.objectContaining({ podmanTarget }),
  );
  expect(mocks.execContainer).toHaveBeenCalledWith(
    expect.objectContaining({ id: "podman", globalArgs: podmanTarget.globalArgs }),
    expect.arrayContaining(["inspect", containerId]),
    expect.anything(),
  );
  expect(mocks.validateSandboxContainerEngineTarget).toHaveBeenCalledWith(
    expect.objectContaining({ id: "podman" }),
    podmanTarget,
  );
  expect(execSpec.argv.slice(0, 6)).toEqual(["podman", ...podmanTarget.globalArgs, "exec"]);
  expect(execSpec.stdinMode).toBe("pipe-closed");
  expect(execSpec.argv.at(-1)).toBe("true");
  expect(fs.readFileSync(envFile(execSpec), "utf8")).not.toContain("OPENCLAW_PREPEND_PATH=");
  await finalize(backend, execSpec.finalizeToken);
});

it("stages exec environment privately until finalization", async () => {
  const sentinel = "synthetic-container-exec-transport-value";
  const requestedPath = "$(touch /tmp/openclaw-path-injection)";
  const backend = await createDockerExecBackend();
  expect(mocks.ensureSandboxContainer).toHaveBeenCalledWith(
    expect.objectContaining({
      scopeKey,
      readOnlyResourceMounts: [
        { hostPath: "/host/attachments", containerPath: "/openclaw/attachments" },
      ],
    }),
  );

  const execSpec = await backend.buildExecSpec({
    command: "printf ready",
    workdir: "/workspace/project",
    env: { CONFIGURED_VALUE: sentinel, PATH: requestedPath },
    usePty: true,
  });

  for (const privateValue of [sentinel, requestedPath]) {
    expect(execSpec.argv.join(" ")).not.toContain(privateValue);
  }
  expect(execSpec.argv).not.toContain("-e");
  expect(execSpec.argv).toEqual(expect.arrayContaining(["-t", "-w", "/workspace/project"]));
  expect(execSpec.argv.slice(-4, -1)).toEqual([containerId, "/bin/sh", "-lc"]);
  expect(execSpec.argv.at(-1)).toBe(
    'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; printf ready',
  );
  expect(execSpec.stdinMode).toBe("pipe-open");
  const stagedFile = envFile(execSpec);
  expect(stagedFile).toBeDefined();
  const envFileContent = fs.readFileSync(stagedFile, "utf8");
  assertStaged(envFileContent, {
    CONFIGURED_VALUE: sentinel,
    OPENCLAW_PREPEND_PATH: requestedPath,
  });
  expect(envFileContent).not.toMatch(/^PATH=/m);
  expect(backend.finalizeExec).toBeDefined();

  await finalize(backend, execSpec.finalizeToken);
  expect(fs.existsSync(stagedFile)).toBe(false);
  await expect(finalize(backend, execSpec.finalizeToken)).resolves.toBeUndefined();
});

it("admits explicit piped input without enabling a PTY", async () => {
  const backend = await createDockerExecBackend();
  const spec = await backend.buildExecSpec({ command: "cat", env: {}, usePty: false, stdin: true });
  expect(spec.stdinMode).toBe("pipe-open");
  expect(spec.argv).toContain("-i");
  expect(spec.argv).not.toContain("-t");
  await finalize(backend, spec.finalizeToken);
});

it.skipIf(process.platform === "win32").each([
  { engine: "docker", host: "github.com" },
  { engine: "podman", host: "ghe.example.test" },
  { engine: "docker", host: "tenant.ghe.com" },
] as const)(
  "$engine binds the current $host identity at launch without staging its token",
  async ({ engine, host }) => {
    const root = tempDirs.make("github-sandbox-launch-");
    const profile = path.join(root, "profile");
    fs.mkdirSync(profile, { mode: 0o700 });
    const hosts = path.join(profile, "hosts.yml");
    fs.writeFileSync(hosts, `${host}:\n  oauth_token: synthetic-before-launch\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}\n');
    fs.writeFileSync(
      path.join(root, engine),
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  args,
  selected: process.env[${JSON.stringify(host === "ghe.example.test" ? "GH_ENTERPRISE_TOKEN" : "GH_TOKEN")}] === "synthetic-after-preparation",
  cleared: !process.env.GITHUB_TOKEN && !process.env.GITHUB_ENTERPRISE_TOKEN && !process.env[${JSON.stringify(host === "ghe.example.test" ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN")}],
  staged: fs.readFileSync(args[args.indexOf("--env-file") + 1], "utf8"),
}));
`,
      { mode: 0o700 },
    );
    provision("sandbox-github");
    const createBackend =
      engine === "docker" ? createDockerSandboxBackend : createPodmanSandboxBackend;
    const backend = await createBackend(
      backendParams({
        sessionKey: "agent:release:main",
        scopeKey: "agent:release:main",
        workspaceDir: root,
        agentWorkspaceDir: root,
        cfg: resolveSandboxConfigForAgent(createConfig(engine, false)),
      }),
      undefined,
      {
        managedLocalIdentity: true,
        credentialScrubEnv: { GH_TOKEN: "", GITHUB_TOKEN: "", PREVIEW_TOKEN: "" },
        localIdentityEnv: managedGitHubIdentityEnvironment({
          profileDir: profile,
          host,
          gitAuthor: { name: "Release Agent", email: "release@example.test" },
        }),
        excludedStoreNames: [],
      },
    );
    const spec = await backend.buildExecSpec({
      command: "printf ready",
      env: {
        GH_CONFIG_DIR: "/untrusted/profile",
        GH_TOKEN: "synthetic-request-token",
        GITHUB_TOKEN: "synthetic-request-fallback",
        GIT_AUTHOR_NAME: "Untrusted Author",
        PREVIEW_TOKEN: "synthetic-preview-token",
      },
      usePty: false,
    });
    try {
      fs.writeFileSync(hosts, `${host}:\n  oauth_token: synthetic-after-preparation\n`);
      const result = launch(spec, root);
      expect(result).toMatchObject({ code: 0, stderr: "" });
      const delivered = JSON.parse(result.stdout);
      expect(delivered).toMatchObject({ selected: true, cleared: true });
      expect(delivered.args.slice(delivered.args.indexOf("--env-file") + 2, -4)).toEqual(
        ["GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].flatMap(
          (name) => ["--env", name],
        ),
      );
      assertStaged(delivered.staged, {
        GH_CONFIG_DIR: "/openclaw/github",
        GH_HOST: host,
        GIT_AUTHOR_NAME: "Release Agent",
        GIT_AUTHOR_EMAIL: "release@example.test",
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        PREVIEW_TOKEN: "",
      });
      expect(JSON.stringify({ argv: spec.argv, staged: delivered.staged })).not.toContain(
        "synthetic-",
      );
      fs.unlinkSync(hosts);
      const refused = launch(spec, root);
      expect(refused).toMatchObject({ code: 1, stdout: "" });
      expect(refused.stderr).toContain("GitHub Identity credential is unavailable or insecure");
    } finally {
      await finalize(backend, spec.finalizeToken);
    }
  },
);

it.each([
  { configLabelKind: "BrowserImage", image: "openclaw-sandbox-browser:trixie-slim" },
  { configLabelKind: undefined, image: "openclaw-sandbox:trixie-slim" },
])("matches configured $configLabelKind image", async ({ configLabelKind, image }) => {
  mocks.execContainer.mockResolvedValueOnce(engineResult(`${image}\n`));
  await expect(
    dockerSandboxBackendManager.describeRuntime({
      entry: { ...runtimeEntry(), image: "stale-entry-image", configLabelKind },
      config: createConfig(),
      agentId: "coder",
    }),
  ).resolves.toEqual({ running: true, actualConfigLabel: image, configLabelMatch: true });
});

it.each([
  {
    backend: "docker",
    code: 1,
    stderr: "permission denied",
    error: "Failed to remove Docker sandbox runtime sandbox-1: permission denied",
  },
  {
    backend: "docker",
    code: 1,
    stderr: "Error response from daemon: No such container: sandbox-1",
    error: undefined,
  },
  { backend: "podman", code: 0, stderr: "", error: undefined },
])("removes $backend runtime: $stderr", async ({ backend, code, stderr, error }) => {
  mocks.execContainer.mockResolvedValueOnce({ code, stdout: "", stderr });
  const manager = backend === "podman" ? podmanSandboxBackendManager : dockerSandboxBackendManager;
  const entry = runtimeEntry(backend);
  const operation = manager.removeRuntime({ entry, config: createConfig() });
  if (error) {
    await expect(operation).rejects.toThrow(error);
  } else {
    await expect(operation).resolves.toBeUndefined();
  }
  if (backend === "podman") {
    expect(mocks.execContainer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "podman", command: "podman" }),
      ["rm", "-f", "sandbox-podman"],
      { allowFailure: true },
    );
    expect(mocks.validateSandboxContainerEngineTarget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "podman", command: "podman" }),
      localTarget,
    );
  }
});

it.each(["describeRuntime", "removeRuntime"] as const)(
  "rejects a stale Podman registry target before %s",
  async (operation) => {
    const targetError = new Error("active Podman connection changed");
    mocks.validateSandboxContainerEngineTarget.mockRejectedValueOnce(targetError);
    await expect(
      podmanSandboxBackendManager[operation]({
        entry: {
          ...runtimeEntry("podman"),
          backendTarget: {
            key: `machine:${"a".repeat(32)}`,
            globalArgs: ["--url", "ssh://core@127.0.0.1:60001/run/podman/podman.sock"],
          },
        },
        config: createConfig(),
      }),
    ).rejects.toBe(targetError);
    expect(mocks.containerState).not.toHaveBeenCalled();
    expect(mocks.execContainer).not.toHaveBeenCalled();
  },
);

it("rejects browser sandboxing on the explicit Podman backend", async () => {
  await expect(
    createPodmanSandboxBackend(
      backendParams({
        skillsWorkspaceDir: "/workspace/.openclaw/sandbox-skills",
        cfg: resolveSandboxConfigForAgent(createConfig("podman")),
      }),
    ),
  ).rejects.toThrow(
    "Podman sandboxing does not support browser sandboxes. Install Docker and select the docker backend, or disable sandbox.browser.enabled.",
  );

  expect(mocks.ensureSandboxContainer).not.toHaveBeenCalled();
});

it("matches canonical Podman identity for an expanded image name", async () => {
  mocks.execContainer
    .mockResolvedValueOnce(engineResult("localhost/openclaw-sandbox:trixie-slim\tsha256:abc123\n"))
    .mockResolvedValueOnce(engineResult("abc123\n"));

  await expect(
    podmanSandboxBackendManager.describeRuntime({
      entry: { ...runtimeEntry("podman"), configLabelKind: "Image" },
      config: createConfig(),
      agentId: "coder",
    }),
  ).resolves.toEqual({
    running: true,
    actualConfigLabel: "localhost/openclaw-sandbox:trixie-slim",
    configLabelMatch: true,
  });
  expect(mocks.execContainer).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ id: "podman", command: "podman" }),
    ["image", "inspect", "-f", "{{.Id}}", "openclaw-sandbox:trixie-slim"],
    { allowFailure: true },
  );
});
