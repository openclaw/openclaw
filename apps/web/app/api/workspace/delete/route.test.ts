import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  discoverProfiles: vi.fn(() => []),
  getEffectiveProfile: vi.fn(() => "default"),
  resolveWorkspaceRoot: vi.fn(() => null),
}));

type MockSpawnChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  kill: ReturnType<typeof vi.fn>;
};

function mockSpawnResult(
  spawnMock: {
    mockImplementation: (
      implementation: (...args: unknown[]) => unknown,
    ) => unknown;
  },
  params: {
  code?: number;
  stdout?: string;
  stderr?: string;
  emitError?: Error | null;
  },
): { getChild: () => MockSpawnChild | null } {
  let spawnedChild: MockSpawnChild | null = null;
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as MockSpawnChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write: vi.fn(),
      end: vi.fn(),
    };
    child.kill = vi.fn();
    spawnedChild = child;

    queueMicrotask(() => {
      if (params.stdout) {
        child.stdout.emit("data", Buffer.from(params.stdout));
      }
      if (params.stderr) {
        child.stderr.emit("data", Buffer.from(params.stderr));
      }
      if (params.emitError) {
        child.emit("error", params.emitError);
        return;
      }
      child.emit("close", params.code ?? 0);
    });

    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  });
  return {
    getChild: () => spawnedChild,
  };
}

describe("POST /api/workspace/delete", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function callDelete(body: Record<string, unknown>) {
    const { POST } = await import("./route.js");
    const req = new Request("http://localhost/api/workspace/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return POST(req);
  }

  it("returns 400 for invalid profile names", async () => {
    const response = await callDelete({ profile: "../bad" });
    expect(response.status).toBe(400);
  });

  it("returns 404 when profile does not exist", async () => {
    const workspace = await import("@/lib/workspace");
    vi.mocked(workspace.discoverProfiles).mockReturnValue([]);
    const response = await callDelete({ profile: "work" });
    expect(response.status).toBe(404);
  });

  it("returns 409 when profile has no workspace directory", async () => {
    const workspace = await import("@/lib/workspace");
    vi.mocked(workspace.discoverProfiles).mockReturnValue([
      {
        name: "work",
        stateDir: "/home/testuser/.openclaw-work",
        workspaceDir: null,
        isActive: false,
        hasConfig: true,
      },
    ]);
    const response = await callDelete({ profile: "work" });
    expect(response.status).toBe(409);
  });

  it("runs openclaw workspace delete for the selected profile", async () => {
    const workspace = await import("@/lib/workspace");
    const { spawn } = await import("node:child_process");
    vi.mocked(workspace.discoverProfiles).mockReturnValue([
      {
        name: "work",
        stateDir: "/home/testuser/.openclaw-work",
        workspaceDir: "/home/testuser/.openclaw-work/workspace",
        isActive: true,
        hasConfig: true,
      },
    ]);
    vi.mocked(workspace.getEffectiveProfile).mockReturnValue("work");
    vi.mocked(workspace.resolveWorkspaceRoot).mockReturnValue("/home/testuser/.openclaw-work/workspace");
    const spawnResult = mockSpawnResult(vi.mocked(spawn), { code: 0 });

    const response = await callDelete({ profile: "work" });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.deleted).toBe(true);
    expect(json.profile).toBe("work");

    expect(spawn).toHaveBeenCalledWith(
      "openclaw",
      ["--profile", "work", "workspace", "delete"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
    const child = spawnResult.getChild();
    expect(child).toBeTruthy();
    expect(child?.stdin.write).toHaveBeenCalledWith("y\n");
    expect(child?.stdin.write).toHaveBeenCalledWith("yes\n");
    expect(child?.stdin.end).toHaveBeenCalled();
  });

  it("returns 501 when workspace delete command is unavailable", async () => {
    const workspace = await import("@/lib/workspace");
    const { spawn } = await import("node:child_process");
    vi.mocked(workspace.discoverProfiles).mockReturnValue([
      {
        name: "work",
        stateDir: "/home/testuser/.openclaw-work",
        workspaceDir: "/home/testuser/.openclaw-work/workspace",
        isActive: false,
        hasConfig: true,
      },
    ]);
    mockSpawnResult(vi.mocked(spawn), {
      code: 0,
      stdout:
        "Usage: openclaw [options] [command]\nHint: commands suffixed with * have subcommands",
    });

    const response = await callDelete({ profile: "work" });
    expect(response.status).toBe(501);
  });
});
