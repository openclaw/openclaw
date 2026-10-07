// Docker image tests cover sandbox image inspection and actionable setup errors
// without invoking a real Docker daemon.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { DEFAULT_SANDBOX_IMAGE } from "./constants.js";
import { toSandboxProvisioningError } from "./provisioning-error.js";

type SpawnCall = {
  command: string;
  args: string[];
};

const spawnState = vi.hoisted(() => ({
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
  cancelCommand: "",
  cancelMode: "result",
  cancelController: undefined as AbortController | undefined,
  cancelReason: undefined as Error | undefined,
  transportFailure: false,
  transportExitCode: 0,
  plainExitWithoutStderr: false,
  commandResult: undefined as { code: number; stdout: string; stderr: string } | undefined,
}));

async function spawnDockerProcess(commandAndArgs: string[]) {
  const [command = "", ...args] = commandAndArgs;
  spawnState.calls.push({ command, args });
  if (args[0] === spawnState.cancelCommand) {
    spawnState.cancelController?.abort(spawnState.cancelReason);
    if (spawnState.cancelMode === "throw") {
      throw new Error("synthetic process cancellation");
    }
    return {
      failed: true,
      isCanceled: true,
      exitCode: undefined,
      stdout: Buffer.from("synthetic-private-output"),
      stderr: Buffer.from("synthetic-private-output"),
    };
  }
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
  if (spawnState.plainExitWithoutStderr) {
    return {
      failed: true,
      isCanceled: false,
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    };
  }

  if (spawnState.commandResult) {
    const { code, stdout, stderr } = spawnState.commandResult;
    return {
      failed: code !== 0,
      isCanceled: false,
      exitCode: code,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(stderr),
    };
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

let dockerSandboxEngine: typeof import("./docker.js").DOCKER_SANDBOX_ENGINE;
let ensureContainerImage: typeof import("./docker.js").ensureContainerImage;
let execDockerRaw: typeof import("./docker.js").execDockerRaw;
let execContainerRaw: typeof import("./docker.js").execContainerRaw;
let podmanSandboxEngine: typeof import("./docker.js").PODMAN_SANDBOX_ENGINE;
let resolvePodmanSandboxRuntimeInfo: typeof import("./docker.js").resolvePodmanSandboxRuntimeInfo;
let validateSandboxContainerEngineTarget: typeof import("./docker.js").validateSandboxContainerEngineTarget;
let bindPodmanSandboxEngine: typeof import("./docker.js").bindPodmanSandboxEngine;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("../../process/exec.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../process/exec.js")>()),
    spawnCommand: spawnDockerProcess,
  }));
  const dockerModule = await import("./docker.js");
  ({ ensureContainerImage, execDockerRaw, execContainerRaw } = dockerModule);
  dockerSandboxEngine = dockerModule.DOCKER_SANDBOX_ENGINE;
  resolvePodmanSandboxRuntimeInfo = dockerModule.resolvePodmanSandboxRuntimeInfo;
  validateSandboxContainerEngineTarget = dockerModule.validateSandboxContainerEngineTarget;
  bindPodmanSandboxEngine = dockerModule.bindPodmanSandboxEngine;
  podmanSandboxEngine = dockerModule.PODMAN_SANDBOX_ENGINE;
});

beforeEach(() => {
  // Hoisted fault state survives module resets and must not reach the next case.
  spawnState.calls.length = 0;
  spawnState.imageExists = true;
  spawnState.inspectError = "";
  spawnState.infoAvailable.docker = false;
  spawnState.infoAvailable.podman = false;
  spawnState.podmanConnections = "[]\n";
  spawnState.podmanInfo = "true\tfalse\t\t5.0.0\n";
  spawnState.podmanMachines = "[]\n";
  spawnState.podmanClientVersion = "podman version 5.0.0\n";
  spawnState.podmanVersionExitCode = 0;
  spawnState.executionError = undefined;
  spawnState.cancelCommand = "";
  spawnState.cancelMode = "result";
  spawnState.cancelController = undefined;
  spawnState.cancelReason = undefined;
  spawnState.transportFailure = false;
  spawnState.transportExitCode = 0;
  spawnState.plainExitWithoutStderr = false;
  spawnState.commandResult = undefined;
});

