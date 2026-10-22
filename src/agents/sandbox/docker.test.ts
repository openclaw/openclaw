import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { DEFAULT_SANDBOX_IMAGE } from "./constants.js";

type SpawnCall = {
  command: string;
  args: string[];
};

const { spawnState, freshSpawnState } = vi.hoisted(() => {
  const makeState = () => ({
    calls: [] as SpawnCall[],
    imageExists: true,
    inspectError: "",
    infoAvailable: { docker: false, podman: false },
    podmanConnections: "[]\n",
    podmanInfo: "true\tfalse\t\t5.0.0\n",
    podmanMachines: "[]\n",
    podmanClientVersion: "podman version 5.0.0\n",
    podmanVersionExitCode: 0,
    executionError: undefined as Error | undefined,
    transportFailure: false,
    transportExitCode: 0,
    commandResult: undefined as { code: number; stdout: string; stderr: string } | undefined,
  });
  return { spawnState: makeState(), freshSpawnState: makeState };
});

function processResult(code = 0, stdout = "", stderr = "") {
  return {
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}
const defaultMachine = {
  Name: "podman-machine-default",
  Running: true,
  IdentityPath: "/tmp/podman-machine-default",
  Port: 60000,
  RemoteUsername: "core",
};
function machineInfo(overrides: Partial<typeof defaultMachine> = {}) {
  return { ...defaultMachine, ...overrides };
}
function selectConnection(Name: string, URI: string, Identity?: string, isDefault = true) {
  spawnState.podmanConnections = JSON.stringify([
    { Name, URI, Identity, ...(isDefault ? { Default: true } : {}) },
  ]);
}
function selectMachine(label: string, port: number) {
  const Name = `podman-machine-${label}`;
  const Identity = `/tmp/${label}-machine-key`;
  const URI = `ssh://core@127.0.0.1:${port}/run/user/501/podman/podman.sock`;
  selectConnection(Name, URI, Identity);
  spawnState.podmanMachines = JSON.stringify([
    machineInfo({ Name, Port: port, IdentityPath: Identity }),
  ]);
}

async function spawnDockerProcess(commandAndArgs: string[]) {
  const [command = "", ...args] = commandAndArgs;
  spawnState.calls.push({ command, args });
  if (spawnState.executionError) {
    throw spawnState.executionError;
  }
  if (spawnState.transportFailure) {
    return Object.assign(new Error("docker stream failed"), {
      cause: new Error("docker stream failed"),
      failed: true,
      isCanceled: false,
      exitCode: spawnState.transportExitCode,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
  }
  if (spawnState.commandResult) {
    const { code, stdout, stderr } = spawnState.commandResult;
    return processResult(code, stdout, stderr);
  }

  let code = 0;
  let stdout = "";
  let stderr = "";
  if (command !== "docker" && command !== "podman") {
    code = 1;
    stderr = `unexpected command: ${command}`;
  } else if (command === "podman" && args[0] === "system") {
    stdout = spawnState.podmanConnections;
  } else if (command === "podman" && args[0] === "machine") {
    stdout = spawnState.podmanMachines;
  } else if (command === "podman" && args[0] === "--version") {
    stdout = spawnState.podmanClientVersion;
    code = spawnState.podmanVersionExitCode;
  } else if (args[0] === "info") {
    code = spawnState.infoAvailable[command as "docker" | "podman"] ? 0 : 1;
    if (code === 0 && command === "podman" && args.includes("--format")) {
      stdout = spawnState.podmanInfo;
    }
    stderr = code === 0 ? "" : `${command} unavailable`;
  } else if (args[0] === "image" && args[1] === "inspect") {
    code = spawnState.imageExists ? 0 : 1;
    stderr = spawnState.imageExists
      ? ""
      : spawnState.inspectError || `Error response from daemon: No such image: ${args[2]}`;
  } else if (args[0] !== "pull" && args[0] !== "tag") {
    code = 1;
    stderr = `unexpected docker args: ${args.join(" ")}`;
  }
  return processResult(code, stdout, stderr);
}

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnDockerProcess,
}));

let docker: typeof import("./docker.js");
let containerImage: typeof import("./container-image.js");

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("../../process/exec.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../process/exec.js")>()),
    spawnCommand: spawnDockerProcess,
  }));
  docker = await import("./docker.js");
  containerImage = await import("./container-image.js");
});

