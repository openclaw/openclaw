import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxConfig } from "./types.js";
import { DEFAULT_SANDBOX_MICROVM_PREFIX } from "./constants.js";
import { slugifySessionKey, resolveSandboxScopeKey } from "./shared.js";

// ---- spawn mock ----

type SpawnCall = { command: string; args: string[] };
const spawnCalls: SpawnCall[] = [];

let spawnBehavior: (
  command: string,
  args: string[],
) => { stdout?: string; stderr?: string; code?: number };

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      const child = new EventEmitter() as {
        stdout?: Readable;
        stderr?: Readable;
        on: (event: string, cb: (...args: unknown[]) => void) => void;
      };
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });

      const behavior = spawnBehavior(command, args);
      queueMicrotask(() => {
        if (behavior.stdout) {
          child.stdout!.emit("data", Buffer.from(behavior.stdout));
        }
        if (behavior.stderr) {
          child.stderr!.emit("data", Buffer.from(behavior.stderr));
        }
        child.emit("close", behavior.code ?? 0);
      });
      return child;
    },
  };
});

// ---- registry mock ----

let registryEntries: Array<Record<string, unknown>> = [];
const updateRegistryCalls: Array<Record<string, unknown>> = [];

vi.mock("./registry.js", () => ({
  readRegistry: () => Promise.resolve({ entries: registryEntries }),
  updateRegistry: (entry: Record<string, unknown>) => {
    updateRegistryCalls.push(entry);
    return Promise.resolve();
  },
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));

vi.mock("../../cli/command-format.js", () => ({
  formatCliCommand: (cmd: string) => cmd,
}));

// Import after mocks
const { ensureMicrovmSandbox } = await import("./docker-sandboxes.js");
const { computeMicrovmConfigHash } = await import("./config-hash.js");

// ---- helpers ----

function makeSandboxConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    mode: "non-main",
    scope: "agent",
    backend: "microvm",
    workspaceAccess: "rw",
    workspaceRoot: "/tmp/sandboxes",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: ["ALL"],
    },
    microvm: {
      sandboxPrefix: DEFAULT_SANDBOX_MICROVM_PREFIX,
    },
    browser: {
      enabled: false,
      image: "openclaw-sandbox-browser:bookworm-slim",
      containerPrefix: "openclaw-sbx-browser-",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      enableNoVnc: false,
      allowHostControl: false,
      autoStart: true,
      autoStartTimeoutMs: 12_000,
    },
    tools: {},
    prune: { idleHours: 24, maxAgeDays: 7 },
    ...overrides,
  };
}

const SESSION_KEY = "agent:main:test-session";
const DEFAULT_PARAMS = {
  sessionKey: SESSION_KEY,
  workspaceDir: "/tmp/sandboxes/test",
  agentWorkspaceDir: "/home/user/.openclaw/workspace",
};

// Compute the expected sandbox name using the same logic as production code.
const SCOPE_KEY = resolveSandboxScopeKey("agent", SESSION_KEY);
const SLUG = slugifySessionKey(SCOPE_KEY);
const EXPECTED_NAME = `${DEFAULT_SANDBOX_MICROVM_PREFIX}${SLUG}`
  .slice(0, 63)
  .replace(/[^a-zA-Z0-9_-]/g, "-");

function computeExpectedHash(cfg: SandboxConfig) {
  return computeMicrovmConfigHash({
    template: cfg.microvm.template,
    sandboxPrefix: cfg.microvm.sandboxPrefix,
    env: cfg.microvm.env,
    setupCommand: cfg.microvm.setupCommand,
    workspaceDir: DEFAULT_PARAMS.workspaceDir,
    agentWorkspaceDir: DEFAULT_PARAMS.agentWorkspaceDir,
  });
}

function defaultSpawnBehavior(_command: string, args: string[]) {
  const subArgs = args.slice(1); // strip "sandbox" prefix
  const sub = subArgs[0];
  if (sub === "ls" && subArgs.includes("--quiet")) {
    return { stdout: "", code: 0 };
  }
  if (sub === "ls" && subArgs.includes("--json")) {
    return { stdout: JSON.stringify({ vms: [] }), code: 0 };
  }
  return { stdout: "", code: 0 };
}

