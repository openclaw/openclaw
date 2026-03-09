import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ISandboxProvider, EnsureSandboxParams } from "../provider.js";
import { isBrowserCapable } from "../provider.js";
import { DockerProvider } from "./docker-provider.js";
import { GVisorProvider } from "./gvisor-provider.js";

vi.mock("../docker.js", () => ({
  execDockerRaw: vi.fn(),
  execDocker: vi.fn(),
  ensureSandboxContainer: vi.fn(),
  dockerContainerState: vi.fn(),
}));

vi.mock("../manage.js", () => ({
  listSandboxContainers: vi.fn(),
}));

// Suppress console output from the logger
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "debug").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

import { execDockerRaw, execDocker, dockerContainerState } from "../docker.js";
import { listSandboxContainers } from "../manage.js";

const mockExecDockerRaw = vi.mocked(execDockerRaw);
const mockExecDocker = vi.mocked(execDocker);
const mockDockerContainerState = vi.mocked(dockerContainerState);
const mockListSandboxContainers = vi.mocked(listSandboxContainers);

function makeSandboxParams(overrides?: Partial<EnsureSandboxParams>): EnsureSandboxParams {
  return {
    sessionKey: "sess-abc",
    workspaceDir: "/workspace",
    agentWorkspaceDir: "/agent",
    cfg: {
      mode: "all" as const,
      scope: "session" as const,
      workspaceAccess: "rw" as const,
      workspaceRoot: "/workspace",
      docker: { image: "node:20" },
      browser: { enabled: false },
      tools: { allow: ["*"], deny: [] },
      prune: { idleHours: 24, maxAgeDays: 7 },
      backend: "gvisor" as const,
    } as unknown,
    ...overrides,
  };
}

