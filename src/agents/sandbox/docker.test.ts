import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { execDocker } from "./docker.js";

describe("execDocker", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles ENOENT when docker is not installed", async () => {
    const mockChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, handler: (arg?: unknown) => void) => {
        if (event === "error") {
          const err = new Error("spawn docker ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          setImmediate(() => handler(err));
        }
      }),
    };
    spawnMock.mockReturnValue(mockChild);

    await expect(execDocker(["version"])).rejects.toThrow(
      "Docker is not installed or not in PATH. Install Docker to use sandbox mode.",
    );
  });

  it("handles successful docker execution", async () => {
    const mockChild = {
      stdout: {
        on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
          if (event === "data") {
            setImmediate(() => handler(Buffer.from("Docker version 24.0.0")));
          }
        }),
      },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, handler: (code?: number) => void) => {
        if (event === "close") {
          setImmediate(() => handler(0));
        }
      }),
    };
    spawnMock.mockReturnValue(mockChild);

    const result = await execDocker(["version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Docker version");
  });

  it("rejects with stderr message on non-zero exit", async () => {
    const mockChild = {
      stdout: { on: vi.fn() },
      stderr: {
        on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
          if (event === "data") {
            setImmediate(() => handler(Buffer.from("container not found")));
          }
        }),
      },
      on: vi.fn((event: string, handler: (code?: number) => void) => {
        if (event === "close") {
          setImmediate(() => handler(1));
        }
      }),
    };
    spawnMock.mockReturnValue(mockChild);

    await expect(execDocker(["rm", "nonexistent"])).rejects.toThrow("container not found");
  });

  it("resolves with code when allowFailure is true", async () => {
    const mockChild = {
      stdout: { on: vi.fn() },
      stderr: {
        on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
          if (event === "data") {
            setImmediate(() => handler(Buffer.from("not found")));
          }
        }),
      },
      on: vi.fn((event: string, handler: (code?: number) => void) => {
        if (event === "close") {
          setImmediate(() => handler(1));
        }
      }),
    };
    spawnMock.mockReturnValue(mockChild);

    const result = await execDocker(["inspect", "missing"], { allowFailure: true });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("not found");
  });
});
