import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import {
  applyGoogleTurnOrderingFix,
  buildEmbeddedSandboxInfo,
  createSystemPromptOverride,
  getDmHistoryLimitFromSessionKey,
  limitHistoryTurns,
  runEmbeddedPiAgent,
  splitSdkTools,
} from "./pi-embedded-runner.js";
import type { SandboxContext } from "./sandbox.js";

describe("buildEmbeddedSandboxInfo", () => {
  it("returns undefined when sandbox is missing", () => {
    expect(buildEmbeddedSandboxInfo()).toBeUndefined();
  });

  it("maps sandbox context into prompt info", () => {
    const sandbox = {
      enabled: true,
      sessionKey: "session:test",
      workspaceDir: "/tmp/clawdbot-sandbox",
      agentWorkspaceDir: "/tmp/clawdbot-workspace",
      workspaceAccess: "none",
      containerName: "clawdbot-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "clawdbot-sandbox:bookworm-slim",
        containerPrefix: "clawdbot-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: ["/tmp"],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      tools: {
        allow: ["bash"],
        deny: ["browser"],
      },
      browserAllowHostControl: true,
      browser: {
        controlUrl: "http://localhost:9222",
        noVncUrl: "http://localhost:6080",
        containerName: "clawdbot-sbx-browser-test",
      },
    } satisfies SandboxContext;

    expect(buildEmbeddedSandboxInfo(sandbox)).toEqual({
      enabled: true,
      workspaceDir: "/tmp/clawdbot-sandbox",
      workspaceAccess: "none",
      agentWorkspaceMount: undefined,
      browserControlUrl: "http://localhost:9222",
      browserNoVncUrl: "http://localhost:6080",
      hostBrowserAllowed: true,
    });
  });

  it("includes elevated info when allowed", () => {
    const sandbox = {
      enabled: true,
      sessionKey: "session:test",
      workspaceDir: "/tmp/clawdbot-sandbox",
      agentWorkspaceDir: "/tmp/clawdbot-workspace",
      workspaceAccess: "none",
      containerName: "clawdbot-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "clawdbot-sandbox:bookworm-slim",
        containerPrefix: "clawdbot-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: ["/tmp"],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      tools: {
        allow: ["bash"],
        deny: ["browser"],
      },
      browserAllowHostControl: false,
    } satisfies SandboxContext;

    expect(
      buildEmbeddedSandboxInfo(sandbox, {
        enabled: true,
        allowed: true,
        defaultLevel: "on",
      }),
    ).toEqual({
      enabled: true,
      workspaceDir: "/tmp/clawdbot-sandbox",
      workspaceAccess: "none",
      agentWorkspaceMount: undefined,
      hostBrowserAllowed: false,
      elevated: { allowed: true, defaultLevel: "on" },
    });
  });
});

describe("resolveSessionAgentIds", () => {
  const cfg = {
    agents: {
      list: [{ id: "main" }, { id: "beta", default: true }],
    },
  } as ClawdbotConfig;

  it("falls back to the configured default when sessionKey is missing", () => {
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      config: cfg,
    });
    expect(defaultAgentId).toBe("beta");
    expect(sessionAgentId).toBe("beta");
  });

  it("falls back to the configured default when sessionKey is non-agent", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "telegram:slash:123",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("falls back to the configured default for global sessions", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "global",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("keeps the agent id for provider-qualified agent sessions", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:beta:slack:channel:C1",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("uses the agent id from agent session keys", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:main:main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("main");
  });
});

function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  };
}

describe("splitSdkTools", () => {
  const tools = [
    createStubTool("read"),
    createStubTool("bash"),
    createStubTool("edit"),
    createStubTool("write"),
    createStubTool("browser"),
  ];

  it("routes all tools to customTools when sandboxed", () => {
    const { builtInTools, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: true,
    });
    expect(builtInTools).toEqual([]);
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "browser",
    ]);
  });

  it("routes all tools to customTools even when not sandboxed", () => {
    const { builtInTools, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: false,
    });
    expect(builtInTools).toEqual([]);
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "browser",
    ]);
  });
});