describe("GVisorProvider", () => {
  let provider: GVisorProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GVisorProvider();
  });

  it("has name 'gvisor'", () => {
    expect(provider.name).toBe("gvisor");
  });

  it("implements ISandboxProvider", () => {
    const _check: ISandboxProvider = provider;
    expect(_check).toBeDefined();
  });

  describe("checkHealth (GVIS-04)", () => {
    it("returns available=true when runsc is in runtimes and test container succeeds", async () => {
      // Stage 1: docker info returns runtimes with runsc
      mockExecDocker.mockResolvedValueOnce({
        stdout: '{"io.containerd.runc.v2":{},"runsc":{}}',
        stderr: "",
        code: 0,
      });
      // Stage 2: test container succeeds
      mockExecDocker.mockResolvedValueOnce({
        stdout: "Hello from Docker!",
        stderr: "",
        code: 0,
      });

      const result = await provider.checkHealth();

      expect(result.available).toBe(true);
      expect(result.message).toContain("runsc");
    });

    it("returns available=false when docker info fails (Docker not available)", async () => {
      mockExecDocker.mockResolvedValueOnce({
        stdout: "",
        stderr: "Cannot connect to Docker daemon",
        code: 1,
      });

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
      expect(result.message).toContain("Docker not available");
    });

    it("returns available=false when docker info succeeds but runsc not in runtimes", async () => {
      mockExecDocker.mockResolvedValueOnce({
        stdout: '{"io.containerd.runc.v2":{}}',
        stderr: "",
        code: 0,
      });

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
      expect(result.message).toContain("not registered");
    });

    it("returns available=false when runsc in runtimes but test container fails", async () => {
      // Stage 1: runsc found
      mockExecDocker.mockResolvedValueOnce({
        stdout: '{"runsc":{}}',
        stderr: "",
        code: 0,
      });
      // Stage 2: test container fails
      mockExecDocker.mockResolvedValueOnce({
        stdout: "",
        stderr: "runtime error",
        code: 1,
      });

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
      expect(result.message).toContain("test failed");
    });

    it("returns available=false when execDocker throws (no unhandled exceptions)", async () => {
      mockExecDocker.mockRejectedValueOnce(new Error("spawn docker ENOENT"));

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
    });
  });

  describe("ensureSandbox (GVIS-01, GVIS-02, GVIS-05)", () => {
    it("creates container with --runtime=runsc flag", async () => {
      mockDockerContainerState.mockResolvedValue({
        exists: false,
        running: false,
      });
      mockExecDocker.mockResolvedValue({
        stdout: "container-id",
        stderr: "",
        code: 0,
      });

      await provider.ensureSandbox(makeSandboxParams());

      // Find the create call (first call to execDocker)
      const createCall = mockExecDocker.mock.calls.find((call) => call[0][0] === "create");
      expect(createCall).toBeDefined();
      expect(createCall![0]).toContain("--runtime=runsc");
    });

    it("creates container with --label openclaw.runtime=runsc", async () => {
      mockDockerContainerState.mockResolvedValue({
        exists: false,
        running: false,
      });
      mockExecDocker.mockResolvedValue({
        stdout: "container-id",
        stderr: "",
        code: 0,
      });

      await provider.ensureSandbox(makeSandboxParams());

      const createCall = mockExecDocker.mock.calls.find((call) => call[0][0] === "create");
      expect(createCall).toBeDefined();
      expect(createCall![0]).toContain("--label");
      expect(createCall![0]).toContain("openclaw.runtime=runsc");
    });

    it("applies resource limit flags from config", async () => {
      mockDockerContainerState.mockResolvedValue({
        exists: false,
        running: false,
      });
      mockExecDocker.mockResolvedValue({
        stdout: "container-id",
        stderr: "",
        code: 0,
      });

      const params = makeSandboxParams();
      params.cfg.resourceLimits = { cpus: 2, memoryMB: 1024, pidsLimit: 512 };

      await provider.ensureSandbox(params);

      const createCall = mockExecDocker.mock.calls.find((call) => call[0][0] === "create");
      expect(createCall).toBeDefined();
      expect(createCall![0]).toContain("--cpus=2");
      expect(createCall![0]).toContain("--memory=1024m");
      expect(createCall![0]).toContain("--pids-limit=512");
    });

    it("applies default resource limits when not specified in config", async () => {
      mockDockerContainerState.mockResolvedValue({
        exists: false,
        running: false,
      });
      mockExecDocker.mockResolvedValue({
        stdout: "container-id",
        stderr: "",
        code: 0,
      });

      await provider.ensureSandbox(makeSandboxParams());

      const createCall = mockExecDocker.mock.calls.find((call) => call[0][0] === "create");
      expect(createCall).toBeDefined();
      // DEFAULT_RESOURCE_LIMITS: cpus=1, memory=512m, pidsLimit=256
      expect(createCall![0]).toContain("--cpus=1");
      expect(createCall![0]).toContain("--memory=512m");
      expect(createCall![0]).toContain("--pids-limit=256");
    });

    it("applies network mode flag from config", async () => {
      mockDockerContainerState.mockResolvedValue({
        exists: false,
        running: false,
      });
      mockExecDocker.mockResolvedValue({
        stdout: "container-id",
        stderr: "",
        code: 0,
      });

      const params = makeSandboxParams();
      params.cfg.networkMode = "none";

      await provider.ensureSandbox(params);

      const createCall = mockExecDocker.mock.calls.find((call) => call[0][0] === "create");
      expect(createCall).toBeDefined();
      expect(createCall![0]).toContain("--network=none");
    });

    it("applies default network mode when not specified in config", async () => {
      mockDockerContainerState.mockResolvedValue({
        exists: false,
        running: false,
      });
      mockExecDocker.mockResolvedValue({
        stdout: "container-id",
        stderr: "",
        code: 0,
      });

      await provider.ensureSandbox(makeSandboxParams());

      const createCall = mockExecDocker.mock.calls.find((call) => call[0][0] === "create");
      expect(createCall).toBeDefined();
      // DEFAULT_NETWORK_MODE is "bridge"
      expect(createCall![0]).toContain("--network=bridge");
    });

    it("filters secrets from environment variables before container creation", async () => {
      mockDockerContainerState.mockResolvedValue({
        exists: false,
        running: false,
      });
      mockExecDocker.mockResolvedValue({
        stdout: "container-id",
        stderr: "",
        code: 0,
      });

      const params = makeSandboxParams();
      // Add env vars including secrets to the config
      params.cfg.env = {
        OPENAI_API_KEY: "sk-secret-key", // pragma: allowlist secret
        NODE_ENV: "production",
        PATH: "/usr/bin",
        DB_PASSWORD: "secret123", // pragma: allowlist secret
      };

      await provider.ensureSandbox(params);

      const createCall = mockExecDocker.mock.calls.find((call) => call[0][0] === "create");
      expect(createCall).toBeDefined();
      const createArgs = createCall![0];

      // Secrets must NOT appear in docker create args
      const argsStr = createArgs.join(" ");
      expect(argsStr).not.toContain("OPENAI_API_KEY");
      expect(argsStr).not.toContain("sk-secret-key");
      expect(argsStr).not.toContain("DB_PASSWORD");
      expect(argsStr).not.toContain("secret123");

      // Non-secret vars SHOULD appear
      expect(argsStr).toContain("NODE_ENV=production");
      expect(argsStr).toContain("PATH=/usr/bin");
    });

    it("returns existing container name when container is already running", async () => {
      mockDockerContainerState.mockResolvedValue({
        exists: true,
        running: true,
      });

      const result = await provider.ensureSandbox(makeSandboxParams());

      expect(result).toContain("sess-abc");
      // Should NOT call execDocker to create
      expect(mockExecDocker).not.toHaveBeenCalled();
    });

    it("starts existing stopped container", async () => {
      mockDockerContainerState.mockResolvedValue({
        exists: true,
        running: false,
      });
      mockExecDocker.mockResolvedValue({
        stdout: "",
        stderr: "",
        code: 0,
      });

      const result = await provider.ensureSandbox(makeSandboxParams());

      expect(result).toContain("sess-abc");
      // Should call start but not create
      const startCall = mockExecDocker.mock.calls.find((call) => call[0][0] === "start");
      expect(startCall).toBeDefined();
    });
  });

  describe("exec (GVIS-03)", () => {
    it("delegates to execDockerRaw with args and options", async () => {
      const stdout = Buffer.from("output");
      const stderr = Buffer.from("");
      mockExecDockerRaw.mockResolvedValue({ stdout, stderr, code: 0 });

      const result = await provider.exec("container-1", ["ls", "-la"], {
        timeout: 5000,
      });

      expect(result).toEqual({ stdout, stderr, code: 0 });
      expect(mockExecDockerRaw).toHaveBeenCalledWith(["ls", "-la"], {
        timeout: 5000,
      });
    });

    it("returns ExecResult with stdout Buffer, stderr Buffer, code number", async () => {
      const stdout = Buffer.from("hello");
      const stderr = Buffer.from("warning");
      mockExecDockerRaw.mockResolvedValue({ stdout, stderr, code: 1 });

      const result = await provider.exec("container-1", ["cat", "file.txt"]);

      expect(result.stdout).toBeInstanceOf(Buffer);
      expect(result.stderr).toBeInstanceOf(Buffer);
      expect(typeof result.code).toBe("number");
    });
  });

  describe("destroy", () => {
    it("calls execDocker with rm -f when force=true", async () => {
      mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });

      await provider.destroy("container-1", { force: true });

      expect(mockExecDocker).toHaveBeenCalledWith(["rm", "-f", "container-1"]);
    });

    it("calls execDocker with rm (no -f) when force is not set", async () => {
      mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });

      await provider.destroy("container-1");

      expect(mockExecDocker).toHaveBeenCalledWith(["rm", "container-1"]);
    });

    it("calls execDocker with rm (no -f) when force=false", async () => {
      mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });

      await provider.destroy("container-1", { force: false });

      expect(mockExecDocker).toHaveBeenCalledWith(["rm", "container-1"]);
    });
  });

  describe("status", () => {
    it("delegates to dockerContainerState", async () => {
      mockDockerContainerState.mockResolvedValue({
        exists: true,
        running: true,
      });

      const result = await provider.status("container-1");

      expect(result).toEqual({ exists: true, running: true });
      expect(mockDockerContainerState).toHaveBeenCalledWith("container-1");
    });
  });

  describe("syncToSandbox", () => {
    it("delegates to filesystem syncToSandbox via docker cp", async () => {
      mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });

      await provider.syncToSandbox("container-1", "/host/path", "/container/path");

      expect(mockExecDocker).toHaveBeenCalledWith([
        "cp",
        "/host/path",
        "container-1:/container/path",
      ]);
    });
  });

  describe("syncFromSandbox", () => {
    it("delegates to filesystem syncFromSandbox via docker cp", async () => {
      mockExecDocker.mockResolvedValue({ stdout: "", stderr: "", code: 0 });

      await provider.syncFromSandbox("container-1", "/container/path", "/host/path");

      expect(mockExecDocker).toHaveBeenCalledWith([
        "cp",
        "container-1:/container/path",
        "/host/path",
      ]);
    });
  });

  describe("list", () => {
    it("delegates to listSandboxContainers and maps to SandboxInfo", async () => {
      mockListSandboxContainers.mockResolvedValue([
        {
          containerName: "sandbox-1",
          sessionKey: "sess-1",
          running: true,
          imageMatch: true,
          image: "node:20",
          createdAtMs: 0,
          lastUsedAtMs: 0,
        },
        {
          containerName: "sandbox-2",
          sessionKey: "sess-2",
          running: false,
          imageMatch: false,
          image: "node:18",
          createdAtMs: 0,
          lastUsedAtMs: 0,
        },
      ]);

      const result = await provider.list();

      expect(result).toEqual([
        {
          containerName: "sandbox-1",
          sessionKey: "sess-1",
          running: true,
          image: "node:20",
        },
        {
          containerName: "sandbox-2",
          sessionKey: "sess-2",
          running: false,
          image: "node:18",
        },
      ]);
      expect(mockListSandboxContainers).toHaveBeenCalled();
    });
  });

  describe("IBrowserCapable", () => {
    it("isBrowserCapable() returns true", () => {
      expect(isBrowserCapable(provider)).toBe(true);
    });

    it("launchBrowser delegates to ExecBrowserHelper", async () => {
      const { ExecBrowserHelper } = await import("../browser/exec-browser.js");
      const mockLaunch = vi.fn().mockResolvedValue({ sessionId: "exec-123" });
      vi.spyOn(ExecBrowserHelper.prototype, "launchBrowser").mockImplementation(mockLaunch);

      const result = await provider.launchBrowser("container-1", { enabled: true } as unknown);

      expect(result).toEqual({ sessionId: "exec-123" });
      expect(mockLaunch).toHaveBeenCalledWith("container-1", { enabled: true });
    });

    it("navigateBrowser delegates to ExecBrowserHelper", async () => {
      const { ExecBrowserHelper } = await import("../browser/exec-browser.js");
      const mockNav = vi.fn().mockResolvedValue({ url: "https://example.com", title: "Example" });
      vi.spyOn(ExecBrowserHelper.prototype, "navigateBrowser").mockImplementation(mockNav);

      const result = await provider.navigateBrowser(
        "container-1",
        "sess-1",
        "https://example.com",
        5000,
      );

      expect(result).toEqual({ url: "https://example.com", title: "Example" });
      expect(mockNav).toHaveBeenCalledWith("container-1", "sess-1", "https://example.com", 5000);
    });

    it("closeBrowser delegates to ExecBrowserHelper", async () => {
      const { ExecBrowserHelper } = await import("../browser/exec-browser.js");
      const mockClose = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(ExecBrowserHelper.prototype, "closeBrowser").mockImplementation(mockClose);

      await provider.closeBrowser("container-1", "sess-1");

      expect(mockClose).toHaveBeenCalledWith("container-1", "sess-1");
    });

    it("lazy-inits: calling launchBrowser twice creates only one ExecBrowserHelper instance", async () => {
      const { ExecBrowserHelper } = await import("../browser/exec-browser.js");
      const constructorSpy = vi
        .spyOn(ExecBrowserHelper.prototype, "launchBrowser")
        .mockResolvedValue({ sessionId: "exec-1" });

      await provider.launchBrowser("c1");
      await provider.launchBrowser("c2");

      // Access the private browserHelper field to verify single instance
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const helper1 = (provider as unknown as { browserHelper: unknown }).browserHelper;
      expect(helper1).toBeDefined();
      expect(helper1).not.toBeNull();

      constructorSpy.mockRestore();
    });
  });
});

