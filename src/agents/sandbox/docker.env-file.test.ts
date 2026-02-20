import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSandboxContainer } from "./docker.js";
import type {
  SandboxBrowserConfig,
  SandboxConfig,
  SandboxPruneConfig,
  SandboxToolPolicy,
} from "./types.js";

type SpawnChild = EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  stdin: { end: () => void };
  kill: () => void;
};

const spawnState = vi.hoisted(() => ({
  calls: [] as { args: string[] }[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_command: string, args: string[]) => {
      spawnState.calls.push({ args });
      const child = new EventEmitter() as unknown as SpawnChild;
      child.stdout = new Readable({
        read() {
          this.push(null);
        },
      });
      child.stderr = new Readable({
        read() {
          this.push(null);
        },
      });
      child.stdin = { end: () => undefined };
      child.kill = () => undefined;

      // Simulate docker inspect -f {{.State.Running}} name -> false
      let stdout = "";
      if (args[0] === "inspect") {
        stdout = "false\n";
      }

      queueMicrotask(() => {
        if (stdout) {
          child.stdout.emit("data", Buffer.from(stdout));
        }
        child.emit("close", 0);
      });
      return child;
    },
  };
});

vi.mock("./registry.js", () => ({
  readRegistry: vi.fn(async () => ({ entries: [] })),
  updateRegistry: vi.fn(),
}));

const MOCK_ENV_FILES: Record<string, string> = {
  "/path/to/test.env": "TEST_VAR=test_value\nANTHROPIC_API_KEY=secret_value\n",
  "/path/to/override.env": "TEST_VAR=overridden_value\nEXTRA_VAR=extra_value\n",
};

// Mock the shared security module (inspectPathPermissions + safeStat + bit helpers).
const mockInspectPathPermissions = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    isSymlink: false,
    isDir: false,
    mode: 0o100600,
    bits: 0o600,
    source: "posix" as const,
    worldWritable: false,
    groupWritable: false,
    worldReadable: false,
    groupReadable: false,
  })),
);

const mockSafeStat = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    isSymlink: false,
    isDir: true,
    mode: 0o040755,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  })),
);

vi.mock("../../security/audit-fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../security/audit-fs.js")>();
  return {
    ...actual,
    inspectPathPermissions: mockInspectPathPermissions,
    safeStat: mockSafeStat,
  };
});

vi.mock("node:fs/promises", async (_importOriginal) => {
  return {
    default: {
      readFile: vi.fn(async (filePath: string) => {
        const content = MOCK_ENV_FILES[filePath];
        if (content !== undefined) {
          return content;
        }
        throw new Error("ENOENT");
      }),
      mkdir: vi.fn(),
    },
  };
});

