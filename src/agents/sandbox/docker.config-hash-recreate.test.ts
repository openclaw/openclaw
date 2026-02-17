import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxConfig } from "./types.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { ensureSandboxContainer } from "./docker.js";

type SpawnCall = {
  command: string;
  args: string[];
};

const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  inspectRunning: true,
  labelHash: "",
}));

const registryMocks = vi.hoisted(() => ({
  readRegistry: vi.fn(),
  updateRegistry: vi.fn(),
}));

vi.mock("./registry.js", () => ({
  readRegistry: registryMocks.readRegistry,
  updateRegistry: registryMocks.updateRegistry,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      spawnState.calls.push({ command, args });
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        stdin: { end: (input?: string | Buffer) => void };
        kill: (signal?: NodeJS.Signals) => void;
      };
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      child.stdin = { end: () => undefined };
      child.kill = () => undefined;

      let code = 0;
      let stdout = "";
      let stderr = "";
      if (command !== "docker") {
        code = 1;
        stderr = `unexpected command: ${command}`;
      } else if (args[0] === "inspect" && args[1] === "-f" && args[2] === "{{.State.Running}}") {
        stdout = spawnState.inspectRunning ? "true\n" : "false\n";
      } else if (
        args[0] === "inspect" &&
        args[1] === "-f" &&
        args[2]?.includes('index .Config.Labels "openclaw.configHash"')
      ) {
        stdout = `${spawnState.labelHash}\n`;
      } else if (
        (args[0] === "rm" && args[1] === "-f") ||
        (args[0] === "image" && args[1] === "inspect") ||
        args[0] === "create" ||
        args[0] === "start"
      ) {
        code = 0;
      } else {
        code = 1;
        stderr = `unexpected docker args: ${args.join(" ")}`;
      }

      queueMicrotask(() => {
        if (stdout) {
          child.stdout.emit("data", Buffer.from(stdout));
        }
        if (stderr) {
          child.stderr.emit("data", Buffer.from(stderr));
        }
        child.emit("close", code);
      });
      return child;
    },
  };
});

function createSandboxConfig(dns: string[]): SandboxConfig {
  return {
    mode: "all",
    scope: "shared",
    workspaceAccess: "rw",
    workspaceRoot: "~/.openclaw/sandboxes",
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
      dns,
      extraHosts: ["host.docker.internal:host-gateway"],
      binds: ["/tmp/workspace:/workspace:rw"],
    },
    browser: {
      enabled: false,
      image: "openclaw-browser:test",
      containerPrefix: "oc-browser-",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      enableNoVnc: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 5000,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

describe("ensureSandboxContainer config-hash recreation", () => {
  beforeEach(() => {
    spawnState.calls.length = 0;
    spawnState.inspectRunning = true;
    spawnState.labelHash = "";
    registryMocks.readRegistry.mockReset();
    registryMocks.updateRegistry.mockReset();
    registryMocks.updateRegistry.mockResolvedValue(undefined);
  });

  it("recreates shared container when array-order change alters hash", async () => {
    const workspaceDir = "/tmp/workspace";
    const oldCfg = createSandboxConfig(["1.1.1.1", "8.8.8.8"]);
    const newCfg = createSandboxConfig(["8.8.8.8", "1.1.1.1"]);

    const oldHash = computeSandboxConfigHash({
      docker: oldCfg.docker,
      workspaceAccess: oldCfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
    });
    const newHash = computeSandboxConfigHash({
      docker: newCfg.docker,
      workspaceAccess: newCfg.workspaceAccess,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
    });
    expect(newHash).not.toBe(oldHash);

    spawnState.labelHash = oldHash;
    registryMocks.readRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "oc-test-shared",
          sessionKey: "shared",
          createdAtMs: 1,
          lastUsedAtMs: 0,
          image: newCfg.docker.image,
          configHash: oldHash,
        },
      ],
    });

    const containerName = await ensureSandboxContainer({
      sessionKey: "agent:main:session-1",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: newCfg,
    });

    expect(containerName).toBe("oc-test-shared");
    const dockerCalls = spawnState.calls.filter((call) => call.command === "docker");
    expect(
      dockerCalls.some(
        (call) =>
          call.args[0] === "rm" && call.args[1] === "-f" && call.args[2] === "oc-test-shared",
      ),
    ).toBe(true);
    const createCall = dockerCalls.find((call) => call.args[0] === "create");
    expect(createCall).toBeDefined();
    expect(createCall?.args).toContain(`openclaw.configHash=${newHash}`);
    expect(registryMocks.updateRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        containerName: "oc-test-shared",
        configHash: newHash,
      }),
    );
  });
});