describe("resolvePodmanSandboxRuntimeInfo", () => {
  beforeEach(() => {
    spawnState.infoAvailable.podman = true;
  });

  it.each([
    { command: "info", probe: "info", mode: "throw" },
    { command: "info", probe: "info", mode: "result" },
    { command: "system", probe: "system connection list", mode: "throw" },
    { command: "system", probe: "system connection list", mode: "result" },
    { command: "machine", probe: "machine list", mode: "throw" },
    { command: "machine", probe: "machine list", mode: "result" },
    { command: "--version", probe: "--version", mode: "throw" },
    { command: "--version", probe: "--version", mode: "result" },
  ])(
    "attributes the $probe probe timeout through provisioning ($mode)",
    async ({ command, probe, mode }) => {
      const controller = new AbortController();
      const reason = new DOMException("The operation was aborted due to timeout", "TimeoutError");
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      spawnState.cancelCommand = command;
      spawnState.cancelMode = mode;
      spawnState.cancelController = controller;
      spawnState.cancelReason = reason;
      spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
      spawnState.podmanConnections = JSON.stringify([
        {
          Name: "machine",
          URI: "ssh://core@127.0.0.1:60000/synthetic-private-socket",
          Default: true,
        },
      ]);
      try {
        await withEnvAsync({ CONTAINER_CONNECTION: "machine", CONTAINER_HOST: "" }, async () => {
          const error = await resolvePodmanSandboxRuntimeInfo().catch((caught: unknown) => caught);
          expect(error).toMatchObject({
            name: "TimeoutError",
            message: `Podman ${probe} probe timed out after 5000 ms`,
            cause: reason,
          });
          if (error instanceof Error) {
            expect(error.cause).toBe(reason);
          }
          const provisioning = toSandboxProvisioningError(error, "podman");
          expect(provisioning.code).toBe("sandbox_provisioning");
          expect(provisioning.message).toContain(`Podman ${probe} probe timed out after 5000 ms`);
          expect(provisioning.cause).toBe(error);
          expect(provisioning.message).not.toContain("synthetic-private");
        });
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it("does not attribute an unrelated TimeoutError to the probe deadline", async () => {
    const error = new DOMException("unrelated timeout", "TimeoutError");
    spawnState.executionError = error;
    await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toBe(error);
  });

  it.each([false])("allows Podman Machine connections (rootless=%s)", async (rootless) => {
    const uri = rootless
      ? "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock"
      : "ssh://root@127.0.0.1:60000/run/podman/podman.sock";
    spawnState.podmanInfo = `${rootless}\ttrue\t\t5.0.0\n`;
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: `podman-machine-default${rootless ? "" : "-root"}`,
        URI: uri,
        Identity: "/tmp/podman-machine-default",
        Default: true,
      },
    ]);
    spawnState.podmanMachines = JSON.stringify([
      {
        Name: "podman-machine-default",
        Running: true,
        IdentityPath: "/tmp/podman-machine-default",
        Port: 60000,
        RemoteUsername: "core",
      },
    ]);
    await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toEqual({
      machine: true,
      rootless,
      version: "5.0.0",
      target: {
        key: expect.stringMatching(/^machine:[a-f0-9]{32}$/u),
        globalArgs: ["--url", uri, "--identity", "/tmp/podman-machine-default"],
      },
    });
  });

  it.each([
    {
      client: "podman-remote.exe version 4.8.0-dev",
      server: "4.7.2",
      host: "",
      name: "named",
      selected: "named",
    },
  ])(
    "pins the $selected endpoint selected by client $client (server $server, host '$host', name '$name')",
    async ({ client, server, host, name, selected }) => {
      spawnState.podmanInfo = `true\ttrue\t/tmp/fallback.sock\t${server}\n`;
      spawnState.podmanClientVersion = `${client}\n`;
      spawnState.podmanConnections = JSON.stringify([
        { Name: "named", URI: "unix:///tmp/named.sock", Default: true },
      ]);
      await withEnvAsync({ CONTAINER_CONNECTION: name, CONTAINER_HOST: host }, async () => {
        const runtime = await resolvePodmanSandboxRuntimeInfo();
        expect(runtime).toMatchObject({
          machine: false,
          rootless: true,
          version: server,
          target: { globalArgs: ["--url", `unix:///tmp/${selected}.sock`] },
        });
        expect(spawnState.calls.filter((call) => call.args[0] === "--version")).toEqual([
          { command: "podman", args: ["--version"] },
        ]);
        spawnState.commandResult = { code: 0, stdout: "container", stderr: "" };
        await execContainerRaw(bindPodmanSandboxEngine(runtime.target), ["inspect", "container"]);
        expect(spawnState.calls.at(-1)).toEqual({
          command: "podman",
          args: ["--url", `unix:///tmp/${selected}.sock`, "inspect", "container"],
        });
      });
    },
  );

  it.each([
    {
      name: "missing",
      host: "unix:///tmp/host.sock",
      version: "podman version 5.0.0",
      code: 0,
      remote: false,
      error: /could not be identified/u,
    },
    {
      name: "remote",
      host: "  ",
      version: "podman version 5.0.0",
      code: 0,
      remote: true,
      error: /active Podman connection is remote/u,
    },
    {
      name: "named",
      host: "unix:///tmp/host.sock",
      version: "podman version 5.0.0",
      code: 125,
      remote: false,
      error: /Unset either CONTAINER_HOST or CONTAINER_CONNECTION/u,
    },
  ])(
    "rejects unresolvable selection $name ($host, $version, $code)",
    async ({ name, host, version, code, remote, error }) => {
      spawnState.podmanInfo = "true\ttrue\t/tmp/fallback.sock\t4.7.2\n";
      spawnState.podmanClientVersion = `${version}\n`;
      spawnState.podmanVersionExitCode = code;
      spawnState.podmanConnections = JSON.stringify([
        {
          Name: remote ? "remote" : "named",
          URI: remote
            ? "ssh://example.test/run/user/1000/podman/podman.sock"
            : "unix:///tmp/named.sock",
          Default: true,
        },
      ]);
      await withEnvAsync({ CONTAINER_CONNECTION: name, CONTAINER_HOST: host }, async () => {
        await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(error);
      });
    },
  );

  it.each(["4.7.2", "4.8.0"])(
    "keeps the selected Machine identity for client %s and validates that Machine",
    async (client) => {
      const uri = "ssh://core@127.0.0.1:60000/run/user/501/podman/podman.sock";
      const identity = "/tmp/selected-machine-key";
      const hostWins = client === "4.7.2";
      spawnState.podmanClientVersion = `podman version ${client}\n`;
      spawnState.podmanInfo = "true\ttrue\t\t4.7.2\n";
      spawnState.podmanConnections = JSON.stringify([
        {
          Name: "podman-machine-default",
          URI: uri,
          Identity: hostWins ? "/tmp/losing-named-key" : identity,
        },
      ]);
      const machine = {
        Name: "podman-machine-default",
        Running: true,
        IdentityPath: identity,
        Port: 60000,
        RemoteUsername: "core",
      };
      spawnState.podmanMachines = JSON.stringify([machine]);
      await withEnvAsync(
        {
          CONTAINER_CONNECTION: hostWins ? "missing" : "podman-machine-default",
          CONTAINER_HOST: hostWins ? uri : "unix:///tmp/host.sock",
          CONTAINER_SSHKEY: hostWins ? identity : "/tmp/losing-host-key",
        },
        async () => {
          await expect(resolvePodmanSandboxRuntimeInfo()).resolves.toMatchObject({
            machine: true,
            target: { globalArgs: ["--url", uri, "--identity", identity] },
          });
          spawnState.podmanMachines = JSON.stringify([{ ...machine, Running: false }]);
          await expect(resolvePodmanSandboxRuntimeInfo()).rejects.toThrow(
            /active Podman connection is remote/u,
          );
        },
      );
    },
  );

  it("revalidates the active Podman connection on every resolution", async () => {
    spawnState.podmanInfo = "true\tfalse\t\t5.0.0\n";
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
      version: "5.0.0",
      target: { key: "local", globalArgs: [] },
    });

    expect(spawnState.calls.some((call) => call.args[0] === "system")).toBe(false);
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
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

  it("rejects a different allowed Podman Machine after a runtime target is recorded", async () => {
    spawnState.podmanInfo = "true\ttrue\t\t5.0.0\n";
    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-first",
        URI: "ssh://core@127.0.0.1:60001/run/user/501/podman/podman.sock",
        Identity: "/tmp/first-machine-key",
        Default: true,
      },
    ]);
    spawnState.podmanMachines = JSON.stringify([
      {
        Name: "podman-machine-first",
        Running: true,
        IdentityPath: "/tmp/first-machine-key",
        Port: 60001,
        RemoteUsername: "core",
      },
    ]);
    const first = await resolvePodmanSandboxRuntimeInfo();

    spawnState.podmanConnections = JSON.stringify([
      {
        Name: "podman-machine-second",
        URI: "ssh://core@127.0.0.1:60002/run/user/501/podman/podman.sock",
        Identity: "/tmp/second-machine-key",
        Default: true,
      },
    ]);
    spawnState.podmanMachines = JSON.stringify([
      {
        Name: "podman-machine-second",
        Running: true,
        IdentityPath: "/tmp/second-machine-key",
        Port: 60002,
        RemoteUsername: "core",
      },
    ]);

    await expect(
      validateSandboxContainerEngineTarget(podmanSandboxEngine, first.target),
    ).rejects.toThrow(/active Podman connection changed/u);
  });
});