describe("ensureSandboxContainer with envFile", () => {
  beforeEach(() => {
    spawnState.calls = [];
    vi.clearAllMocks();
  });

  it("merges env file contents into docker env and sanitizes them for create", async () => {
    const cfg: SandboxConfig = {
      mode: "all",
      scope: "shared",
      workspaceAccess: "rw",
      workspaceRoot: "/tmp/sandboxes",
      docker: {
        image: "test-image",
        containerPrefix: "prefix-",
        workdir: "/app",
        readOnlyRoot: false,
        tmpfs: [],
        network: "none",
        capDrop: [],
        env: { LANG: "C.UTF-8" },
        envFile: "/path/to/test.env",
      },
      browser: { enabled: false } as unknown as SandboxBrowserConfig,
      tools: {} as unknown as SandboxToolPolicy,
      prune: {} as unknown as SandboxPruneConfig,
    };

    await ensureSandboxContainer({
      sessionKey: "session1",
      workspaceDir: "/tmp/ws",
      agentWorkspaceDir: "/tmp/aws",
      cfg,
    });

    const createCall = spawnState.calls.find((c) => c.args[0] === "create");
    expect(createCall).toBeDefined();
    const args = createCall!.args;

    // Check that LANG is present
    expect(args).toContain("--env");
    expect(args).toContain("LANG=C.UTF-8");

    // Check that TEST_VAR is in the args (not blocked)
    expect(args).toContain("TEST_VAR=test_value");

    // Check that ANTHROPIC_API_KEY is blocked from 'create' args by sanitizeEnvVars
    expect(args).not.toContain("ANTHROPIC_API_KEY=secret_value");

    // Important: check that ANTHROPIC_API_KEY IS in the cfg.docker.env for tool call injection
    expect(cfg.docker.env).toHaveProperty("ANTHROPIC_API_KEY", "secret_value");
    expect(cfg.docker.env).toHaveProperty("TEST_VAR", "test_value");
    expect(cfg.docker.env).toHaveProperty("LANG", "C.UTF-8");
  });

  it("merges envFile array with last file taking precedence on key collisions", async () => {
    const cfg: SandboxConfig = {
      mode: "all",
      scope: "shared",
      workspaceAccess: "rw",
      workspaceRoot: "/tmp/sandboxes",
      docker: {
        image: "test-image",
        containerPrefix: "prefix-",
        workdir: "/app",
        readOnlyRoot: false,
        tmpfs: [],
        network: "none",
        capDrop: [],
        env: {},
        // test.env sets TEST_VAR=test_value; override.env sets TEST_VAR=overridden_value.
        // The last file should win.
        envFile: ["/path/to/test.env", "/path/to/override.env"],
      },
      browser: { enabled: false } as unknown as SandboxBrowserConfig,
      tools: {} as unknown as SandboxToolPolicy,
      prune: {} as unknown as SandboxPruneConfig,
    };

    await ensureSandboxContainer({
      sessionKey: "session-array",
      workspaceDir: "/tmp/ws",
      agentWorkspaceDir: "/tmp/aws",
      cfg,
    });

    // override.env (last) should win over test.env (first) for TEST_VAR.
    expect(cfg.docker.env).toHaveProperty("TEST_VAR", "overridden_value");
    // Values from both files are present.
    expect(cfg.docker.env).toHaveProperty("EXTRA_VAR", "extra_value");
    expect(cfg.docker.env).toHaveProperty("ANTHROPIC_API_KEY", "secret_value");
  });

  it("explicit env overrides envFile values but envFile values remain for tool injection", async () => {
    const cfg: SandboxConfig = {
      mode: "all",
      scope: "shared",
      workspaceAccess: "rw",
      workspaceRoot: "/tmp/sandboxes",
      docker: {
        image: "test-image",
        containerPrefix: "prefix-",
        workdir: "/app",
        readOnlyRoot: false,
        tmpfs: [],
        network: "none",
        capDrop: [],
        // Explicit env should always take precedence over envFile values.
        env: { TEST_VAR: "explicit_value", LANG: "C.UTF-8" },
        envFile: "/path/to/test.env",
      },
      browser: { enabled: false } as unknown as SandboxBrowserConfig,
      tools: {} as unknown as SandboxToolPolicy,
      prune: {} as unknown as SandboxPruneConfig,
    };

    await ensureSandboxContainer({
      sessionKey: "session-explicit-wins",
      workspaceDir: "/tmp/ws",
      agentWorkspaceDir: "/tmp/aws",
      cfg,
    });

    const createCall = spawnState.calls.find((c) => c.args[0] === "create");
    expect(createCall).toBeDefined();
    const args = createCall!.args;

    // Explicit env wins for TEST_VAR.
    expect(args).toContain("TEST_VAR=explicit_value");
    expect(args).not.toContain("TEST_VAR=test_value");
    // LANG from explicit env is present.
    expect(args).toContain("LANG=C.UTF-8");

    // Merged env has explicit value (not file value) for TEST_VAR.
    expect(cfg.docker.env).toHaveProperty("TEST_VAR", "explicit_value");
    // Secret from envFile is still in merged env for tool call injection.
    expect(cfg.docker.env).toHaveProperty("ANTHROPIC_API_KEY", "secret_value");
  });

  it("rejects world-readable envFile", async () => {
    mockInspectPathPermissions.mockResolvedValueOnce({
      ok: true,
      isSymlink: false,
      isDir: false,
      mode: 0o100604,
      bits: 0o604,
      source: "posix" as const,
      worldWritable: false,
      groupWritable: false,
      worldReadable: true,
      groupReadable: false,
    });

    const cfg: SandboxConfig = {
      mode: "all",
      scope: "shared",
      workspaceAccess: "rw",
      workspaceRoot: "/tmp/sandboxes",
      docker: {
        image: "test-image",
        containerPrefix: "prefix-",
        workdir: "/app",
        readOnlyRoot: false,
        tmpfs: [],
        network: "none",
        capDrop: [],
        env: {},
        envFile: "/path/to/test.env",
      },
      browser: { enabled: false } as unknown as SandboxBrowserConfig,
      tools: {} as unknown as SandboxToolPolicy,
      prune: {} as unknown as SandboxPruneConfig,
    };

    await expect(
      ensureSandboxContainer({
        sessionKey: "session-world-readable",
        workspaceDir: "/tmp/ws",
        agentWorkspaceDir: "/tmp/aws",
        cfg,
      }),
    ).rejects.toThrow("world-readable");
  });

  it("rejects group-readable envFile", async () => {
    mockInspectPathPermissions.mockResolvedValueOnce({
      ok: true,
      isSymlink: false,
      isDir: false,
      mode: 0o100640,
      bits: 0o640,
      source: "posix" as const,
      worldWritable: false,
      groupWritable: false,
      worldReadable: false,
      groupReadable: true,
    });

    const cfg: SandboxConfig = {
      mode: "all",
      scope: "shared",
      workspaceAccess: "rw",
      workspaceRoot: "/tmp/sandboxes",
      docker: {
        image: "test-image",
        containerPrefix: "prefix-",
        workdir: "/app",
        readOnlyRoot: false,
        tmpfs: [],
        network: "none",
        capDrop: [],
        env: {},
        envFile: "/path/to/test.env",
      },
      browser: { enabled: false } as unknown as SandboxBrowserConfig,
      tools: {} as unknown as SandboxToolPolicy,
      prune: {} as unknown as SandboxPruneConfig,
    };

    await expect(
      ensureSandboxContainer({
        sessionKey: "session-group-readable",
        workspaceDir: "/tmp/ws",
        agentWorkspaceDir: "/tmp/aws",
        cfg,
      }),
    ).rejects.toThrow("group-readable");
  });

  it("rejects envFile when parent directory is writable by another non-root user", async () => {
    // File itself is fine (0o600).
    // Parent directory is owned by a different non-root user and world-writable.
    const otherUid = (process.getuid?.() ?? 1000) + 1;
    mockSafeStat.mockResolvedValueOnce({
      ok: true,
      isSymlink: false,
      isDir: true,
      mode: 0o040757,
      uid: otherUid,
      gid: 0,
    });

    const cfg: SandboxConfig = {
      mode: "all",
      scope: "shared",
      workspaceAccess: "rw",
      workspaceRoot: "/tmp/sandboxes",
      docker: {
        image: "test-image",
        containerPrefix: "prefix-",
        workdir: "/app",
        readOnlyRoot: false,
        tmpfs: [],
        network: "none",
        capDrop: [],
        env: {},
        envFile: "/path/to/test.env",
      },
      browser: { enabled: false } as unknown as SandboxBrowserConfig,
      tools: {} as unknown as SandboxToolPolicy,
      prune: {} as unknown as SandboxPruneConfig,
    };

    await expect(
      ensureSandboxContainer({
        sessionKey: "session-unsafe-parent",
        workspaceDir: "/tmp/ws",
        agentWorkspaceDir: "/tmp/aws",
        cfg,
      }),
    ).rejects.toThrow("writable by");
  });
});