function spawnWithSandbox(name: string, status: string, fallback: typeof defaultSpawnBehavior) {
  return (_command: string, args: string[]) => {
    const subArgs = args.slice(1);
    if (subArgs[0] === "ls" && subArgs.includes("--json")) {
      return {
        stdout: JSON.stringify({ vms: [{ name, status }] }),
        code: 0,
      };
    }
    return fallback(_command, args);
  };
}

// ---- tests ----

describe("ensureMicrovmSandbox", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    updateRegistryCalls.length = 0;
    registryEntries = [];
    spawnBehavior = defaultSpawnBehavior;
  });

  it("throws when docker sandbox CLI is unavailable", async () => {
    spawnBehavior = () => ({ stdout: "", stderr: "unknown command", code: 1 });

    await expect(
      ensureMicrovmSandbox({ ...DEFAULT_PARAMS, cfg: makeSandboxConfig() }),
    ).rejects.toThrow("Docker Sandboxes (microVM) backend requires Docker Desktop 4.58+");
  });

  it("creates sandbox when it does not exist", async () => {
    const name = await ensureMicrovmSandbox({
      ...DEFAULT_PARAMS,
      cfg: makeSandboxConfig(),
    });

    expect(name).toBe(EXPECTED_NAME);
    const createCall = spawnCalls.find((c) => c.args[0] === "sandbox" && c.args[1] === "create");
    expect(createCall).toBeDefined();
    expect(createCall!.args).toContain(EXPECTED_NAME);
    expect(updateRegistryCalls).toHaveLength(1);
    expect(updateRegistryCalls[0]).toMatchObject({
      containerName: EXPECTED_NAME,
      backend: "microvm",
    });
  });

  it("reuses sandbox when config hash matches", async () => {
    const cfg = makeSandboxConfig();
    const expectedHash = computeExpectedHash(cfg);

    registryEntries = [{ containerName: EXPECTED_NAME, configHash: expectedHash, lastUsedAtMs: 0 }];
    spawnBehavior = spawnWithSandbox(EXPECTED_NAME, "running", defaultSpawnBehavior);

    const name = await ensureMicrovmSandbox({ ...DEFAULT_PARAMS, cfg });

    expect(name).toBe(EXPECTED_NAME);
    const createCall = spawnCalls.find((c) => c.args[0] === "sandbox" && c.args[1] === "create");
    expect(createCall).toBeUndefined();
  });

  it("removes and recreates on config hash mismatch (cold sandbox)", async () => {
    registryEntries = [{ containerName: EXPECTED_NAME, configHash: "stale-hash", lastUsedAtMs: 0 }];
    spawnBehavior = spawnWithSandbox(EXPECTED_NAME, "stopped", defaultSpawnBehavior);

    const name = await ensureMicrovmSandbox({
      ...DEFAULT_PARAMS,
      cfg: makeSandboxConfig(),
    });

    expect(name).toBe(EXPECTED_NAME);
    const rmCall = spawnCalls.find(
      (c) => c.args[0] === "sandbox" && c.args[1] === "rm" && c.args[2] === EXPECTED_NAME,
    );
    expect(rmCall).toBeDefined();
    const createCall = spawnCalls.find((c) => c.args[0] === "sandbox" && c.args[1] === "create");
    expect(createCall).toBeDefined();
  });

  it("restarts a stopped sandbox when hash matches", async () => {
    const cfg = makeSandboxConfig();
    const expectedHash = computeExpectedHash(cfg);

    registryEntries = [{ containerName: EXPECTED_NAME, configHash: expectedHash, lastUsedAtMs: 0 }];
    spawnBehavior = spawnWithSandbox(EXPECTED_NAME, "stopped", defaultSpawnBehavior);

    await ensureMicrovmSandbox({ ...DEFAULT_PARAMS, cfg });

    const runCall = spawnCalls.find(
      (c) => c.args[0] === "sandbox" && c.args[1] === "run" && c.args[2] === EXPECTED_NAME,
    );
    expect(runCall).toBeDefined();
    const createCall = spawnCalls.find((c) => c.args[0] === "sandbox" && c.args[1] === "create");
    expect(createCall).toBeUndefined();
  });
});