describe("ensureContainerImage", () => {
  it.each([
    {
      engine: "docker",
      image: DEFAULT_SANDBOX_IMAGE,
      stderr: "",
      error: `Sandbox image not found: ${DEFAULT_SANDBOX_IMAGE}. Build it with scripts/sandbox-setup.sh before enabling Docker sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`,
    },
    {
      engine: "podman",
      image: DEFAULT_SANDBOX_IMAGE,
      stderr: "",
      error: `podman build -t ${DEFAULT_SANDBOX_IMAGE} -f scripts/docker/sandbox/Dockerfile .`,
    },
    {
      engine: "docker",
      image: DEFAULT_SANDBOX_IMAGE,
      stderr:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      error: "Docker daemon is not available",
    },
    {
      engine: "docker",
      image: DEFAULT_SANDBOX_IMAGE,
      stderr: "permission denied",
      error: "Failed to inspect sandbox image: permission denied",
    },
    {
      engine: "docker",
      image: "example/custom:latest",
      stderr: "",
      error: "Sandbox image not found: example/custom:latest. Build or pull it first.",
    },
  ])(
    "reports $engine image inspection failure: $error",
    async ({ engine, image, stderr, error }) => {
      spawnState.imageExists = false;
      spawnState.inspectError = stderr;
      const result = ensureContainerImage(
        engine === "docker" ? dockerSandboxEngine : podmanSandboxEngine,
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
});

describe("execDockerRaw", () => {
  it.each(["throw", "result"])(
    "keeps ordinary cancellation distinct from timeout (%s)",
    async (mode) => {
      const controller = new AbortController();
      const reason = new Error("synthetic-private-cancellation");
      spawnState.cancelCommand = "create";
      spawnState.cancelMode = mode;
      spawnState.cancelController = controller;
      spawnState.cancelReason = reason;
      const error = await execDockerRaw(["create", "--env", "TOKEN=synthetic-private-argument"], {
        signal: controller.signal,
        allowFailure: true,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: "AbortError", message: "Aborted" });
      expect(error).not.toHaveProperty("cause");
    },
  );

  it("preserves canonical wrapper execution errors", async () => {
    spawnState.executionError = new Error("docker execution failed");

    await expect(
      execDockerRaw(["image", "inspect", DEFAULT_SANDBOX_IMAGE], { allowFailure: true }),
    ).rejects.toThrow("docker execution failed");
  });

  it("rejects transport failures even when Docker exits 7", async () => {
    spawnState.transportFailure = true;
    spawnState.transportExitCode = 7;
    await expect(execDockerRaw(["version"], { allowFailure: true })).rejects.toThrow(
      "docker stream failed",
    );
  });

  it("does not include raw container arguments when stderr is empty", async () => {
    spawnState.plainExitWithoutStderr = true;
    const secret = "sandbox-secret-value";

    const error = await execDockerRaw(["create", "--env", `TOKEN=${secret}`]).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Docker command failed (exit 1)");
    expect((error as Error).message).not.toContain(secret);
  });
});
