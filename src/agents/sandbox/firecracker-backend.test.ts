import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FIRECRACKER_OCI_RUNTIME } from "../../teammate/profile.js";

const createDockerSandboxBackend = vi.hoisted(() => vi.fn(async () => ({ id: "fc" })));

vi.mock("./docker-backend.js", () => ({
  createDockerSandboxBackend,
  dockerSandboxBackendManager: { describeRuntime: vi.fn(), removeRuntime: vi.fn() },
}));

describe("firecracker sandbox backend", () => {
  beforeEach(() => {
    createDockerSandboxBackend.mockClear();
  });

  it("reuses docker volumes and injects an explicit Kata/Firecracker runtime", async () => {
    const { createFirecrackerSandboxBackend } = await import("./firecracker-backend.js");
    await createFirecrackerSandboxBackend({
      sessionKey: "agent:main:main",
      scopeKey: "shared",
      workspaceDir: "/tmp/ws",
      agentWorkspaceDir: "/tmp/agent",
      cfg: {
        mode: "all",
        backend: "firecracker",
        scope: "shared",
        workspaceAccess: "rw",
        workspaceRoot: "/home/bot",
        docker: {
          image: "openclaw-sandbox:local",
          containerPrefix: "openclaw-sbx-",
          workdir: "/home/bot",
          readOnlyRoot: true,
          tmpfs: ["/tmp"],
          network: "none",
          capDrop: ["ALL"],
        },
        ssh: {
          command: "ssh",
          workspaceRoot: "/tmp",
          strictHostKeyChecking: true,
          updateHostKeys: false,
        },
        browser: {
          enabled: false,
          image: "x",
          containerPrefix: "b",
          network: "openclaw-sandbox-browser",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: true,
          noVncEnabled: true,
          allowHostControl: false,
          autoStart: false,
          autoStartTimeoutMs: 1,
        },
        prune: { idleHours: 1, maxAgeDays: 7 },
      },
    });
    expect(createDockerSandboxBackend).toHaveBeenCalledOnce();
    const params = createDockerSandboxBackend.mock.calls[0]?.[0] as {
      cfg: { docker: { runtime?: string; workdir: string } };
    };
    expect(params.cfg.docker.runtime).toBe(DEFAULT_FIRECRACKER_OCI_RUNTIME);
    expect(params.cfg.docker.workdir).toBe("/home/bot");
  });
});
