import type { CreateSandboxBackendParams, SandboxConfig } from "openclaw/plugin-sdk/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";

const podmanMocks = vi.hoisted(() => ({
  execPodman: vi.fn(),
  execPodmanRaw: vi.fn(),
  podmanContainerState: vi.fn(),
  readPodmanContainerLabel: vi.fn(),
}));
const sdkMocks = vi.hoisted(() => ({
  readSandboxRegistryEntry: vi.fn(),
}));

vi.mock("./podman.js", async () => {
  const actual = await vi.importActual<typeof import("./podman.js")>("./podman.js");
  return {
    ...actual,
    execPodman: podmanMocks.execPodman,
    execPodmanRaw: podmanMocks.execPodmanRaw,
    podmanContainerState: podmanMocks.podmanContainerState,
    readPodmanContainerLabel: podmanMocks.readPodmanContainerLabel,
  };
});

vi.mock("openclaw/plugin-sdk/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sandbox")>();
  return {
    ...actual,
    readSandboxRegistryEntry: sdkMocks.readSandboxRegistryEntry,
  };
});

const { createPodmanSandboxBackendFactory } = await import("./backend.js");

function createSandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    mode: "all",
    backend: "podman",
    scope: "session",
    workspaceAccess: "rw",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp"],
      network: "none",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "openclaw-sandbox-browser:bookworm-slim",
      containerPrefix: "openclaw-sbx-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      enableNoVnc: true,
      allowHostControl: false,
      autoStart: true,
      autoStartTimeoutMs: 12_000,
    },
    tools: {
      allow: [],
      deny: [],
    },
    prune: {
      idleHours: 24,
      maxAgeDays: 7,
    },
    ...overrides,
  };
}

function createParams(
  overrides: Partial<CreateSandboxBackendParams> = {},
): CreateSandboxBackendParams {
  const cfg = overrides.cfg ?? createSandboxConfig();
  return {
    sessionKey: "agent:main:podman-test",
    scopeKey: "agent:main:podman-test",
    workspaceDir: "/tmp/openclaw-sandbox-workspace",
    agentWorkspaceDir: "/tmp/openclaw-agent-workspace",
    cfg,
    ...overrides,
  };
}

function commandCalls() {
  return podmanMocks.execPodman.mock.calls.map((call) => call[1] as string[]);
}

function expectedKeepIdUserArgs() {
  return typeof process.getuid === "function" && typeof process.getgid === "function"
    ? ["--userns", "keep-id", "--user", `${process.getuid()}:${process.getgid()}`]
    : [];
}