describe("createSystemPromptOverride", () => {
  it("returns the override prompt regardless of default prompt", () => {
    const override = createSystemPromptOverride("OVERRIDE");
    expect(override("DEFAULT")).toBe("OVERRIDE");
  });

  it("returns an empty string for blank overrides", () => {
    const override = createSystemPromptOverride("  \n  ");
    expect(override("DEFAULT")).toBe("");
  });
});

describe("applyGoogleTurnOrderingFix", () => {
  const makeAssistantFirst = () =>
    [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "bash", arguments: {} },
        ],
      },
    ] satisfies AgentMessage[];

  it("prepends a bootstrap once and records a marker for Google models", () => {
    const sessionManager = SessionManager.inMemory();
    const warn = vi.fn();
    const input = makeAssistantFirst();
    const first = applyGoogleTurnOrderingFix({
      messages: input,
      modelApi: "google-generative-ai",
      sessionManager,
      sessionId: "session:1",
      warn,
    });
    expect(first.messages[0]?.role).toBe("user");
    expect(first.messages[1]?.role).toBe("assistant");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(
      sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "google-turn-ordering-bootstrap",
        ),
    ).toBe(true);

    applyGoogleTurnOrderingFix({
      messages: input,
      modelApi: "google-generative-ai",
      sessionManager,
      sessionId: "session:1",
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("skips non-Google models", () => {
    const sessionManager = SessionManager.inMemory();
    const warn = vi.fn();
    const input = makeAssistantFirst();
    const result = applyGoogleTurnOrderingFix({
      messages: input,
      modelApi: "openai",
      sessionManager,
      sessionId: "session:2",
      warn,
    });
    expect(result.messages).toBe(input);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("limitHistoryTurns", () => {
  const makeMessages = (roles: ("user" | "assistant")[]): AgentMessage[] =>
    roles.map((role, i) => ({
      role,
      content: [{ type: "text", text: `message ${i}` }],
    }));

  it("returns all messages when limit is undefined", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, undefined)).toBe(messages);
  });

  it("returns all messages when limit is 0", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, 0)).toBe(messages);
  });

  it("returns all messages when limit is negative", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, -1)).toBe(messages);
  });

  it("returns empty array when messages is empty", () => {
    expect(limitHistoryTurns([], 5)).toEqual([]);
  });

  it("keeps all messages when fewer user turns than limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, 10)).toBe(messages);
  });

  it("limits to last N user turns", () => {
    const messages = makeMessages([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const limited = limitHistoryTurns(messages, 2);
    expect(limited.length).toBe(4);
    expect(limited[0].content).toEqual([{ type: "text", text: "message 2" }]);
  });

  it("handles single user turn limit", () => {
    const messages = makeMessages([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const limited = limitHistoryTurns(messages, 1);
    expect(limited.length).toBe(2);
    expect(limited[0].content).toEqual([{ type: "text", text: "message 4" }]);
    expect(limited[1].content).toEqual([{ type: "text", text: "message 5" }]);
  });

  it("handles messages with multiple assistant responses per user turn", () => {
    const messages = makeMessages([
      "user",
      "assistant",
      "assistant",
      "user",
      "assistant",
    ]);
    const limited = limitHistoryTurns(messages, 1);
    expect(limited.length).toBe(2);
    expect(limited[0].role).toBe("user");
    expect(limited[1].role).toBe("assistant");
  });

  it("preserves message content integrity", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }],
      },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: [{ type: "text", text: "response" }] },
    ];
    const limited = limitHistoryTurns(messages, 1);
    expect(limited[0].content).toEqual([{ type: "text", text: "second" }]);
    expect(limited[1].content).toEqual([{ type: "text", text: "response" }]);
  });
});

