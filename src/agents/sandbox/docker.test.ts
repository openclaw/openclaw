import { spawn } from "node:child_process";
import { describe, expect, it, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import { ensureDockerImage } from "./docker.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

describe("ensureDockerImage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function mockSpawn(exitCode: number, stdout: string, stderr: string) {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    (spawn as any).mockReturnValue(child);

    setTimeout(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", exitCode);
    }, 10);
    return child;
  }

  it("throws 'Sandbox image not found' when docker inspect fails with 'No such image'", async () => {
    mockSpawn(1, "", "Error: No such image: test-image");

    await expect(ensureDockerImage("test-image")).rejects.toThrow(
      "Sandbox image not found: test-image. Build or pull it first."
    );
  });

  it("throws 'Failed to inspect sandbox image' when docker inspect fails with other errors", async () => {
    mockSpawn(1, "", "permission denied");

    await expect(ensureDockerImage("test-image")).rejects.toThrow(
      "Failed to inspect sandbox image: permission denied"
    );
  });
});
