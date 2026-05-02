import { afterEach, describe, expect, it } from "vitest";
import { buildOpenShellSshExecEnv, createOpenShellSandboxBackendFactory } from "./backend.js";
import { resolveOpenShellPluginConfig } from "./config.js";

describe("openshell backend env", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("filters blocked secrets from ssh exec env", () => {
    process.env.OPENAI_API_KEY = "sk-test-secret";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-secret";
    process.env.LANG = "en_US.UTF-8";
    process.env.NODE_ENV = "test";

    const env = buildOpenShellSshExecEnv();

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.NODE_ENV).toBe("test");
  });
});

describe("openshell sandbox backend", () => {
  it("rejects docker volumes because openshell does not mount them", async () => {
    const factory = createOpenShellSandboxBackendFactory({
      pluginConfig: resolveOpenShellPluginConfig(undefined),
    });

    await expect(
      factory({
        sessionKey: "agent:worker:task",
        scopeKey: "agent:worker",
        workspaceDir: "/tmp/workspace",
        agentWorkspaceDir: "/tmp/agent",
        cfg: {
          mode: "all",
          backend: "openshell",
          scope: "session",
          workspaceAccess: "rw",
          workspaceRoot: "~/.openclaw/sandboxes",
          docker: {
            image: "img",
            containerPrefix: "prefix-",
            workdir: "/workspace",
            readOnlyRoot: true,
            tmpfs: ["/tmp"],
            network: "none",
            capDrop: ["ALL"],
            env: {},
            volumes: [{ strategy: "named", source: "cache", target: "/cache" }],
          },
          ssh: {
            command: "ssh",
            workspaceRoot: "/remote/openclaw",
            strictHostKeyChecking: true,
            updateHostKeys: true,
          },
          browser: {
            enabled: false,
            image: "img",
            containerPrefix: "prefix-",
            network: "bridge",
            cdpPort: 9222,
            vncPort: 5900,
            noVncPort: 6080,
            headless: true,
            enableNoVnc: false,
            allowHostControl: false,
            autoStart: false,
            autoStartTimeoutMs: 1000,
          },
          tools: { allow: [], deny: [] },
          prune: { idleHours: 24, maxAgeDays: 7 },
        },
      }),
    ).rejects.toThrow("does not support sandbox.docker.volumes");
  });
});