describe("getDmHistoryLimitFromSessionKey", () => {
  it("returns undefined when sessionKey is undefined", () => {
    expect(getDmHistoryLimitFromSessionKey(undefined, {})).toBeUndefined();
  });

  it("returns undefined when config is undefined", () => {
    expect(
      getDmHistoryLimitFromSessionKey("telegram:dm:123", undefined),
    ).toBeUndefined();
  });

  it("returns dmHistoryLimit for telegram provider", () => {
    const config = { telegram: { dmHistoryLimit: 15 } } as ClawdbotConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(15);
  });

  it("returns dmHistoryLimit for whatsapp provider", () => {
    const config = { whatsapp: { dmHistoryLimit: 20 } } as ClawdbotConfig;
    expect(getDmHistoryLimitFromSessionKey("whatsapp:dm:123", config)).toBe(20);
  });

  it("returns dmHistoryLimit for agent-prefixed session keys", () => {
    const config = { telegram: { dmHistoryLimit: 10 } } as ClawdbotConfig;
    expect(
      getDmHistoryLimitFromSessionKey("agent:main:telegram:dm:123", config),
    ).toBe(10);
  });

  it("returns undefined for unknown provider", () => {
    const config = { telegram: { dmHistoryLimit: 15 } } as ClawdbotConfig;
    expect(
      getDmHistoryLimitFromSessionKey("unknown:dm:123", config),
    ).toBeUndefined();
  });

  it("returns undefined when provider config has no dmHistoryLimit", () => {
    const config = { telegram: {} } as ClawdbotConfig;
    expect(
      getDmHistoryLimitFromSessionKey("telegram:dm:123", config),
    ).toBeUndefined();
  });

  it("handles all supported providers", () => {
    const providers = [
      "telegram",
      "whatsapp",
      "discord",
      "slack",
      "signal",
      "imessage",
      "msteams",
    ] as const;

    for (const provider of providers) {
      const config = { [provider]: { dmHistoryLimit: 5 } } as ClawdbotConfig;
      expect(
        getDmHistoryLimitFromSessionKey(`${provider}:dm:123`, config),
      ).toBe(5);
    }
  });

  it("returns per-DM override when set", () => {
    const config = {
      telegram: {
        dmHistoryLimit: 15,
        dms: { "123": { historyLimit: 5 } },
      },
    } as ClawdbotConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(5);
  });

  it("falls back to provider default when per-DM not set", () => {
    const config = {
      telegram: {
        dmHistoryLimit: 15,
        dms: { "456": { historyLimit: 5 } },
      },
    } as ClawdbotConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(15);
  });

  it("returns per-DM override for agent-prefixed keys", () => {
    const config = {
      telegram: {
        dmHistoryLimit: 20,
        dms: { "789": { historyLimit: 3 } },
      },
    } as ClawdbotConfig;
    expect(
      getDmHistoryLimitFromSessionKey("agent:main:telegram:dm:789", config),
    ).toBe(3);
  });

  it("handles userId with colons (e.g., email)", () => {
    const config = {
      msteams: {
        dmHistoryLimit: 10,
        dms: { "user@example.com": { historyLimit: 7 } },
      },
    } as ClawdbotConfig;
    expect(
      getDmHistoryLimitFromSessionKey("msteams:dm:user@example.com", config),
    ).toBe(7);
  });

  it("returns undefined when per-DM historyLimit is not set", () => {
    const config = {
      telegram: {
        dms: { "123": {} },
      },
    } as ClawdbotConfig;
    expect(
      getDmHistoryLimitFromSessionKey("telegram:dm:123", config),
    ).toBeUndefined();
  });

  it("returns 0 when per-DM historyLimit is explicitly 0 (unlimited)", () => {
    const config = {
      telegram: {
        dmHistoryLimit: 15,
        dms: { "123": { historyLimit: 0 } },
      },
    } as ClawdbotConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(0);
  });
});

describe("runEmbeddedPiAgent", () => {
  it("writes models.json into the provided agentDir", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-agent-"),
    );
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-workspace-"),
    );
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    const cfg = {
      models: {
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/v1",
            api: "openai-completions",
            apiKey: "sk-minimax-test",
            models: [
              {
                id: "minimax-m2.1",
                name: "MiniMax M2.1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } satisfies ClawdbotConfig;

    await expect(
      runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey: "agent:dev:test",
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "hi",
        provider: "definitely-not-a-provider",
        model: "definitely-not-a-model",
        timeoutMs: 1,
        agentDir,
      }),
    ).rejects.toThrow(/Unknown model:/);

    await expect(
      fs.stat(path.join(agentDir, "models.json")),
    ).resolves.toBeTruthy();
  });
});
