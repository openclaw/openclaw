// Fail-soft for #90980: a wedged Docker engine makes sandbox container init
// reject fast with a typed timeout (bounded by docker.initTimeoutMs) instead of
// hanging — proving the deadline threads ensureSandboxContainer -> execDockerRaw.
// Mock-based; Windows-safe (behavior via hoisted state, command path ignored).
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxConfig } from "./types.js";

type MockDockerChild = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: { end: (input?: string | Buffer) => void };
  kill: (signal?: NodeJS.Signals) => boolean;
};

const spawnState = vi.hoisted(() => ({
  // When true, the docker child never emits close/error (wedged engine).
  hang: true,
  killSignals: [] as (NodeJS.Signals | undefined)[],
}));

const registryMocks = vi.hoisted(() => ({
  readRegistryEntry: vi.fn(),
  updateRegistry: vi.fn(),
}));

vi.mock("./registry.js", () => ({
  readRegistryEntry: registryMocks.readRegistryEntry,
  updateRegistry: registryMocks.updateRegistry,
}));

function createMockDockerChild(): MockDockerChild {
  const child = new EventEmitter() as MockDockerChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = { end: () => undefined };
  child.kill = (signal?: NodeJS.Signals) => {
    spawnState.killSignals.push(signal);
    return true;
  };
  return child;
}

function spawnMockDockerProcess() {
  const child = createMockDockerChild();
  if (!spawnState.hang) {
    queueMicrotask(() => child.emit("close", 0));
  }
  return child;
}

async function createChildProcessMock() {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMockDockerProcess };
}

vi.mock("node:child_process", async () => createChildProcessMock());

let ensureSandboxContainer: typeof import("./docker.js").ensureSandboxContainer;
let isDockerExecTimeoutError: typeof import("./docker.js").isDockerExecTimeoutError;

async function loadFreshDockerModule() {
  vi.resetModules();
  vi.doMock("./registry.js", () => ({
    readRegistryEntry: registryMocks.readRegistryEntry,
    updateRegistry: registryMocks.updateRegistry,
  }));
  vi.doMock("node:child_process", async () => createChildProcessMock());
  ({ ensureSandboxContainer, isDockerExecTimeoutError } = await import("./docker.js"));
}

const tmpDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-init-timeout-"));
  tmpDirs.push(dir);
  return dir;
}

function createSandboxConfig(initTimeoutMs: number): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
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
      initTimeoutMs,
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
      enableNoVnc: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 5000,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

describe("ensureSandboxContainer fail-soft on unresponsive Docker", () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    spawnState.hang = true;
    spawnState.killSignals.length = 0;
    registryMocks.readRegistryEntry.mockReset().mockResolvedValue(null);
    registryMocks.updateRegistry.mockReset().mockResolvedValue(undefined);
    await loadFreshDockerModule();
  });

  it("rejects with a typed timeout (not a hang) when the first docker call wedges", async () => {
    const workspaceDir = makeTempDir();

    let caught: unknown;
    try {
      await ensureSandboxContainer({
        sessionKey: "agent:main:session-1",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        cfg: createSandboxConfig(25),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(isDockerExecTimeoutError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe("SANDBOX_DOCKER_TIMEOUT");
    // The wedged child was killed, and we never reached the registry write.
    expect(spawnState.killSignals).toContain("SIGTERM");
    expect(registryMocks.updateRegistry).not.toHaveBeenCalled();
  });
});