beforeEach(() => {
  // Hoisted fault state survives module resets and must not reach the next case.
  Object.assign(spawnState, freshSpawnState());
});

describe("resolvePodmanSandboxRuntimeInfo", () => {
  beforeEach(() => {
    spawnState.infoAvailable.podman = true;
  });

  it("allows rootful Podman Machine connections", async () => {
    const uri = "ssh://root@127.0.0.1:60000/run/podman/podman.sock";
    spawnState.podmanInfo = "false\ttrue\t\t5.0.0\n";
    selectConnection("podman-machine-default-root", uri, "/tmp/podman-machine-default");
    spawnState.podmanMachines = JSON.stringify([machineInfo()]);
    await expect(docker.resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
      machine: true,
      rootless: false,
      version: "5.0.0",
      target: {
        key: expect.stringMatching(/^machine:[a-f0-9]{32}$/u),
        globalArgs: ["--url", uri, "--identity", "/tmp/podman-machine-default"],
      },
    });
  });

  it("pins the named endpoint using client rather than server precedence", async () => {
    spawnState.podmanInfo = "true\ttrue\t/tmp/fallback.sock\t4.7.2\n";
    spawnState.podmanClientVersion = "podman-remote.exe version 4.8.0-dev\n";
    selectConnection("named", "unix:///tmp/named.sock");
    await withEnvAsync({ CONTAINER_CONNECTION: "named", CONTAINER_HOST: "" }, async () => {
      const runtime = await docker.resolvePodmanSandboxRuntimeInfo();
      expect(runtime).toMatchObject({
        machine: false,
        rootless: true,
        version: "4.7.2",
        target: { globalArgs: ["--url", "unix:///tmp/named.sock"] },
      });
      expect(spawnState.calls.filter((call) => call.args[0] === "--version")).toEqual([
        { command: "podman", args: ["--version"] },
      ]);
      spawnState.commandResult = { code: 0, stdout: "container", stderr: "" };
      await docker.execContainerRaw(docker.bindPodmanSandboxEngine(runtime.target), [
        "inspect",
        "container",
      ]);
      expect(spawnState.calls.at(-1)).toEqual({
        command: "podman",
        args: ["--url", "unix:///tmp/named.sock", "inspect", "container"],
      });
    });
  });

  it.each([
    ["missing", "unix:///tmp/host.sock", 0, /could not be identified/u],
    ["remote", "  ", 0, /active Podman connection is remote/u],
    ["named", "unix:///tmp/host.sock", 125, /Unset either CONTAINER_HOST or CONTAINER_CONNECTION/u],
  ] as const)("rejects unresolvable selection %s (%s, %s)", async (name, host, code, error) => {
    spawnState.podmanInfo = "true\ttrue\t/tmp/fallback.sock\t4.7.2\n";
    spawnState.podmanVersionExitCode = code;
    const remote = name === "remote";
    selectConnection(
      remote ? "remote" : "named",
      remote ? "ssh://example.test/run/user/1000/podman/podman.sock" : "unix:///tmp/named.sock",
    );
    await withEnvAsync({ CONTAINER_CONNECTION: name, CONTAINER_HOST: host }, async () => {
      await expect(docker.resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(error);
    });
  });

  it.each(["4.7.2", "4.8.0"])(
    "keeps the selected Machine identity for client %s and validates that Machine",
    async (client) => {
      const uri = "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock";
      const identity = "/tmp/selected-machine-key";
      const hostWins = client === "4.7.2";
      spawnState.podmanClientVersion = `podman version ${client}\n`;
      spawnState.podmanInfo = "true\ttrue\t\t4.7.2\n";
      selectConnection(
        "podman-machine-default",
        uri,
        hostWins ? "/tmp/losing-named-key" : identity,
        false,
      );
      const machine = machineInfo({ IdentityPath: identity });
      spawnState.podmanMachines = JSON.stringify([machine]);
      await withEnvAsync(
        {
          CONTAINER_CONNECTION: hostWins ? "missing" : "podman-machine-default",
          CONTAINER_HOST: hostWins ? uri : "unix:///tmp/host.sock",
          CONTAINER_SSHKEY: hostWins ? identity : "/tmp/losing-host-key",
        },
        async () => {
          await expect(docker.resolvePodmanSandboxRuntimeInfo()).resolves.toMatchObject({
            machine: true,
            target: { globalArgs: ["--url", uri, "--identity", identity] },
          });
          spawnState.podmanMachines = JSON.stringify([{ ...machine, Running: false }]);
          await expect(docker.resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
            /active Podman connection is remote/u,
          );
        },
      );
    },
  );

  it("revalidates the active Podman connection on every resolution", async () => {
    spawnState.podmanInfo = "true\tfalse\t\t5.0.0\n";
    const remoteUri = "ssh://example.test/run/user/1000/podman/podman.sock";
    selectConnection("saved-remote", remoteUri);
    await expect(docker.resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
      machine: false,
      rootless: true,
      version: "5.0.0",
      target: { key: "local", globalArgs: [] },
    });

    expect(spawnState.calls.some((call) => call.args[0] === "system")).toBe(false);
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    selectConnection("remote", remoteUri);

    await expect(docker.resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
      /active Podman connection is remote/u,
    );
  });

  it("rejects a different allowed Podman Machine after a runtime target is recorded", async () => {
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    selectMachine("first", 60001);
    const first = await docker.resolvePodmanSandboxRuntimeInfo();

    selectMachine("second", 60002);

    await expect(
      docker.validateSandboxContainerEngineTarget(docker.PODMAN_SANDBOX_ENGINE, first.target),
    ).rejects.toThrow(/active Podman connection changed/u);
  });
});

