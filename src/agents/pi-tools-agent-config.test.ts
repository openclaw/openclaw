import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import type { SandboxDockerConfig } from "./sandbox.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { createRestrictedAgentSandboxConfig } from "./test-helpers/sandbox-agent-config-fixtures.js";

type ToolWithExecute = {
  execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
};

describe("Agent-specific tool filtering", () => {
  const sandboxFsBridgeStub: SandboxFsBridge = {
    resolvePath: () => ({
      hostPath: "/tmp/sandbox",
      relativePath: "",
      containerPath: "/workspace",
    }),
    readFile: async () => Buffer.from(""),
    writeFile: async () => {},
    mkdirp: async () => {},
    remove: async () => {},
    rename: async () => {},
    stat: async () => null,
  };

  async function withApplyPatchEscapeCase(
    opts: { workspaceOnly?: boolean },
    run: (params: {
      applyPatchTool: ToolWithExecute;
      escapedPath: string;
      patch: string;
    }) => Promise<void>,
  ) {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-tools-"));
    const escapedPath = path.join(
      path.dirname(workspaceDir),
      `escaped-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
    );
    const relativeEscape = path.relative(workspaceDir, escapedPath);

    try {
      const cfg: OpenClawConfig = {
        tools: {
          allow: ["read", "exec"],
          exec: {
            applyPatch: {
              enabled: true,
              ...(opts.workspaceOnly === false ? { workspaceOnly: false } : {}),
            },
          },
        },
      };

      const tools = createOpenClawCodingTools({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
        agentDir: "/tmp/agent",
        modelProvider: "openai",
        modelId: "gpt-5.2",
      });

      const applyPatchTool = tools.find((t) => t.name === "apply_patch");
      if (!applyPatchTool) {
        throw new Error("apply_patch tool missing");
      }

      const patch = `*** Begin Patch
*** Add File: ${relativeEscape}
+escaped
*** End Patch`;

      await run({
        applyPatchTool: applyPatchTool as unknown as ToolWithExecute,
        escapedPath,
        patch,
      });
    } finally {
      await fs.rm(escapedPath, { force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  }

  function createMainSessionTools(cfg: OpenClawConfig) {
    return createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
    });
  }

  function createMainAgentConfig(params: {
    tools: NonNullable<OpenClawConfig["tools"]>;
    agentTools?: NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number]["tools"];
  }): OpenClawConfig {
    return {
      tools: params.tools,
      agents: {
        list: [
          {
            id: "main",
            workspace: "~/openclaw",
            ...(params.agentTools ? { tools: params.agentTools } : {}),
          },
        ],
      },
    };
  }

  function createExecHostDefaultsConfig(
    agents: Array<{ id: string; execHost?: "gateway" | "sandbox" }>,
  ): OpenClawConfig {
    return {
      tools: {
        exec: {
          host: "sandbox",
          security: "full",
          ask: "off",
        },
      },
      agents: {
        list: agents.map((agent) => ({
          id: agent.id,
          ...(agent.execHost
            ? {
                tools: {
                  exec: {
                    host: agent.execHost,
                  },
                },
              }
            : {}),
        })),
      },
    };
  }

  it("should apply global tool policy when no agent-specific policy exists", () => {
    const cfg = createMainAgentConfig({
      tools: {
        allow: ["read", "write"],
        deny: ["bash"],
      },
    });
    const tools = createMainSessionTools(cfg);

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("apply_patch");
  });

  it("should keep global tool policy when agent only sets tools.elevated", () => {
    const cfg = createMainAgentConfig({
      tools: {
        deny: ["write"],
      },
      agentTools: {
        elevated: {
          enabled: true,
          allowFrom: { whatsapp: ["+15555550123"] },
        },
      },
    });
    const tools = createMainSessionTools(cfg);

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("exec");
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("apply_patch");
  });

  it("should allow apply_patch when exec is allow-listed and applyPatch is enabled", () => {
    const cfg: OpenClawConfig = {
      tools: {
        allow: ["read", "exec"],
        exec: {
          applyPatch: { enabled: true },
        },
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
      modelProvider: "openai",
      modelId: "gpt-5.2",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("exec");
    expect(toolNames).toContain("apply_patch");
  });

  it("defaults apply_patch to workspace-only (blocks traversal)", async () => {
    await withApplyPatchEscapeCase({}, async ({ applyPatchTool, escapedPath, patch }) => {
      await expect(applyPatchTool.execute("tc1", { input: patch })).rejects.toThrow(
        /Path escapes sandbox root/,
      );
      await expect(fs.readFile(escapedPath, "utf8")).rejects.toBeDefined();
    });
  });

  it("allows disabling apply_patch workspace-only via config (dangerous)", async () => {
    await withApplyPatchEscapeCase(
      { workspaceOnly: false },
      async ({ applyPatchTool, escapedPath, patch }) => {
        await applyPatchTool.execute("tc2", { input: patch });
        const contents = await fs.readFile(escapedPath, "utf8");
        expect(contents).toBe("escaped\n");
      },
    );
  });

  it("should apply agent-specific tool policy", () => {
    const cfg: OpenClawConfig = {
      tools: {
        allow: ["read", "write", "exec"],
        deny: [],
      },
      agents: {
        list: [
          {
            id: "restricted",
            workspace: "~/openclaw-restricted",
            tools: {
              allow: ["read"], // Agent override: only read
              deny: ["exec", "write", "edit"],
            },
          },
        ],
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:restricted:main",
      workspaceDir: "/tmp/test-restricted",
      agentDir: "/tmp/agent-restricted",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("apply_patch");
    expect(toolNames).not.toContain("edit");
  });

  it("should apply provider-specific tool policy", () => {
    const cfg: OpenClawConfig = {
      tools: {
        allow: ["read", "write", "exec"],
        byProvider: {
          "google-antigravity": {
            allow: ["read"],
          },
        },
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-provider",
      agentDir: "/tmp/agent-provider",
      modelProvider: "google-antigravity",
      modelId: "claude-opus-4-6-thinking",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("apply_patch");
  });

  it("should apply provider-specific tool profile overrides", () => {
    const cfg: OpenClawConfig = {
      tools: {
        profile: "coding",
        byProvider: {
          "google-antigravity": {
            profile: "minimal",
          },
        },
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-provider-profile",
      agentDir: "/tmp/agent-provider-profile",
      modelProvider: "google-antigravity",
      modelId: "claude-opus-4-6-thinking",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toEqual(["session_status"]);
  });

  it("should allow different tool policies for different agents", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            workspace: "~/openclaw",
            // No tools restriction - all tools available
          },
          {
            id: "family",
            workspace: "~/openclaw-family",
            tools: {
              allow: ["read"],
              deny: ["exec", "write", "edit", "process"],
            },
          },
        ],
      },
    };

    // main agent: all tools
    const mainTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main",
      agentDir: "/tmp/agent-main",
    });
    const mainToolNames = mainTools.map((t) => t.name);
    expect(mainToolNames).toContain("exec");
    expect(mainToolNames).toContain("write");
    expect(mainToolNames).toContain("edit");
    expect(mainToolNames).not.toContain("apply_patch");

    // family agent: restricted
    const familyTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:family:whatsapp:group:123",
      workspaceDir: "/tmp/test-family",
      agentDir: "/tmp/agent-family",
    });
    const familyToolNames = familyTools.map((t) => t.name);
    expect(familyToolNames).toContain("read");
    expect(familyToolNames).not.toContain("exec");
    expect(familyToolNames).not.toContain("write");
    expect(familyToolNames).not.toContain("edit");
    expect(familyToolNames).not.toContain("apply_patch");
  });

  it("should apply group tool policy overrides (group-specific beats wildcard)", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          groups: {
            "*": {
              tools: { allow: ["read"] },
            },
            trusted: {
              tools: { allow: ["read", "exec"] },
            },
          },
        },
      },
    };

    const trustedTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:whatsapp:group:trusted",
      messageProvider: "whatsapp",
      workspaceDir: "/tmp/test-group-trusted",
      agentDir: "/tmp/agent-group",
    });
    const trustedNames = trustedTools.map((t) => t.name);
    expect(trustedNames).toContain("read");
    expect(trustedNames).toContain("exec");

    const defaultTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:whatsapp:group:unknown",
      messageProvider: "whatsapp",
      workspaceDir: "/tmp/test-group-default",
      agentDir: "/tmp/agent-group",
    });
    const defaultNames = defaultTools.map((t) => t.name);
    expect(defaultNames).toContain("read");
    expect(defaultNames).not.toContain("exec");
  });

  it("should apply per-sender tool policies for group tools", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          groups: {
            "*": {
              tools: { allow: ["read"] },
              toolsBySender: {
                "id:alice": { allow: ["read", "exec"] },
              },
            },
          },
        },
      },
    };

    const aliceTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:whatsapp:group:family",
      senderId: "alice",
      workspaceDir: "/tmp/test-group-sender",
      agentDir: "/tmp/agent-group-sender",
    });
    const aliceNames = aliceTools.map((t) => t.name);
    expect(aliceNames).toContain("read");
    expect(aliceNames).toContain("exec");

    const bobTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:whatsapp:group:family",
      senderId: "bob",
      workspaceDir: "/tmp/test-group-sender-bob",
      agentDir: "/tmp/agent-group-sender",
    });
    const bobNames = bobTools.map((t) => t.name);
    expect(bobNames).toContain("read");
    expect(bobNames).not.toContain("exec");
  });

  it("should not let default sender policy override group tools", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          groups: {
            "*": {
              toolsBySender: {
                "id:admin": { allow: ["read", "exec"] },
              },
            },
            locked: {
              tools: { allow: ["read"] },
            },
          },
        },
      },
    };

    const adminTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:whatsapp:group:locked",
      senderId: "admin",
      workspaceDir: "/tmp/test-group-default-override",
      agentDir: "/tmp/agent-group-default-override",
    });
    const adminNames = adminTools.map((t) => t.name);
    expect(adminNames).toContain("read");
    expect(adminNames).not.toContain("exec");
  });

  it("should resolve telegram group tool policy for topic session keys", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          groups: {
            "123": {
              tools: { allow: ["read"] },
            },
          },
        },
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:telegram:group:123:topic:456",
      messageProvider: "telegram",
      workspaceDir: "/tmp/test-telegram-topic",
      agentDir: "/tmp/agent-telegram",
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).not.toContain("exec");
  });

  it("should inherit group tool policy for subagents from spawnedBy session keys", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          groups: {
            trusted: {
              tools: { allow: ["read"] },
            },
          },
        },
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:subagent:test",
      spawnedBy: "agent:main:whatsapp:group:trusted",
      workspaceDir: "/tmp/test-subagent-group",
      agentDir: "/tmp/agent-subagent",
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).not.toContain("exec");
  });

  it("should apply global tool policy before agent-specific policy", () => {
    const cfg: OpenClawConfig = {
      tools: {
        deny: ["browser"], // Global deny
      },
      agents: {
        list: [
          {
            id: "work",
            workspace: "~/openclaw-work",
            tools: {
              deny: ["exec", "process"], // Agent deny (override)
            },
          },
        ],
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:work:slack:dm:user123",
      workspaceDir: "/tmp/test-work",
      agentDir: "/tmp/agent-work",
    });

    const toolNames = tools.map((t) => t.name);
    // Global policy still applies; agent policy further restricts
    expect(toolNames).not.toContain("browser");
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("process");
    expect(toolNames).not.toContain("apply_patch");
  });

  it("should work with sandbox tools filtering", () => {
    const cfg = createRestrictedAgentSandboxConfig({
      agentTools: {
        allow: ["read"], // Agent further restricts to only read
        deny: ["exec", "write"],
      },
      globalSandboxTools: {
        allow: ["read", "write", "exec"], // Sandbox allows these
        deny: [],
      },
    });

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:restricted:main",
      workspaceDir: "/tmp/test-restricted",
      agentDir: "/tmp/agent-restricted",
      sandbox: {
        enabled: true,
        sessionKey: "agent:restricted:main",
        workspaceDir: "/tmp/sandbox",
        agentWorkspaceDir: "/tmp/test-restricted",
        workspaceAccess: "none",
        containerName: "test-container",
        containerWorkdir: "/workspace",
        docker: {
          image: "test-image",
          containerPrefix: "test-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: [],
          network: "none",
          capDrop: [],
        } satisfies SandboxDockerConfig,
        tools: {
          allow: ["read", "write", "exec"],
          deny: [],
        },
        fsBridge: sandboxFsBridgeStub,
        browserAllowHostControl: false,
      },
    });

    const toolNames = tools.map((t) => t.name);
    // Agent policy should be applied first, then sandbox
    // Agent allows only "read", sandbox allows ["read", "write", "exec"]
    // Result: only "read" (most restrictive wins)
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("write");
  });

  it("should run exec synchronously when process is denied", async () => {
    const cfg: OpenClawConfig = {
      tools: {
        deny: ["process"],
        exec: {
          security: "full",
          ask: "off",
        },
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main",
      agentDir: "/tmp/agent-main",
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    const result = await execTool?.execute("call1", {
      command: "echo done",
      yieldMs: 10,
    });

    const resultDetails = result?.details as { status?: string } | undefined;
    expect(resultDetails?.status).toBe("completed");
  });

  it("keeps sandbox as the implicit exec host default without forcing gateway approvals", async () => {
    const tools = createOpenClawCodingTools({
      config: {},
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-implicit-sandbox",
      agentDir: "/tmp/agent-main-implicit-sandbox",
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    const result = await execTool!.execute("call-implicit-sandbox-default", {
      command: "echo done",
    });
    const details = result?.details as { status?: string } | undefined;
    expect(details?.status).toBe("completed");

    await expect(
      execTool!.execute("call-implicit-sandbox-gateway", {
        command: "echo done",
        host: "gateway",
      }),
    ).rejects.toThrow("exec host not allowed");
  });

  it("fails closed when exec host=sandbox is requested without sandbox runtime", async () => {
    const tools = createOpenClawCodingTools({
      config: {},
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-fail-closed",
      agentDir: "/tmp/agent-main-fail-closed",
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();
    await expect(
      execTool!.execute("call-fail-closed", {
        command: "echo done",
        host: "sandbox",
      }),
    ).rejects.toThrow("exec host=sandbox is configured");
  });

  it("should apply agent-specific exec host defaults over global defaults", async () => {
    const cfg = createExecHostDefaultsConfig([
      { id: "main", execHost: "gateway" },
      { id: "helper" },
    ]);

    const mainTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main-exec-defaults",
      agentDir: "/tmp/agent-main-exec-defaults",
    });
    const mainExecTool = mainTools.find((tool) => tool.name === "exec");
    expect(mainExecTool).toBeDefined();
    const mainResult = await mainExecTool!.execute("call-main-default", {
      command: "echo done",
      yieldMs: 1000,
    });
    const mainDetails = mainResult?.details as { status?: string } | undefined;
    expect(mainDetails?.status).toBe("completed");
    await expect(
      mainExecTool!.execute("call-main", {
        command: "echo done",
        host: "sandbox",
      }),
    ).rejects.toThrow("exec host not allowed");

    const helperTools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:helper:main",
      workspaceDir: "/tmp/test-helper-exec-defaults",
      agentDir: "/tmp/agent-helper-exec-defaults",
    });
    const helperExecTool = helperTools.find((tool) => tool.name === "exec");
    expect(helperExecTool).toBeDefined();
    await expect(
      helperExecTool!.execute("call-helper-default", {
        command: "echo done",
        yieldMs: 1000,
      }),
    ).rejects.toThrow("exec host=sandbox is configured");
    await expect(
      helperExecTool!.execute("call-helper", {
        command: "echo done",
        host: "sandbox",
        yieldMs: 1000,
      }),
    ).rejects.toThrow("exec host=sandbox is configured");
  });

  it("applies explicit agentId exec defaults when sessionKey is opaque", async () => {
    const cfg = createExecHostDefaultsConfig([{ id: "main", execHost: "gateway" }]);

    const tools = createOpenClawCodingTools({
      config: cfg,
      agentId: "main",
      sessionKey: "run-opaque-123",
      workspaceDir: "/tmp/test-main-opaque-session",
      agentDir: "/tmp/agent-main-opaque-session",
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();
    const result = await execTool!.execute("call-main-opaque-session", {
      command: "echo done",
      yieldMs: 1000,
    });
    const details = result?.details as { status?: string } | undefined;
    expect(details?.status).toBe("completed");
  });
});