describe("Podman sandbox backend", () => {
  beforeEach(() => {
    podmanMocks.execPodman.mockReset();
    podmanMocks.execPodmanRaw.mockReset();
    podmanMocks.podmanContainerState.mockReset();
    podmanMocks.readPodmanContainerLabel.mockReset();
    sdkMocks.readSandboxRegistryEntry.mockReset();
    podmanMocks.execPodman.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    podmanMocks.execPodmanRaw.mockResolvedValue({
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      code: 0,
    });
    podmanMocks.podmanContainerState.mockResolvedValue({ exists: false, running: false });
    podmanMocks.readPodmanContainerLabel.mockResolvedValue(null);
    sdkMocks.readSandboxRegistryEntry.mockResolvedValue(null);
  });

  it("creates and starts a missing Podman sandbox container", async () => {
    const factory = createPodmanSandboxBackendFactory({ pluginConfig: { command: "podman" } });
    const backend = await factory(createParams());
    const calls = commandCalls();
    const createArgs = calls.find((args) => args[0] === "create");

    expect(backend.id).toBe("podman");
    expect(backend.workdir).toBe("/workspace");
    expect(createArgs).toEqual(
      expect.arrayContaining([
        "create",
        "--name",
        expect.stringMatching(/^openclaw-sbx-agent-main-podman-test-/),
        "--read-only",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        ...expectedKeepIdUserArgs(),
        "-v",
        "/tmp/openclaw-sandbox-workspace:/workspace:z",
        "-v",
        "/tmp/openclaw-agent-workspace:/agent:z",
        "openclaw-sandbox:bookworm-slim",
        "sleep",
        "infinity",
      ]),
    );
    expect(calls.some((args) => args[0] === "start")).toBe(true);
  });

  it("does not override an explicitly configured sandbox user", async () => {
    const factory = createPodmanSandboxBackendFactory({ pluginConfig: { command: "podman" } });

    await factory(
      createParams({
        cfg: createSandboxConfig({
          docker: { ...createSandboxConfig().docker, user: "1001:1001" },
        }),
      }),
    );

    const createArgs = commandCalls().find((args) => args[0] === "create");
    expect(createArgs).toEqual(expect.arrayContaining(["--user", "1001:1001"]));
    expect(createArgs).not.toContain("keep-id");
  });

  it("recreates a stopped existing container when the config hash label does not match", async () => {
    podmanMocks.podmanContainerState.mockResolvedValue({ exists: true, running: false });
    podmanMocks.readPodmanContainerLabel.mockResolvedValue("old-hash");
    const factory = createPodmanSandboxBackendFactory({ pluginConfig: { command: "podman" } });

    await factory(createParams());

    const calls = commandCalls();
    expect(calls).toContainEqual([
      "rm",
      "-f",
      expect.stringMatching(/^openclaw-sbx-agent-main-podman-test-/),
    ]);
    expect(calls.some((args) => args[0] === "create")).toBe(true);
  });

  it("preserves a running existing container when the config hash label does not match", async () => {
    podmanMocks.podmanContainerState.mockResolvedValue({ exists: true, running: true });
    podmanMocks.readPodmanContainerLabel.mockResolvedValue("old-hash");
    const factory = createPodmanSandboxBackendFactory({ pluginConfig: { command: "podman" } });

    await factory(createParams());

    const calls = commandCalls();
    expect(calls.some((args) => args[0] === "rm")).toBe(false);
    expect(calls.some((args) => args[0] === "create")).toBe(false);
  });

  it("recreates an old running container when the config hash label does not match", async () => {
    podmanMocks.podmanContainerState.mockResolvedValue({ exists: true, running: true });
    podmanMocks.readPodmanContainerLabel.mockResolvedValue("old-hash");
    sdkMocks.readSandboxRegistryEntry.mockResolvedValue({ lastUsedAtMs: 1 });
    const factory = createPodmanSandboxBackendFactory({ pluginConfig: { command: "podman" } });

    await factory(createParams());

    const calls = commandCalls();
    expect(calls).toContainEqual([
      "rm",
      "-f",
      expect.stringMatching(/^openclaw-sbx-agent-main-podman-test-/),
    ]);
    expect(calls.some((args) => args[0] === "create")).toBe(true);
  });

  it("reuses a matching running container", async () => {
    let capturedHash = "";
    podmanMocks.execPodman.mockImplementation(async (_config, args: string[]) => {
      if (args[0] === "create") {
        capturedHash =
          args
            .find((arg) => arg.startsWith("openclaw.configHash="))
            ?.slice("openclaw.configHash=".length) ?? "";
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const factory = createPodmanSandboxBackendFactory({ pluginConfig: { command: "podman" } });
    await factory(createParams());

    podmanMocks.execPodman.mockClear();
    podmanMocks.podmanContainerState.mockResolvedValue({ exists: true, running: true });
    podmanMocks.readPodmanContainerLabel.mockResolvedValue(capturedHash);
    await factory(createParams());

    const calls = commandCalls();
    expect(calls.some((args) => args[0] === "create")).toBe(false);
    expect(calls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("builds exec specs with Podman remote options", async () => {
    const factory = createPodmanSandboxBackendFactory({
      pluginConfig: { command: "podman", connection: "dev" },
    });
    const backend = await factory(createParams());

    const spec = await backend.buildExecSpec({
      command: "pwd",
      env: { PATH: "/usr/local/bin" },
      usePty: true,
    });

    expect(spec.argv.slice(0, 4)).toEqual(["podman", "--connection", "dev", "exec"]);
    expect(spec.argv).toContain("-t");
    expect(spec.argv).toContain("OPENCLAW_PREPEND_PATH=/usr/local/bin");
  });

  it("routes filesystem bridge shell commands through podman exec", async () => {
    const factory = createPodmanSandboxBackendFactory({ pluginConfig: { command: "podman" } });
    const backend = await factory(createParams());

    await backend.runShellCommand({ script: 'stat -c %s "$1"', args: ["/workspace/file.txt"] });

    expect(podmanMocks.execPodmanRaw).toHaveBeenCalledWith(
      { command: "podman" },
      [
        "exec",
        "-i",
        expect.stringMatching(/^openclaw-sbx-agent-main-podman-test-/),
        "sh",
        "-c",
        'stat -c %s "$1"',
        "openclaw-sandbox-fs",
        "/workspace/file.txt",
      ],
      expect.objectContaining({ allowFailure: undefined }),
    );
  });

  it("fails closed for unsupported browser and GPU options", async () => {
    const factory = createPodmanSandboxBackendFactory({ pluginConfig: { command: "podman" } });

    await expect(
      factory(
        createParams({
          cfg: createSandboxConfig({
            browser: { ...createSandboxConfig().browser, enabled: true },
          }),
        }),
      ),
    ).rejects.toThrow(/browser sandboxes/i);

    await expect(
      factory(
        createParams({
          cfg: createSandboxConfig({
            docker: { ...createSandboxConfig().docker, gpus: "all" },
          }),
        }),
      ),
    ).rejects.toThrow(/does not support sandbox\.docker\.gpus/i);
  });
});
