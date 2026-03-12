import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveProvider, resetProviderCache } from "./provider-resolver.js";
import { DockerProvider } from "./providers/docker-provider.js";
import { FirecrackerProvider } from "./providers/firecracker-provider.js";
import { GVisorProvider } from "./providers/gvisor-provider.js";

// Mock health checks on the providers directly
const dockerHealthSpy = vi.spyOn(DockerProvider.prototype, "checkHealth");
const gvisorHealthSpy = vi.spyOn(GVisorProvider.prototype, "checkHealth");
const firecrackerHealthSpy = vi.spyOn(FirecrackerProvider.prototype, "checkHealth");

// Suppress console output from the logger
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "debug").mockImplementation(() => {});

describe("Provider Resolver", () => {
  beforeEach(() => {
    resetProviderCache();
    vi.clearAllMocks();

    // Default: Docker available, others unavailable (Phase 1 reality)
    dockerHealthSpy.mockResolvedValue({
      available: true,
      message: "Docker daemon is running",
      version: "Docker 24.0.7",
    });
    gvisorHealthSpy.mockResolvedValue({
      available: false,
      message: "gVisor provider not yet implemented (Phase 2)",
    });
    firecrackerHealthSpy.mockResolvedValue({
      available: false,
      message: "Firecracker provider not yet implemented (Phase 3+)",
    });
  });

  describe("auto-detection", () => {
    it("resolveProvider('auto') returns DockerProvider when Docker is available", async () => {
      const provider = await resolveProvider("auto");

      expect(provider).toBeInstanceOf(DockerProvider);
      expect(provider.name).toBe("docker");
    });

    it("checks backends in order: firecracker, gvisor, docker", async () => {
      await resolveProvider("auto");

      // Firecracker checked first, then gVisor, then Docker
      expect(firecrackerHealthSpy).toHaveBeenCalled();
      expect(gvisorHealthSpy).toHaveBeenCalled();
      expect(dockerHealthSpy).toHaveBeenCalled();

      // Order verification via call ordering
      const firecrackerOrder = firecrackerHealthSpy.mock.invocationCallOrder[0];
      const gvisorOrder = gvisorHealthSpy.mock.invocationCallOrder[0];
      const dockerOrder = dockerHealthSpy.mock.invocationCallOrder[0];

      expect(firecrackerOrder).toBeLessThan(gvisorOrder);
      expect(gvisorOrder).toBeLessThan(dockerOrder);
    });

    it("caches the result — second call returns same instance", async () => {
      const first = await resolveProvider("auto");
      const second = await resolveProvider("auto");

      expect(first).toBe(second);
      // checkHealth should only be called during first resolution
      expect(dockerHealthSpy).toHaveBeenCalledTimes(1);
    });

    it("throws when ALL backends fail health checks", async () => {
      dockerHealthSpy.mockResolvedValue({
        available: false,
        message: "Docker not running",
      });

      await expect(resolveProvider("auto")).rejects.toThrow("No sandbox backend available");
    });
  });

  describe("explicit selection", () => {
    it("resolveProvider('docker') returns DockerProvider without checking others", async () => {
      const provider = await resolveProvider("docker");

      expect(provider).toBeInstanceOf(DockerProvider);
      expect(firecrackerHealthSpy).not.toHaveBeenCalled();
      expect(gvisorHealthSpy).not.toHaveBeenCalled();
    });

    it("resolveProvider('docker') throws when Docker health check fails", async () => {
      dockerHealthSpy.mockResolvedValue({
        available: false,
        message: "Docker daemon not running",
      });

      await expect(resolveProvider("docker")).rejects.toThrow("not available");
    });

    it("resolveProvider('firecracker') throws with 'not available'", async () => {
      await expect(resolveProvider("firecracker")).rejects.toThrow("not available");
    });

    it("resolveProvider('gvisor') throws with 'not available'", async () => {
      await expect(resolveProvider("gvisor")).rejects.toThrow("not available");
    });
  });

  describe("cache management", () => {
    it("resetProviderCache() clears cache — next call re-runs detection", async () => {
      const first = await resolveProvider("auto");
      resetProviderCache();
      const second = await resolveProvider("auto");

      expect(first).not.toBe(second);
      expect(dockerHealthSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("firecracker auto-detection", () => {
    it("resolveProvider('auto') selects Firecracker when available (highest priority)", async () => {
      firecrackerHealthSpy.mockResolvedValue({
        available: true,
        message: "Firecracker vm-runner is healthy",
      });

      const provider = await resolveProvider("auto");

      expect(provider).toBeInstanceOf(FirecrackerProvider);
      expect(provider.name).toBe("firecracker");
      // Should not check lower-priority backends
      expect(gvisorHealthSpy).not.toHaveBeenCalled();
      expect(dockerHealthSpy).not.toHaveBeenCalled();
    });

    it("auto-detection falls through to Docker when Firecracker is unavailable", async () => {
      firecrackerHealthSpy.mockResolvedValue({
        available: false,
        message: "/dev/kvm not available",
      });

      const provider = await resolveProvider("auto");

      expect(provider).toBeInstanceOf(DockerProvider);
      expect(provider.name).toBe("docker");
    });

    it("auto-detection falls through to gVisor when Firecracker is unavailable but gVisor is available", async () => {
      firecrackerHealthSpy.mockResolvedValue({
        available: false,
        message: "/dev/kvm not available",
      });
      gvisorHealthSpy.mockResolvedValue({
        available: true,
        message: "gVisor (runsc) runtime available and functional",
        version: "gVisor runsc",
      });

      const provider = await resolveProvider("auto");

      expect(provider).toBeInstanceOf(GVisorProvider);
      expect(provider.name).toBe("gvisor");
      // Docker should not be checked since gVisor was available
      expect(dockerHealthSpy).not.toHaveBeenCalled();
    });

    it("resolveProvider('firecracker') returns FirecrackerProvider when healthy", async () => {
      firecrackerHealthSpy.mockResolvedValue({
        available: true,
        message: "Firecracker vm-runner is healthy",
      });

      const provider = await resolveProvider("firecracker");

      expect(provider).toBeInstanceOf(FirecrackerProvider);
      expect(provider.name).toBe("firecracker");
    });

    it("resolveProvider('firecracker') throws when unavailable", async () => {
      firecrackerHealthSpy.mockResolvedValue({
        available: false,
        message: "/dev/kvm not available",
      });

      await expect(resolveProvider("firecracker")).rejects.toThrow("not available");
    });
  });

  describe("stub providers", () => {
    it("GVisorProvider.checkHealth() returns unavailable", async () => {
      const gvisor = new GVisorProvider();
      const result = await gvisor.checkHealth();

      expect(result.available).toBe(false);
      expect(result.message).toContain("not yet implemented");
    });
  });
});
