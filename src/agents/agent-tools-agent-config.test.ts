import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { expectOwnerGated } from "./agent-tools.turn-authority.test-support.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { createRestrictedAgentSandboxConfig } from "./test-helpers/sandbox-agent-config-fixtures.js";

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

  function expectToolNames(names: string[], allowed: string[], denied: string[] = []) {
    expect(names).toEqual(expect.arrayContaining(allowed));
    for (const name of denied) {
      expect(names).not.toContain(name);
    }
  }

  function expectConfiguredTools(
    config: OpenClawConfig,
    allowed: string[],
    denied: string[],
    options: Parameters<typeof createMainSessionTools>[1] = {},
  ) {
    expectToolNames(
      createMainSessionTools(config, options).map((tool) => tool.name),
      allowed,
      denied,
    );
  }

  async function withApplyPatchEscapeCase(
    workspaceOnly: boolean,
    run: (params: {
      applyPatchTool: ReturnType<typeof createMainSessionTools>[number];
      escapedPath: string;
      patch: string;
    }) => Promise<void>,
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-tools-"));
    const workspaceDir = path.join(root, "workspace");
    await fs.mkdir(workspaceDir);
    const escapedPath = path.join(root, "escaped.txt");
    const relativeEscape = path.relative(workspaceDir, escapedPath);

    try {
      const tools = createMainSessionTools(
        {
          tools: {
            allow: ["read", "write", "exec"],
            exec: { applyPatch: workspaceOnly ? {} : { workspaceOnly: false } },
          },
        },
        {
          workspaceDir,
          modelProvider: "openai",
          modelId: "gpt-5.4",
        },
      );

      const patch = `*** Begin Patch
*** Add File: ${relativeEscape}
+escaped
*** End Patch`;

      await run({
        applyPatchTool: expectDefined(
          tools.find((tool) => tool.name === "apply_patch"),
          "apply_patch",
        ),
        escapedPath,
        patch,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
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

  const agentConfig = (
    entries: NonNullable<OpenClawConfig["agents"]>["entries"],
  ): OpenClawConfig => ({ agents: { entries } });
  const groupConfig = (
    groups: NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>["groups"],
    channel = "whatsapp",
  ): OpenClawConfig => ({ channels: { [channel]: { groups } } });

  it("should apply global tool policy when no agent-specific policy exists", () => {
    const tools = createMainSessionTools({
      tools: { allow: ["read", "write"], deny: ["bash"] },
      agents: { entries: { main: { workspace: "~/openclaw" } } },
    });

    const toolNames = tools.map((t) => t.name);
    expectToolNames(toolNames, ["read", "write", "apply_patch"], ["exec"]);
  });

  it("should keep global tool policy when agent only sets tools.elevated", () => {
    const tools = createMainSessionTools({
      tools: { deny: ["write"] },
      ...agentConfig({
        main: {
          workspace: "~/openclaw",
          tools: {
            elevated: { enabled: true, allowFrom: { whatsapp: ["+15555550123"] } },
          },
        },
      }),
    });

    const toolNames = tools.map((t) => t.name);
    expectToolNames(toolNames, ["exec", "read", "apply_patch"], ["write"]);
  });

  it("uses the configured default agent for lean local-model filtering on legacy session keys", () => {
    expectConfiguredTools(
      agentConfig({ local: { experimental: { localModelLean: true } } }),
      ["read"],
      ["browser", "automations", "message"],
      {
        sessionKey: "main",
        agentDir: "/tmp/agent-local",
        modelProvider: "lmstudio",
        modelId: "gemma-4-e4b-it",
      },
    );
  });

  it("should allow disabling apply_patch explicitly", () => {
    expectConfiguredTools(
      { tools: { allow: ["read", "write", "exec"], exec: { applyPatch: { enabled: false } } } },
      ["exec"],
      ["apply_patch"],
      { modelProvider: "openai", modelId: "gpt-5.4" },
    );
  });

  it("defaults apply_patch to workspace-only (blocks traversal)", async () => {
    await withApplyPatchEscapeCase(true, async ({ applyPatchTool, escapedPath, patch }) => {
      await expect(applyPatchTool.execute("tc1", { input: patch })).rejects.toThrow(
        /Path escapes sandbox root/,
      );
      await expect(fs.readFile(escapedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("allows disabling apply_patch workspace-only via config (dangerous)", async () => {
    await withApplyPatchEscapeCase(false, async ({ applyPatchTool, escapedPath, patch }) => {
      await applyPatchTool.execute("tc2", { input: patch });
      const contents = await fs.readFile(escapedPath, "utf8");
      expect(contents).toBe("escaped\n");
    });
  });

  it("should apply agent-specific tool policy", () => {
    expectConfiguredTools(
      {
        tools: { allow: ["read", "write", "exec"], deny: [] },
        ...agentConfig({
          main: {},
          restricted: {
            workspace: "~/openclaw-restricted",
            tools: { allow: ["read"], deny: ["exec", "write", "edit"] },
          },
        }),
      },
      ["read"],
      ["exec", "write", "apply_patch", "edit"],
      {
        sessionKey: "agent:restricted:main",
        workspaceDir: "/tmp/test-restricted",
        agentDir: "/tmp/agent-restricted",
      },
    );
  });

  it("should apply provider-specific tool policy", () => {
    expectConfiguredTools(
      {
        tools: {
          allow: ["read", "write", "exec"],
          byProvider: { "google-antigravity": { allow: ["read"] } },
        },
      },
      ["read"],
      ["exec", "write", "apply_patch"],
      {
        workspaceDir: "/tmp/test-provider",
        agentDir: "/tmp/agent-provider",
        modelProvider: "google-antigravity",
        modelId: "claude-opus-4-6-thinking",
      },
    );
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

  it("should apply global per-sender tool policy to core tools", () => {
    expectConfiguredTools(
      { tools: { toolsBySender: { "id:guest": { deny: ["exec", "process"] } } } },
      ["read"],
      ["exec", "process"],
      { messageProvider: "discord", sessionKey: undefined, senderId: "guest" },
    );
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
    expectConfiguredTools(
      {
        tools: { toolsBySender: { "*": { deny: ["exec"] } } },
        ...agentConfig({
          trusted: {
            workspace: "~/openclaw-trusted",
            tools: { toolsBySender: { "id:alice": {} } },
          },
        }),
      },
      ["read", "exec"],
      [],
      {
        sessionKey: "agent:trusted:discord:dm:alice",
        messageProvider: "discord",
        senderId: "alice",
      },
    );
  });

  it("should not apply forged caller group tool policy for non-group sessions", () => {
    const cfg: OpenClawConfig = {
      ...groupConfig({ "trusted-group": { tools: { allow: ["exec", "read", "write", "edit"] } } }),
      tools: { allow: ["read"] },
    };

    const tools = createMainSessionTools(cfg, {
      messageProvider: "whatsapp",
      groupId: "trusted-group",
    });
    const names = tools.map((t) => t.name);
    expectToolNames(names, ["read"], ["exec", "write", "apply_patch", "edit"]);
  });

  it("should prefer scoped group candidates before wildcard tool policy", () => {
    const cfg = groupConfig(
      {
        "*": { tools: { allow: ["read", "exec"] } },
        oc_group_chat: { tools: { allow: ["read"] } },
      },
      "feishu",
    );

    const tools = createMainSessionTools(cfg, {
      sessionKey: "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      messageProvider: "feishu",
    });
    const names = tools.map((t) => t.name);
    expectToolNames(names, ["read"], ["exec"]);
  });

  it("should apply global tool policy before agent-specific policy", () => {
    expectConfiguredTools(
      {
        tools: { deny: ["browser"] },
        ...agentConfig({
          work: { workspace: "~/openclaw-work", tools: { deny: ["exec", "process"] } },
        }),
      },
      ["apply_patch"],
      ["browser", "exec", "process"],
      {
        sessionKey: "agent:work:slack:dm:user123",
      },
    );
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
      sandbox: createSandboxTestContext({
        overrides: {
          sessionKey: "agent:restricted:main",
          workspaceDir: "/tmp/sandbox",
          agentWorkspaceDir: "/tmp/test-restricted",
          workspaceAccess: "none",
          runtimeId: "test-container",
          runtimeLabel: "test-container",
          containerName: "test-container",
          fsBridge: sandboxFsBridgeStub,
          tools: { allow: ["read", "write", "exec"], deny: [] },
        },
        dockerOverrides: {
          image: "test-image",
          containerPrefix: "test-",
          readOnlyRoot: true,
        },
      }),
    });

    const toolNames = tools.map((t) => t.name);
    expectToolNames(toolNames, ["read"], ["exec", "write"]);
  });
});
