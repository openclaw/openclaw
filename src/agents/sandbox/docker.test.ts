// Docker image tests cover sandbox image inspection and actionable setup errors
// without invoking a real Docker daemon.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_COMMAND_MAX_BUFFER_BYTES } from "./constants.js";

type SpawnCall = {
  command: string;
  args: string[];
};

type SpawnCallOptions = {
  maxBuffer?: number;
};

const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  imageExists: true,
  inspectError: "",
  infoAvailable: { docker: false, podman: false },
  podmanConnections: "[]\n",
  podmanInfo: "true\tfalse\n",
  lastOptions: undefined as SpawnCallOptions | undefined,
  executionError: undefined as Error | undefined,
  transportFailure: false,
  transportExitCode: 0,
}));

async function spawnDockerProcess(commandAndArgs: string[], options?: SpawnCallOptions) {
  const [command = "", ...args] = commandAndArgs;
  spawnState.calls.push({ command, args });
  spawnState.lastOptions = options;
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

  let code = 0;
  let stdout = "";
  let stderr = "";
  if (command !== "docker" && command !== "podman") {
    code = 1;
    stderr = `unexpected command: ${command}`;
  } else if (command === "podman" && args[0] === "system") {
    stdout = spawnState.podmanConnections;
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

let ensureDockerImage: typeof import("./docker.js").ensureDockerImage;
let ensureContainerImage: typeof import("./docker.js").ensureContainerImage;
let execDockerRaw: typeof import("./docker.js").execDockerRaw;
let podmanSandboxEngine: typeof import("./docker.js").PODMAN_SANDBOX_ENGINE;
let resolvePodmanSandboxRuntimeInfo: typeof import("./docker.js").resolvePodmanSandboxRuntimeInfo;

async function loadFreshDockerModuleForTest() {
  vi.resetModules();
  vi.doMock("../../process/exec.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../process/exec.js")>()),
    spawnCommand: spawnDockerProcess,
  }));
  const dockerModule = await import("./docker.js");
  ({ ensureContainerImage, ensureDockerImage, execDockerRaw } = dockerModule);
  resolvePodmanSandboxRuntimeInfo = dockerModule.resolvePodmanSandboxRuntimeInfo;
  podmanSandboxEngine = dockerModule.PODMAN_SANDBOX_ENGINE;
}

describe("resolvePodmanSandboxRuntimeInfo", () => {
  beforeEach(async () => {
    spawnState.calls.length = 0;
    spawnState.infoAvailable.podman = true;
    spawnState.podmanConnections = "[]\n";
    spawnState.podmanInfo = "true\tfalse\n";
    await loadFreshDockerModuleForTest();
  });

  it("rejects an arbitrary remote Podman connection", async () => {
    spawnState.podmanInfo = "true\ttrue\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "remote",
        URI: "ssh://example.test/run/user/1000/podman/podman.sock",
        Default: true,
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
      /active Podman connection is remote/u,
    );
  });

  it("allows Podman Machine connections", async () => {
    spawnState.podmanInfo = "true\ttrue\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-default",
        URI: "ssh://core@127.0.0.1/run/user/501/podman/podman.sock",
        IsMachine: true,
        Default: true,
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
      machine: true,
      rootless: true,
    });
  });

  it("rejects an unknown configured remote connection", async () => {
    spawnState.podmanInfo = "true\ttrue\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-default",
        URI: "ssh://core@127.0.0.1/run/user/501/podman/podman.sock",
        IsMachine: true,
        Default: true,
      },
    ]);

    await withEnvAsync({ CONTAINER_CONNECTION: "missing", CONTAINER_HOST: undefined }, async () => {
      await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(/could not be identified/u);
    });
  });

  it("prefers a configured host URI over a configured connection name", async () => {
    spawnState.podmanInfo = "true\ttrue\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-default",
        URI: "ssh://core@127.0.0.1/run/user/501/podman/podman.sock",
        IsMachine: true,
      },
    ]);

    await withEnvAsync(
      {
        CONTAINER_CONNECTION: "podman-machine-default",
        CONTAINER_HOST: "ssh://example.test/run/user/1000/podman/podman.sock",
      },
      async () => {
        await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
          /active Podman connection is remote/u,
        );
      },
    );
  });

  it("validates a named remote connection when the configured host URI is empty", async () => {
    spawnState.podmanInfo = "true\ttrue\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "remote",
        URI: "ssh://example.test/run/user/1000/podman/podman.sock",
      },
    ]);

    await withEnvAsync({ CONTAINER_CONNECTION: "remote", CONTAINER_HOST: "  " }, async () => {
      await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
        /active Podman connection is remote/u,
      );
    });
  });

  it("uses Podman's local Unix fallback when no connection is configured", async () => {
    spawnState.podmanInfo = "true\ttrue\n";

    await withEnvAsync({ CONTAINER_CONNECTION: undefined, CONTAINER_HOST: undefined }, async () => {
      await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
        machine: false,
        rootless: true,
      });
    });
  });

  it("revalidates the active Podman connection on every resolution", async () => {
    spawnState.podmanInfo = "true\tfalse\n";
    await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
      machine: false,
      rootless: true,
    });

    spawnState.podmanInfo = "true\ttrue\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "remote",
        URI: "ssh://example.test/run/user/1000/podman/podman.sock",
        Default: true,
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
      /active Podman connection is remote/u,
    );
  });

  it("ignores a saved remote default while the CLI uses its local engine", async () => {
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "saved-remote",
        URI: "ssh://example.test/run/user/1000/podman/podman.sock",
        Default: true,
      },
    ]);

    await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
      machine: false,
      rootless: true,
    });
    expect(spawnState.calls.some((call) => call.args[0] === "system")).toBe(false);
  });
});

