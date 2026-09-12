// Skills-mount-layout lifecycle tests: retained hot containers that predate the
// direct generated-skills mount must be reported with their existing layout so
// prompt and file mapping stay aligned until the container is safely recreated.
import fs from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SandboxConfig } from "./types.js";

type SpawnCall = {
  command: string;
  args: string[];
  envFileContents?: string;
};

const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  containerExists: true,
  inspectRunning: true,
  labelHash: "",
  mountDestinations: "",
}));

const registryMocks = vi.hoisted(() => ({
  readRegistryEntry: vi.fn(),
  removeRegistryEntry: vi.fn(),
  updateRegistry: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function spawnDockerProcess(commandAndArgs: string[]) {
  const [command = "", ...args] = commandAndArgs;
  const call: SpawnCall = { command, args };
  const envFileIndex = args.indexOf("--env-file");
  const envFile = envFileIndex === -1 ? undefined : args[envFileIndex + 1];
  if (args[0] === "create" && envFile) {
    call.envFileContents = fs.readFileSync(envFile, "utf8");
  }
  spawnState.calls.push(call);

  let code = 0;
  let stdout = "";
  let stderr = "";
  if (command !== "docker") {
    code = 1;
    stderr = `unexpected command: ${command}`;
  } else if (args[0] === "inspect" && args[1] === "-f" && args[2] === "{{.State.Running}}") {
    if (!spawnState.containerExists) {
      code = 1;
      stderr = "No such object";
    } else {
      stdout = spawnState.inspectRunning ? "true\n" : "false\n";
    }
  } else if (
    args[0] === "inspect" &&
    args[1] === "-f" &&
    args[2]?.includes('index .Config.Labels "openclaw.configHash"')
  ) {
    if (!spawnState.containerExists) {
      code = 1;
      stderr = "No such object";
    } else {
      stdout = `${spawnState.labelHash}\n`;
    }
  } else if (args[0] === "inspect" && args[1] === "-f" && args[2]?.includes("range .Mounts")) {
    if (!spawnState.containerExists) {
      code = 1;
      stderr = "No such object";
    } else {
      stdout = spawnState.mountDestinations;
    }
  } else if (args[0] === "rm" && args[1] === "-f") {
    spawnState.containerExists = false;
    spawnState.inspectRunning = false;
  } else if (args[0] === "image" && args[1] === "inspect") {
    code = 0;
  } else if (args[0] === "create") {
    if (spawnState.containerExists) {
      code = 1;
      stderr = "container name is already in use";
    } else {
      spawnState.containerExists = true;
      spawnState.inspectRunning = false;
      spawnState.labelHash =
        args
          .find((arg) => arg.startsWith("openclaw.configHash="))
          ?.slice("openclaw.configHash=".length) ?? "";
    }
  } else if (args[0] === "start") {
    spawnState.inspectRunning = true;
  } else if (args[0] === "exec") {
    code = 0;
  } else {
    code = 1;
    stderr = `unexpected docker args: ${args.join(" ")}`;
  }
  return {
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnDockerProcess,
}));

function createSandboxConfig(binds?: string[]): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "shared",
    workspaceAccess: "rw",
    workspaceRoot: "~/.openclaw/sandboxes",
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
      dns: [],
      extraHosts: ["host.docker.internal:host-gateway"],
      binds: binds ?? ["/tmp/workspace:/workspace:rw"],
      dangerouslyAllowReservedContainerTargets: true,
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "openclaw-browser:test",
      containerPrefix: "oc-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      noVncEnabled: false,
      allowHostControl: false,
      autoStart: false,
    },
    tools: {},
    prune: { idleHours: 0, maxAgeDays: 0 },
  } as unknown as SandboxConfig;
}

let ensureSandboxContainer: typeof import("./docker.js").ensureSandboxContainer;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("./registry.js", () => ({
    readRegistryEntry: registryMocks.readRegistryEntry,
    removeRegistryEntry: registryMocks.removeRegistryEntry,
    updateRegistry: registryMocks.updateRegistry,
  }));
  vi.doMock("../../runtime.js", () => ({
    defaultRuntime: runtimeMocks,
  }));
  vi.doMock("../../process/exec.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../process/exec.js")>()),
    spawnCommand: spawnDockerProcess,
  }));
  ({ ensureSandboxContainer } = await import("./docker.js"));
});

describe("ensureSandboxContainer skills mount layout", () => {
  beforeEach(() => {
    spawnState.calls.length = 0;
    spawnState.containerExists = true;
    spawnState.inspectRunning = true;
    spawnState.labelHash = "";
    spawnState.mountDestinations = "";
    registryMocks.readRegistryEntry.mockReset();
    registryMocks.removeRegistryEntry.mockReset();
    registryMocks.removeRegistryEntry.mockResolvedValue(undefined);
    registryMocks.updateRegistry.mockReset();
    registryMocks.updateRegistry.mockResolvedValue(undefined);
    runtimeMocks.log.mockClear();
  });

  it.each([
    {
      caseName: "nested",
      mountDestinations: ["/workspace", "/workspace/.openclaw/sandbox-skills/skills"].join("\n"),
      expected: "nested",
    },
    {
      caseName: "direct",
      mountDestinations: ["/workspace", "/workspace/.openclaw-skills"].join("\n"),
      expected: "direct",
    },
  ])(
    "reports the $caseName layout for a retained hot $caseName-layout container",
    async ({ mountDestinations, expected }) => {
      const workspaceDir = tempDirs.make("openclaw-docker-mount-layout-");
      const cfg = createSandboxConfig([`${workspaceDir}:/workspace:rw`]);
      // A hot container with drifted config stays live; its mount destinations
      // reveal the generated-skills layout it was created with.
      spawnState.labelHash = `stale-${expected}-hash`;
      spawnState.mountDestinations = mountDestinations;
      registryMocks.readRegistryEntry.mockResolvedValue({
        containerName: "oc-test-shared",
        sessionKey: "shared",
        createdAtMs: 1,
        lastUsedAtMs: Date.now(),
        image: cfg.docker.image,
        configHash: `stale-${expected}-hash`,
      });

      const result = await ensureSandboxContainer({
        scopeKey: "shared",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg,
      });

      expect(result.containerName).toBe("oc-test-shared");
      expect(result.skillsMountLayout).toBe(expected);
      expect(spawnState.calls.some((call) => call.args[0] === "rm")).toBe(false);
      expect(spawnState.calls.some((call) => call.args[0] === "create")).toBe(false);
    },
  );

  it("reports the direct skills layout for freshly created containers", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mount-layout-");
    const cfg = createSandboxConfig([`${workspaceDir}:/workspace:rw`]);
    spawnState.containerExists = false;
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    const result = await ensureSandboxContainer({
      scopeKey: "shared",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg,
    });

    expect(result.containerName).toBe("oc-test-shared");
    expect(result.skillsMountLayout).toBe("direct");
  });
});