describe("GVisorProvider integration with provider-resolver", () => {
  // Use prototype spies (same approach as provider-resolver.test.ts)
  // to test integration without conflicting with module-level mocks
  const dockerHealthSpy = vi.spyOn(DockerProvider.prototype, "checkHealth");
  const gvisorHealthSpy = vi.spyOn(GVisorProvider.prototype, "checkHealth");

  // Dynamically import resolver to get fresh module with mocks applied
  let resolveProvider: typeof import("../provider-resolver.js").resolveProvider;
  let resetProviderCache: typeof import("../provider-resolver.js").resetProviderCache;

  beforeEach(async () => {
    const resolver = await import("../provider-resolver.js");
    resolveProvider = resolver.resolveProvider;
    resetProviderCache = resolver.resetProviderCache;
    resetProviderCache();
    // Don't clear all mocks here -- just reset the spies we care about
    dockerHealthSpy.mockReset();
    gvisorHealthSpy.mockReset();
  });

  afterEach(() => {
    resetProviderCache();
  });

  it("auto-detection selects GVisorProvider when gVisor is available", async () => {
    // GVisor available, Docker also available
    gvisorHealthSpy.mockResolvedValue({
      available: true,
      message: "gVisor (runsc) runtime available and functional",
      version: "gVisor runsc",
    });
    dockerHealthSpy.mockResolvedValue({
      available: true,
      message: "Docker daemon is running",
      version: "Docker 24.0.7",
    });

    // Mock FirecrackerProvider as unavailable
    const { FirecrackerProvider } = await import("./firecracker-provider.js");
    const fcSpy = vi.spyOn(FirecrackerProvider.prototype, "checkHealth");
    fcSpy.mockResolvedValue({
      available: false,
      message: "Firecracker not implemented",
    });

    const provider = await resolveProvider("auto");

    // gVisor is higher priority than Docker in DETECTION_ORDER
    expect(provider).toBeInstanceOf(GVisorProvider);
    expect(provider.name).toBe("gvisor");

    fcSpy.mockRestore();
  });

  it("explicit 'gvisor' selection returns GVisorProvider when healthy", async () => {
    gvisorHealthSpy.mockResolvedValue({
      available: true,
      message: "gVisor (runsc) runtime available and functional",
      version: "gVisor runsc",
    });

    const provider = await resolveProvider("gvisor");

    expect(provider).toBeInstanceOf(GVisorProvider);
    expect(provider.name).toBe("gvisor");
  });

  it("falls back to DockerProvider when gVisor is unavailable", async () => {
    gvisorHealthSpy.mockResolvedValue({
      available: false,
      message: "gVisor runtime (runsc) not registered",
    });
    dockerHealthSpy.mockResolvedValue({
      available: true,
      message: "Docker daemon is running",
      version: "Docker 24.0.7",
    });

    // Mock FirecrackerProvider as unavailable
    const { FirecrackerProvider } = await import("./firecracker-provider.js");
    const fcSpy = vi.spyOn(FirecrackerProvider.prototype, "checkHealth");
    fcSpy.mockResolvedValue({
      available: false,
      message: "Firecracker not implemented",
    });

    const provider = await resolveProvider("auto");

    expect(provider).toBeInstanceOf(DockerProvider);
    expect(provider.name).toBe("docker");

    fcSpy.mockRestore();
  });

  it("GVisorProvider.exec() returns same shape as DockerProvider.exec() (GVIS-03 API compatibility)", async () => {
    const gvisor = new GVisorProvider();
    const docker = new DockerProvider();

    const mockResult = {
      stdout: Buffer.from("output"),
      stderr: Buffer.from(""),
      code: 0,
    };
    mockExecDockerRaw.mockResolvedValue(mockResult);

    const gvisorResult = await gvisor.exec("c1", ["ls"]);
    const dockerResult = await docker.exec("c2", ["ls"]);

    // Both return identical shape: {stdout: Buffer, stderr: Buffer, code: number}
    expect(gvisorResult.stdout).toBeInstanceOf(Buffer);
    expect(gvisorResult.stderr).toBeInstanceOf(Buffer);
    expect(typeof gvisorResult.code).toBe("number");

    expect(dockerResult.stdout).toBeInstanceOf(Buffer);
    expect(dockerResult.stderr).toBeInstanceOf(Buffer);
    expect(typeof dockerResult.code).toBe("number");

    // Same values since both delegate to execDockerRaw
    expect(gvisorResult).toEqual(dockerResult);
  });
});
