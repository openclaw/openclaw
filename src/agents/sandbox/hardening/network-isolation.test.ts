import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NetworkMode } from "../types.js";
import { buildNetworkFlag, applyMetadataEgressBlock } from "./network-isolation.js";

vi.mock("../docker.js", () => ({
  execDockerRaw: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { execDockerRaw } = await import("../docker.js");
const mockExecDockerRaw = vi.mocked(execDockerRaw);

describe("network-isolation", () => {
  describe("buildNetworkFlag", () => {
    it('builds --network=none for "none" mode', () => {
      expect(buildNetworkFlag("none")).toEqual(["--network=none"]);
    });

    it('builds --network=bridge for "bridge" mode', () => {
      expect(buildNetworkFlag("bridge")).toEqual(["--network=bridge"]);
    });

    it('builds --network=host for "host" mode', () => {
      expect(buildNetworkFlag("host")).toEqual(["--network=host"]);
    });

    it("accepts NetworkMode type values", () => {
      const mode: NetworkMode = "none";
      const flags = buildNetworkFlag(mode);
      expect(flags).toHaveLength(1);
      expect(flags[0]).toContain("--network=");
    });
  });

  describe("applyMetadataEgressBlock", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('skips iptables when networkMode is "none"', async () => {
      await applyMetadataEgressBlock("test-container", "none");
      expect(mockExecDockerRaw).not.toHaveBeenCalled();
    });

    it("throws when iptables rules fail on bridge network", async () => {
      mockExecDockerRaw.mockResolvedValueOnce({
        stdout: Buffer.from(""),
        stderr: Buffer.from("iptables: permission denied"),
        code: 1,
      });

      await expect(applyMetadataEgressBlock("test-container", "bridge")).rejects.toThrow(
        /Metadata egress block failed/,
      );
    });

    it("throws when iptables verification fails", async () => {
      // Apply step succeeds
      mockExecDockerRaw.mockResolvedValueOnce({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        code: 0,
      });
      // Verify step fails
      mockExecDockerRaw.mockResolvedValueOnce({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        code: 1,
      });

      await expect(applyMetadataEgressBlock("test-container", "bridge")).rejects.toThrow(
        /Metadata egress verification failed/,
      );
    });

    it("succeeds when both apply and verify pass", async () => {
      mockExecDockerRaw.mockResolvedValueOnce({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        code: 0,
      });
      mockExecDockerRaw.mockResolvedValueOnce({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        code: 0,
      });

      await expect(applyMetadataEgressBlock("test-container", "bridge")).resolves.toBeUndefined();
      expect(mockExecDockerRaw).toHaveBeenCalledTimes(2);
    });

    it("applies rules by default when networkMode is undefined", async () => {
      mockExecDockerRaw.mockResolvedValueOnce({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        code: 0,
      });
      mockExecDockerRaw.mockResolvedValueOnce({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        code: 0,
      });

      await applyMetadataEgressBlock("test-container");
      expect(mockExecDockerRaw).toHaveBeenCalledTimes(2);
    });
  });
});