describe("ensureDockerImage", () => {
  beforeEach(async () => {
    spawnState.calls.length = 0;
    spawnState.imageExists = true;
    spawnState.inspectError = "";
    spawnState.lastOptions = undefined;
    spawnState.executionError = undefined;
    spawnState.transportFailure = false;
    spawnState.transportExitCode = 0;
    await loadFreshDockerModuleForTest();
  });

  it("returns when the configured image already exists", async () => {
    await ensureDockerImage(DEFAULT_SANDBOX_IMAGE);

    expect(spawnState.calls).toEqual([
      {
        command: "docker",
        args: ["image", "inspect", DEFAULT_SANDBOX_IMAGE],
      },
    ]);
  });

  it("does not satisfy the missing default sandbox image by tagging plain Debian", async () => {
    // The default image carries Python/helper contracts; tagging a base distro
    // would pass image inspection but fail sandbox file operations later.
    spawnState.imageExists = false;

    let err: unknown;
    try {
      await ensureDockerImage(DEFAULT_SANDBOX_IMAGE);
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      `Sandbox image not found: ${DEFAULT_SANDBOX_IMAGE}. Build it with scripts/sandbox-setup.sh before enabling Docker sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`,
    );
    expect(spawnState.calls).toEqual([
      {
        command: "docker",
        args: ["image", "inspect", DEFAULT_SANDBOX_IMAGE],
      },
    ]);
  });

  it("gives Podman users a Podman build command for the missing default image", async () => {
    spawnState.imageExists = false;

    await expect(ensureContainerImage(podmanSandboxEngine, DEFAULT_SANDBOX_IMAGE)).rejects.toThrow(
      `podman build -t ${DEFAULT_SANDBOX_IMAGE} -f scripts/docker/sandbox/Dockerfile .`,
    );

    expect(spawnState.calls).toEqual([
      {
        command: "podman",
        args: ["image", "inspect", DEFAULT_SANDBOX_IMAGE],
      },
    ]);
  });

  it("throws when the Docker daemon is unavailable during image inspection", async () => {
    spawnState.imageExists = false;
    spawnState.inspectError =
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";

    await expect(ensureDockerImage(DEFAULT_SANDBOX_IMAGE)).rejects.toThrow(
      "Docker daemon is not available",
    );

    expect(spawnState.calls).toEqual([
      {
        command: "docker",
        args: ["image", "inspect", DEFAULT_SANDBOX_IMAGE],
      },
    ]);
  });

  it("preserves the Docker error for other image inspection failures", async () => {
    spawnState.imageExists = false;
    spawnState.inspectError = "permission denied";

    await expect(ensureDockerImage(DEFAULT_SANDBOX_IMAGE)).rejects.toThrow(
      "Failed to inspect sandbox image: permission denied",
    );
  });

  it("preserves the Docker error for a missing custom image", async () => {
    spawnState.imageExists = false;

    await expect(ensureDockerImage("example/custom:latest")).rejects.toThrow(
      "Sandbox image not found: example/custom:latest. Build or pull it first.",
    );
  });
});

describe("execDockerRaw", () => {
  beforeEach(async () => {
    spawnState.calls.length = 0;
    spawnState.imageExists = true;
    spawnState.inspectError = "";
    spawnState.lastOptions = undefined;
    spawnState.executionError = undefined;
    spawnState.transportFailure = false;
    spawnState.transportExitCode = 0;
    await loadFreshDockerModuleForTest();
  });

  it("preserves canonical wrapper execution errors", async () => {
    spawnState.executionError = new Error("docker execution failed");

    await expect(
      execDockerRaw(["image", "inspect", DEFAULT_SANDBOX_IMAGE], { allowFailure: true }),
    ).rejects.toThrow("docker execution failed");
  });

  it("applies the sandbox output cap explicitly", async () => {
    await execDockerRaw(["image", "inspect", DEFAULT_SANDBOX_IMAGE]);

    expect(spawnState.lastOptions?.maxBuffer).toBe(SANDBOX_COMMAND_MAX_BUFFER_BYTES);
  });

  it("rejects transport failures even when Docker exits zero", async () => {
    spawnState.transportFailure = true;

    await expect(execDockerRaw(["version"], { allowFailure: true })).rejects.toThrow(
      "docker stream failed",
    );
  });

  it("rejects transport failures even when Docker exits nonzero", async () => {
    spawnState.transportFailure = true;
    spawnState.transportExitCode = 7;

    await expect(execDockerRaw(["version"], { allowFailure: true })).rejects.toThrow(
      "docker stream failed",
    );
  });
});
