import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveChannelGroupToolsPolicy } from "../config/group-policy.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveEffectiveToolPolicy } from "./agent-tools.policy.js";
import { expectOwnerGated } from "./agent-tools.turn-authority.test-support.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { SandboxDockerConfig } from "./sandbox/types.docker.js";
import { createRestrictedAgentSandboxConfig } from "./test-helpers/sandbox-agent-config-fixtures.js";

type ToolWithExecute = {
  execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
};

describe("Agent-specific tool filtering", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  const sandboxFsBridgeStub: SandboxFsBridge = {
    resolvePath: () => ({
      hostPath: "/tmp/sandbox",
      relativePath: "",
      containerPath: "/workspace",
    }),
    readFile: async () => Buffer.from(""),
    writeFile: async () => {},
    createFileExclusive: async () => "created",
    mkdirp: async () => {},
    remove: async () => {},
    rename: async () => {},
    stat: async () => null,
  };

  function expectReadOnlyToolSet(toolNames: string[], extraDenied: string[] = []) {
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("apply_patch");
    for (const toolName of extraDenied) {
      expect(toolNames).not.toContain(toolName);
    }
  }

  async function withApplyPatchEscapeCase(
    opts: { workspaceOnly?: boolean },
    run: (params: {
      applyPatchTool: ToolWithExecute;
      escapedPath: string;
      patch: string;
    }) => Promise<void>,
  ) {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-tools-"));
    const escapedPath = path.join(
      path.dirname(workspaceDir),
      `escaped-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
    );
    const relativeEscape = path.relative(workspaceDir, escapedPath);

    try {
      const cfg: OpenClawConfig = {
        tools: {
          allow: ["read", "write", "exec"],
          exec: {
            applyPatch: opts.workspaceOnly === false ? { workspaceOnly: false } : {},
          },
        },
      };

      const tools = createOpenClawCodingTools({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir,
        agentDir: "/tmp/agent",
        modelProvider: "openai",
        modelId: "gpt-5.4",
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

  function createMainSessionTools(
    cfg: OpenClawConfig,
    options: Partial<Parameters<typeof createOpenClawCodingTools>[0]> = {},
  ) {
    return createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
      ...options,
    });
  }

  it("should apply global tool policy when no agent-specific policy exists", () => {
    const tools = createMainSessionTools({
      tools: { allow: ["read", "write"], deny: ["bash"] },
      agents: { entries: { main: { workspace: "~/openclaw" } } },
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).not.toContain("exec");
    expect(toolNames).toContain("apply_patch");
  });

  it("should keep global tool policy when agent only sets tools.elevated", () => {
    const cfg: OpenClawConfig = {
      tools: {
        deny: ["write"],
      },
      agents: {
        entries: {
          main: {
            workspace: "~/openclaw",
            tools: {
              elevated: {
                enabled: true,
                allowFrom: { whatsapp: ["+15555550123"] },
              },
            },
          },
        },
      },
    };
    const tools = createMainSessionTools(cfg);

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("exec");
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("write");
    expect(toolNames).toContain("apply_patch");
  });

  it("uses the configured default agent for lean local-model filtering on legacy session keys", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { local: { experimental: { localModelLean: true } } } },
    };

    const tools = createMainSessionTools(cfg, {
      sessionKey: "main",
      agentDir: "/tmp/agent-local",
      modelProvider: "lmstudio",
      modelId: "gemma-4-e4b-it",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("browser");
    expect(toolNames).not.toContain("automations");
    expect(toolNames).not.toContain("message");
  });

  it("should allow disabling apply_patch explicitly", () => {
    const cfg: OpenClawConfig = {
      tools: {
        allow: ["read", "write", "exec"],
        exec: {
          applyPatch: { enabled: false },
        },
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("exec");
    expect(toolNames).not.toContain("apply_patch");
  });

  it("defaults apply_patch to workspace-only (blocks traversal)", async () => {
    await withApplyPatchEscapeCase({}, async ({ applyPatchTool, escapedPath, patch }) => {
      await expect(applyPatchTool.execute("tc1", { input: patch })).rejects.toThrow(
        /Path escapes sandbox root/,
      );
      await expect(fs.readFile(escapedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
        entries: {
          restricted: {
            workspace: "~/openclaw-restricted",
            tools: {
              allow: ["read"], // Agent override: only read
              deny: ["exec", "write", "edit"],
            },
          },
        },
      },
    };

    const tools = createOpenClawCodingTools({
      config: cfg,
      sessionKey: "agent:restricted:main",
      workspaceDir: "/tmp/test-restricted",
      agentDir: "/tmp/agent-restricted",
    });

    expectReadOnlyToolSet(
      tools.map((t) => t.name),
      ["edit"],
    );
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

    expectReadOnlyToolSet(tools.map((t) => t.name));
  });

  it("should apply provider-specific tool profile overrides", () => {
    const cfg: OpenClawConfig = {
      tools: { profile: "coding", byProvider: { "google-antigravity": { profile: "minimal" } } },
    };

    const tools = createMainSessionTools(cfg, {
      modelProvider: "google-antigravity",
      modelId: "claude-opus-4-6-thinking",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames.toSorted()).toEqual(["gateway", "session_status"]);
  });

  it("should resolve different tool policies for different agents", () => {
    const cfg: OpenClawConfig = {
      agents: {
        entries: {
          main: {
            workspace: "~/openclaw",
          },
          family: {
            workspace: "~/openclaw-family",
            tools: {
              allow: ["read"],
              deny: ["exec", "write", "edit", "process"],
            },
          },
        },
      },
    };

    const mainPolicy = resolveEffectiveToolPolicy({
      config: cfg,
      sessionKey: "agent:main:main",
    });
    expect(mainPolicy.agentId).toBe("main");
    expect(mainPolicy.agentPolicy).toBeUndefined();

    const familyPolicy = resolveEffectiveToolPolicy({
      config: cfg,
      sessionKey: "agent:family:whatsapp:group:123",
    });
    expect(familyPolicy.agentId).toBe("family");
    expect(familyPolicy.agentPolicy).toEqual({
      allow: ["read"],
      deny: ["exec", "write", "edit", "process"],
    });
  });

  it("should resolve group tool policy overrides (group-specific beats wildcard)", () => {
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

    expect(
      resolveChannelGroupToolsPolicy({ cfg, channel: "whatsapp", groupId: "trusted" }),
    ).toEqual({ allow: ["read", "exec"] });

    expect(
      resolveChannelGroupToolsPolicy({ cfg, channel: "whatsapp", groupId: "unknown" }),
    ).toEqual({ allow: ["read"] });
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

    expect(
      resolveChannelGroupToolsPolicy({
        cfg,
        channel: "whatsapp",
        groupId: "family",
        senderId: "alice",
      }),
    ).toEqual({ allow: ["read", "exec"] });

    expect(
      resolveChannelGroupToolsPolicy({
        cfg,
        channel: "whatsapp",
        groupId: "family",
        senderId: "bob",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("should apply global per-sender tool policy to core tools", () => {
    const cfg: OpenClawConfig = {
      tools: { toolsBySender: { "id:guest": { deny: ["exec", "process"] } } },
    };

    const tools = createMainSessionTools(cfg, {
      messageProvider: "discord",
      sessionKey: undefined,
      senderId: "guest",
    });
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("read");
    expect(names).not.toContain("exec");
    expect(names).not.toContain("process");
  });

  it("keeps core tools for owner WebChat while restricting non-owners", async () => {
    const cfg: OpenClawConfig = {
      tools: { toolsBySender: { "*": { deny: ["exec", "process"] } } },
    };
    const createWebChatTools = (senderIsOwner: boolean) =>
      createMainSessionTools(cfg, {
        messageProvider: "webchat",
        sessionKey: undefined,
        senderIsOwner,
      });
    const ownerOnly = [
      "automations",
      "gateway",
      "nodes",
      "openclaw",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
    ];

    const ownerTools = createWebChatTools(true).map((tool) => tool.name);
    const nonOwnerTools = createWebChatTools(false);
    for (const name of ["exec", "process", ...ownerOnly]) {
      expect(ownerTools).toContain(name);
    }
    for (const name of ["exec", "process"]) {
      expect(nonOwnerTools.map((tool) => tool.name)).not.toContain(name);
    }
    // Owner-only tools keep their definitions for prompt-cache stability; calls are gated.
    await expectOwnerGated(nonOwnerTools, ...ownerOnly);
  });

  it("should let agent per-sender policy override global sender wildcard", () => {
    const cfg: OpenClawConfig = {
      tools: { toolsBySender: { "*": { deny: ["exec"] } } },
      agents: {
        entries: {
          trusted: {
            workspace: "~/openclaw-trusted",
            tools: { toolsBySender: { "id:alice": {} } },
          },
        },
      },
    };

    const tools = createMainSessionTools(cfg, {
      sessionKey: "agent:trusted:discord:dm:alice",
      messageProvider: "discord",
      senderId: "alice",
    });
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("read");
    expect(names).toContain("exec");
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

    expect(
      resolveChannelGroupToolsPolicy({
        cfg,
        channel: "whatsapp",
        groupId: "locked",
        senderId: "admin",
      }),
    ).toEqual({ allow: ["read"] });
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

    expect(resolveChannelGroupToolsPolicy({ cfg, channel: "telegram", groupId: "123" })).toEqual({
      allow: ["read"],
    });
  });

  it("should not apply forged caller group tool policy for non-group sessions", () => {
    const cfg: OpenClawConfig = {
      tools: { allow: ["read"] },
      channels: {
        whatsapp: {
          groups: {
            "trusted-group": {
              tools: { allow: ["exec", "read", "write", "edit"] },
            },
          },
        },
      },
    };

    const tools = createMainSessionTools(cfg, {
      messageProvider: "whatsapp",
      groupId: "trusted-group",
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).not.toContain("exec");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("apply_patch");
  });

  it("should prefer scoped group candidates before wildcard tool policy", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          groups: {
            "*": {
              tools: { allow: ["read", "exec"] },
            },
            oc_group_chat: {
              tools: { allow: ["read"] },
            },
          },
        },
      },
    };

    const tools = createMainSessionTools(cfg, {
      sessionKey: "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      messageProvider: "feishu",
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).not.toContain("exec");
  });

  it("should apply global tool policy before agent-specific policy", () => {
    const cfg: OpenClawConfig = {
      tools: { deny: ["browser"] },
      agents: {
        entries: {
          work: {
            workspace: "~/openclaw-work",
            tools: { deny: ["exec", "process"] },
          },
        },
      },
    };

    const tools = createMainSessionTools(cfg, {
      sessionKey: "agent:work:slack:dm:user123",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain("browser");
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("process");
    expect(toolNames).toContain("apply_patch");
  });

  it("should work with sandbox tools filtering", () => {
    const cfg = createRestrictedAgentSandboxConfig({
      agentTools: {
        allow: ["read"],
        deny: ["exec", "write"],
      },
      globalSandboxTools: {
        allow: ["read", "write", "exec"],
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
        backendId: "docker",
        sessionKey: "agent:restricted:main",
        workspaceDir: "/tmp/sandbox",
        agentWorkspaceDir: "/tmp/test-restricted",
        workspaceAccess: "none",
        runtimeId: "test-container",
        runtimeLabel: "test-container",
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
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("exec");
    expect(toolNames).not.toContain("write");
  });
});
