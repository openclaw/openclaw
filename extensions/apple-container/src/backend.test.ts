import type { OpenClawConfig } from "openclaw/plugin-sdk/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAppleContainerPluginConfig } from "./config.js";

const cli = vi.hoisted(() => ({
  assertAppleContainerSystemRunning: vi.fn(async () => undefined),
  inspectAppleContainer: vi.fn(async () => null),
  runAppleContainerCli: vi.fn(async () => ({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
  })),
}));

const sandbox = vi.hoisted(() => ({
  readRegistry: vi.fn(async () => ({ entries: [] })),
  updateRegistry: vi.fn(async () => undefined),
}));

vi.mock("./cli.js", () => cli);
vi.mock("../../../src/agents/sandbox/registry.js", () => sandbox);

describe("apple-container backend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unsupported browser sandboxes during backend creation", async () => {
    const { createAppleContainerSandboxBackendFactory } = await import("./backend.js");
    const factory = createAppleContainerSandboxBackendFactory({
      pluginConfig: resolveAppleContainerPluginConfig({}),
    });

    await expect(
      factory({
        sessionKey: "agent:main:test",
        scopeKey: "agent:main",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/agent",
        cfg: {
          mode: "all",
          backend: "apple-container",
          scope: "agent",
          workspaceAccess: "ro",
          workspaceRoot: "/tmp",
          docker: {
            image: "alpine:latest",
            containerPrefix: "openclaw-sbx-",
            workdir: "/workspace",
            readOnlyRoot: true,
            tmpfs: ["/tmp"],
            network: "bridge",
            user: "1000:1000",
            capDrop: ["ALL"],
            env: { LANG: "C.UTF-8" },
            binds: undefined,
          },
          ssh: {
            command: "ssh",
            workspaceRoot: "/tmp/openclaw-sandboxes",
            strictHostKeyChecking: true,
            updateHostKeys: true,
          },
          browser: {
            enabled: true,
            image: "browser",
            containerPrefix: "browser-",
            network: "openclaw-sandbox-browser",
            cdpPort: 9222,
            vncPort: 5900,
            noVncPort: 6080,
            headless: false,
            enableNoVnc: true,
            allowHostControl: false,
            autoStart: true,
            autoStartTimeoutMs: 1,
          },
          tools: { allow: [], deny: [] },
          prune: { idleHours: 24, maxAgeDays: 7 },
        },
      }),
    ).rejects.toThrow("does not support browser sandboxes");
  });

  it("builds exec argv with apple-container exec flags", async () => {
    const { createAppleContainerSandboxBackendFactory } = await import("./backend.js");
    cli.inspectAppleContainer.mockResolvedValue({
      status: "running",
      configuration: {
        id: "openclaw-sbx-agent-main",
        image: { reference: "alpine:latest" },
        labels: { "openclaw.configHash": "hash-a" },
      },
    });
    const factory = createAppleContainerSandboxBackendFactory({
      pluginConfig: resolveAppleContainerPluginConfig({ command: "container" }),
    });
    const backend = await factory({
      sessionKey: "agent:main:test",
      scopeKey: "agent:main",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent",
      cfg: {
        mode: "all",
        backend: "apple-container",
        scope: "agent",
        workspaceAccess: "ro",
        workspaceRoot: "/tmp",
        docker: {
          image: "alpine:latest",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp"],
          network: "bridge",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          binds: undefined,
        },
        ssh: {
          command: "ssh",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          strictHostKeyChecking: true,
          updateHostKeys: true,
        },
        browser: {
          enabled: false,
          image: "browser",
          containerPrefix: "browser-",
          network: "openclaw-sandbox-browser",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          enableNoVnc: true,
          allowHostControl: false,
          autoStart: true,
          autoStartTimeoutMs: 1,
        },
        tools: { allow: [], deny: [] },
        prune: { idleHours: 24, maxAgeDays: 7 },
      },
    });

    const spec = await backend.buildExecSpec({
      command: "echo hi",
      workdir: "/workspace",
      env: { TEST: "1", PATH: "/custom/bin" },
      usePty: true,
    });

    expect(spec.argv[0]).toBe("container");
    expect(spec.argv).toContain("exec");
    expect(spec.argv).toContain("--workdir");
    expect(spec.argv).toContain("/workspace");
    expect(spec.argv).toContain("--env");
    expect(spec.argv).toContain("TEST=1");
    expect(spec.argv).toContain("-t");
  });

  it('passes sandbox.docker.network="none" through to the Apple container CLI', async () => {
    const { createAppleContainerSandboxBackendFactory } = await import("./backend.js");
    cli.inspectAppleContainer.mockResolvedValue(null);
    const factory = createAppleContainerSandboxBackendFactory({
      pluginConfig: resolveAppleContainerPluginConfig({ command: "container" }),
    });

    await factory({
      sessionKey: "agent:main:test",
      scopeKey: "agent:main",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent",
      cfg: {
        mode: "all",
        backend: "apple-container",
        scope: "agent",
        workspaceAccess: "ro",
        workspaceRoot: "/tmp",
        docker: {
          image: "alpine:latest",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          binds: undefined,
        },
        ssh: {
          command: "ssh",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          strictHostKeyChecking: true,
          updateHostKeys: true,
        },
        browser: {
          enabled: false,
          image: "browser",
          containerPrefix: "browser-",
          network: "openclaw-sandbox-browser",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          enableNoVnc: true,
          allowHostControl: false,
          autoStart: true,
          autoStartTimeoutMs: 1,
        },
        tools: { allow: [], deny: [] },
        prune: { idleHours: 24, maxAgeDays: 7 },
      },
    });

    const createCall = cli.runAppleContainerCli.mock.calls.find(
      ([call]) => Array.isArray(call.args) && call.args[0] === "create",
    );
    expect(createCall).toBeDefined();
    expect(createCall?.[0].args).toContain("--network");
    expect(createCall?.[0].args).toContain("none");

    const imageInspectCall = cli.runAppleContainerCli.mock.calls.find(
      ([call]) =>
        Array.isArray(call.args) && call.args[0] === "image" && call.args[1] === "inspect",
    );
    expect(imageInspectCall).toBeUndefined();
  });

  it("describes and removes runtimes through inspect and delete", async () => {
    const { createAppleContainerSandboxBackendManager } = await import("./backend.js");
    cli.inspectAppleContainer.mockResolvedValue({
      status: "running",
      configuration: {
        id: "openclaw-sbx-agent-main",
        image: { reference: "alpine:latest" },
      },
    });
    const manager = createAppleContainerSandboxBackendManager({
      pluginConfig: resolveAppleContainerPluginConfig({}),
    });

    const config = {
      agents: {
        defaults: {
          sandbox: {
            backend: "apple-container",
            docker: { image: "alpine:latest", network: "bridge" },
          },
        },
      },
    } as OpenClawConfig;

    const runtime = await manager.describeRuntime({
      entry: {
        containerName: "openclaw-sbx-agent-main",
        backendId: "apple-container",
        runtimeLabel: "openclaw-sbx-agent-main",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "old:tag",
      },
      config,
      agentId: "main",
    });

    expect(runtime.running).toBe(true);
    expect(runtime.actualConfigLabel).toBe("alpine:latest");
    expect(runtime.configLabelMatch).toBe(true);

    await manager.removeRuntime({
      entry: {
        containerName: "openclaw-sbx-agent-main",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "alpine:latest",
      },
      config,
    });

    expect(cli.runAppleContainerCli).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["delete", "--force", "openclaw-sbx-agent-main"],
      }),
    );
  });
});