it.each([
  [
    "docker",
    DEFAULT_SANDBOX_IMAGE,
    "",
    `Sandbox image not found: ${DEFAULT_SANDBOX_IMAGE}. Build it with scripts/sandbox-setup.sh before enabling Docker sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:trixie-slim.`,
  ],
  [
    "podman",
    DEFAULT_SANDBOX_IMAGE,
    "",
    `podman build -t ${DEFAULT_SANDBOX_IMAGE} -f scripts/docker/sandbox/Dockerfile .`,
  ],
  [
    "docker",
    DEFAULT_SANDBOX_IMAGE,
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    "Docker daemon is not available",
  ],
  [
    "docker",
    DEFAULT_SANDBOX_IMAGE,
    "permission denied",
    "Failed to inspect sandbox image: permission denied",
  ],
  [
    "docker",
    "example/custom:latest",
    "",
    "Sandbox image not found: example/custom:latest. Build or pull it first.",
  ],
] as const)(
  "ensureContainerImage reports %s image inspection failure (%s, %s): %s",
  async (engine, image, stderr, error) => {
    spawnState.imageExists = false;
    spawnState.inspectError = stderr;
    const result = containerImage.ensureContainerImage(
      engine === "docker" ? docker.DOCKER_SANDBOX_ENGINE : docker.PODMAN_SANDBOX_ENGINE,
      image,
    );
    if (engine === "docker" && image === DEFAULT_SANDBOX_IMAGE && !stderr) {
      await expect(result).rejects.toBeInstanceOf(Error);
      await expect(result).rejects.toMatchObject({ message: error });
    } else {
      await expect(result).rejects.toThrow(error);
    }
    expect(spawnState.calls).toEqual([{ command: engine, args: ["image", "inspect", image] }]);
  },
);

describe("execDockerRaw", () => {
  it("preserves canonical wrapper execution errors", async () => {
    spawnState.executionError = new Error("docker execution failed");

    await expect(
      docker.execDockerRaw(["image", "inspect", DEFAULT_SANDBOX_IMAGE], { allowFailure: true }),
    ).rejects.toThrow("docker execution failed");
  });

  it("rejects transport failures even when Docker exits 7", async () => {
    spawnState.transportFailure = true;
    spawnState.transportExitCode = 7;
    await expect(docker.execDockerRaw(["version"], { allowFailure: true })).rejects.toThrow(
      "docker stream failed",
    );
  });

  it("does not include raw container arguments when stderr is empty", async () => {
    spawnState.commandResult = { code: 1, stdout: "", stderr: "" };
    const secret = "sandbox-secret-value";

    const error = await docker
      .execDockerRaw(["create", "--env", `TOKEN=${secret}`])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Docker command failed (exit 1)");
    expect((error as Error).message).not.toContain(secret);
  });
});
