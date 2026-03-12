import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncToSandbox, syncFromSandbox } from "./filesystem.js";

vi.mock("../docker.js", () => ({
  execDocker: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 }),
}));

import { execDocker } from "../docker.js";

const mockExecDocker = vi.mocked(execDocker);

describe("filesystem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("syncToSandbox", () => {
    it("calls execDocker with cp args for host-to-container", async () => {
      await syncToSandbox("my-container", "/host/path", "/container/path");
      expect(mockExecDocker).toHaveBeenCalledWith([
        "cp",
        "/host/path",
        "my-container:/container/path",
      ]);
    });

    it("propagates execDocker errors", async () => {
      mockExecDocker.mockRejectedValueOnce(new Error("docker cp failed"));
      await expect(syncToSandbox("c1", "/src", "/dst")).rejects.toThrow("docker cp failed");
    });
  });

  describe("syncFromSandbox", () => {
    it("calls execDocker with cp args for container-to-host", async () => {
      await syncFromSandbox("my-container", "/container/path", "/host/path");
      expect(mockExecDocker).toHaveBeenCalledWith([
        "cp",
        "my-container:/container/path",
        "/host/path",
      ]);
    });

    it("propagates execDocker errors", async () => {
      mockExecDocker.mockRejectedValueOnce(new Error("permission denied"));
      await expect(syncFromSandbox("c1", "/src", "/dst")).rejects.toThrow("permission denied");
    });
  });
});
