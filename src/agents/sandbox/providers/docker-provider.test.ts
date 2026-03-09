import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ISandboxProvider } from "../provider.js";
import { isBrowserCapable } from "../provider.js";
import { DockerProvider } from "./docker-provider.js";

vi.mock("../docker.js", () => ({
  execDockerRaw: vi.fn(),
  execDocker: vi.fn(),
  dockerContainerState: vi.fn(),
}));

vi.mock("../manage.js", () => ({
  listSandboxContainers: vi.fn(),
}));

import { execDockerRaw, execDocker, dockerContainerState } from "../docker.js";
import { listSandboxContainers } from "../manage.js";

const mockExecDockerRaw = vi.mocked(execDockerRaw);
const mockExecDocker = vi.mocked(execDocker);
const mockDockerContainerState = vi.mocked(dockerContainerState);
const mockListSandboxContainers = vi.mocked(listSandboxContainers);

describe("DockerProvider", () => {
  let provider: DockerProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DockerProvider();
  });

  it("has name 'docker'", () => {
    expect(provider.name).toBe("docker");
  });

  it("implements ISandboxProvider", () => {
    const _check: ISandboxProvider = provider;
    expect(_check).toBeDefined();
  });

  describe("checkHealth", () => {
    it("returns available=true with version when docker info succeeds", async () => {
      mockExecDocker.mockResolvedValue({
        stdout: "24.0.7\n",
        stderr: "",
        code: 0,
      });

      const result = await provider.checkHealth();

      expect(result.available).toBe(true);
      expect(result.message).toBe("Docker daemon is running");
      expect(result.version).toBe("Docker 24.0.7");
      expect(mockExecDocker).toHaveBeenCalledWith(["info", "--format", "{{.ServerVersion}}"], {
        allowFailure: true,
      });
    });

    it("returns available=false when docker info fails with non-zero exit", async () => {
      mockExecDocker.mockResolvedValue({
        stdout: "",
        stderr: "Cannot connect to Docker daemon",
        code: 1,
      });

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
      expect(result.message).toContain("exit code 1");
    });

    it("returns available=false when docker info throws", async () => {
      mockExecDocker.mockRejectedValue(new Error("spawn docker ENOENT"));

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
      expect(result.message).toContain("spawn docker ENOENT");
    });
  });

  describe("ensureSandbox", () => {
    const baseCfg = {
      mode: "all" as const,
      scope: "session" as const,
      workspaceAccess: "rw" as const,
      workspaceRoot: "/workspace",
      docker: { image: "node:20" },
      browser: { enabled: false },
      tools: { allow: ["*"], deny: [] },
      prune: { idleHours: 24, maxAgeDays: 7 },
      backend: "docker" as const,
    } as any;

    const baseParams = {
      sessionKey: "sess-abc",
      workspaceDir: "/workspace",
      agentWorkspaceDir: "/agent",
      cfg: baseCfg,
    };

    beforeEach(() => {
      // Container does not exist by default
      mockDockerContainerState.mockResolvedValue({
        exists: false,
        running: false,
      });
      // Docker create/start succeed
      mockExecDocker.mockResolvedValue({
        stdout: "",
        stderr: "",
        code: 0,
      });
    });

    it("returns container name derived from sessionKey", async () => {
      const result = await provider.ensureSandbox(baseParams);

      expect(result).toBe("openclaw-sandbox-sess-abc");
    });

    it("returns existing container name when container is already running", async () => {
      mockDockerContainerState.mockResolvedValue({
        exists: true,
        running: true,
      });

      const result = await provider.ensureSandbox(baseParams);

      expect(result).toBe("openclaw-sandbox-sess-abc");
      // Should not call create/start when already running
      expect(mockExecDocker).not.toHaveBeenCalled();
    });

    it("includes resource limit flags when cfg.resourceLimits is specified", async () => {
      const params = {
        ...baseParams,
        cfg: {
          ...baseCfg,
          resourceLimits: { cpus: 2, memoryMB: 1024, pidsLimit: 512 },
        },
      };

      await provider.ensureSandbox(params);

      // Find the create call (first execDocker call)
      const createCall = mockExecDocker.mock.calls[0]![0] as string[];
      expect(createCall).toContain("--cpus=2");
      expect(createCall).toContain("--memory=1024m");
      expect(createCall).toContain("--pids-limit=512");
    });

    it("uses DEFAULT_RESOURCE_LIMITS when cfg.resourceLimits is undefined", async () => {
      await provider.ensureSandbox(baseParams);

      const createCall = mockExecDocker.mock.calls[0]![0] as string[];
      expect(createCall).toContain("--cpus=1");
      expect(createCall).toContain("--memory=512m");
      expect(createCall).toContain("--pids-limit=256");
    });

    it("includes network flag when cfg.networkMode is specified", async () => {
      const params = {
        ...baseParams,
        cfg: {
          ...baseCfg,
          networkMode: "none" as const,
        },
      };

      await provider.ensureSandbox(params);

      const createCall = mockExecDocker.mock.calls[0]![0] as string[];
      expect(createCall).toContain("--network=none");
    });

    it("uses DEFAULT_NETWORK_MODE when cfg.networkMode is undefined", async () => {
      await provider.ensureSandbox(baseParams);

      const createCall = mockExecDocker.mock.calls[0]![0] as string[];
      expect(createCall).toContain("--network=bridge");
    });

    it("filters secret env vars and passes safe ones", async () => {
      const params = {
        ...baseParams,
        cfg: {
          ...baseCfg,
          env: {
            PATH: "/usr/bin",
            HOME: "/home/user",
            OPENAI_API_KEY: "sk-secret-123", // pragma: allowlist secret
            MY_CUSTOM_VAR: "hello",
          },
        },
      };

      await provider.ensureSandbox(params);

      const createCall = mockExecDocker.mock.calls[0]![0] as string[];
      // Safe vars should be present
      expect(createCall).toContain("--env");
      const envArgs = createCall.filter(
        (_: string, i: number) => createCall[i - 1] === "--env" || false,
      );
      expect(envArgs).toContain("PATH=/usr/bin");
      expect(envArgs).toContain("HOME=/home/user");
      expect(envArgs).toContain("MY_CUSTOM_VAR=hello");
      // Secret should NOT be present
      expect(envArgs).not.toContain("OPENAI_API_KEY=sk-secret-123");
      expect(createCall.join(" ")).not.toContain("OPENAI_API_KEY");
    });

    it("includes docker image in create args", async () => {
      await provider.ensureSandbox(baseParams);

      const createCall = mockExecDocker.mock.calls[0]![0] as string[];
      expect(createCall).toContain("node:20");
    });

    it("starts the container after creating it", async () => {
      await provider.ensureSandbox(baseParams);

      // Should have two calls: create then start
      expect(mockExecDocker).toHaveBeenCalledTimes(2);
      const startCall = mockExecDocker.mock.calls[1]![0] as string[];
      expect(startCall).toContain("start");
      expect(startCall).toContain("openclaw-sandbox-sess-abc");
    });
  });

  describe("exec", () => {
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

      const result = await provider.launchBrowser("container-1", { enabled: true } as any);

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
      const helper1 = (provider as any).browserHelper;
      expect(helper1).toBeDefined();
      expect(helper1).not.toBeNull();

      constructorSpy.mockRestore();
    });
  });
});
