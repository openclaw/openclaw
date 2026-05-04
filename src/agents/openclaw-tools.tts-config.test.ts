import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AnyAgentTool } from "./tools/common.js";

const mocks = vi.hoisted(() => {
  const stubTool = (name: string) =>
    ({
      name,
      label: name,
      displaySummary: name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    }) satisfies AnyAgentTool;

  return {
    stubTool,
    createCronToolOptions: vi.fn(),
    createImageGenerateTool: vi.fn(() => stubTool("image_generate")),
    createImageTool: vi.fn(() => stubTool("image")),
    createMusicGenerateTool: vi.fn(() => stubTool("music_generate")),
    createPdfTool: vi.fn(() => stubTool("pdf")),
    createVideoGenerateTool: vi.fn(() => stubTool("video_generate")),
    createWebFetchTool: vi.fn(() => stubTool("web_fetch")),
    createWebSearchTool: vi.fn(() => stubTool("web_search")),
    getActiveRuntimeWebToolsMetadata: vi.fn(() => null),
    textToSpeech: vi.fn(async () => ({
      success: true,
      audioPath: "/tmp/openclaw/tts-config-test.opus",
      provider: "microsoft",
      voiceCompatible: true,
    })),
  };
});

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

vi.mock("./openclaw-tools.nodes-workspace-guard.js", () => ({
  applyNodesToolWorkspaceGuard: (tool: AnyAgentTool) => tool,
}));

vi.mock("./tools/agents-list-tool.js", () => ({
  createAgentsListTool: () => mocks.stubTool("agents_list"),
}));

vi.mock("./tools/canvas-tool.js", () => ({
  createCanvasTool: () => mocks.stubTool("canvas"),
}));

vi.mock("./tools/cron-tool.js", () => ({
  createCronTool: (options: unknown) => {
    mocks.createCronToolOptions(options);
    return mocks.stubTool("cron");
  },
}));

vi.mock("./tools/gateway-tool.js", () => ({
  createGatewayTool: () => mocks.stubTool("gateway"),
}));

vi.mock("./tools/image-generate-tool.js", () => ({
  createImageGenerateTool: mocks.createImageGenerateTool,
}));

vi.mock("./tools/image-tool.js", () => ({
  createImageTool: mocks.createImageTool,
}));

vi.mock("./tools/message-tool.js", () => ({
  createMessageTool: () => mocks.stubTool("message"),
}));

vi.mock("./tools/music-generate-tool.js", () => ({
  createMusicGenerateTool: mocks.createMusicGenerateTool,
}));

vi.mock("./tools/nodes-tool.js", () => ({
  createNodesTool: () => mocks.stubTool("nodes"),
}));

vi.mock("./tools/pdf-tool.js", () => ({
  createPdfTool: mocks.createPdfTool,
}));

vi.mock("./tools/session-status-tool.js", () => ({
  createSessionStatusTool: () => mocks.stubTool("session_status"),
}));

vi.mock("./tools/sessions-history-tool.js", () => ({
  createSessionsHistoryTool: () => mocks.stubTool("sessions_history"),
}));

vi.mock("./tools/sessions-list-tool.js", () => ({
  createSessionsListTool: () => mocks.stubTool("sessions_list"),
}));

vi.mock("./tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: () => mocks.stubTool("sessions_send"),
}));

vi.mock("./tools/sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: () => mocks.stubTool("sessions_spawn"),
}));

vi.mock("./tools/sessions-yield-tool.js", () => ({
  createSessionsYieldTool: () => mocks.stubTool("sessions_yield"),
}));

vi.mock("./tools/subagents-tool.js", () => ({
  createSubagentsTool: () => mocks.stubTool("subagents"),
}));

vi.mock("./tools/update-plan-tool.js", () => ({
  createUpdatePlanTool: () => mocks.stubTool("update_plan"),
}));

vi.mock("./tools/video-generate-tool.js", () => ({
  createVideoGenerateTool: mocks.createVideoGenerateTool,
}));

vi.mock("./tools/web-tools.js", () => ({
  createWebFetchTool: mocks.createWebFetchTool,
  createWebSearchTool: mocks.createWebSearchTool,
}));

vi.mock("../secrets/runtime.js", () => ({
  getActiveRuntimeWebToolsMetadata: mocks.getActiveRuntimeWebToolsMetadata,
  getActiveSecretsRuntimeSnapshot: () => undefined,
}));

vi.mock("../tts/tts.js", () => ({
  textToSpeech: mocks.textToSpeech,
}));

describe("createOpenClawTools TTS config wiring", () => {
  beforeEach(() => {
    mocks.createCronToolOptions.mockClear();
    mocks.createImageGenerateTool.mockClear();
    mocks.createImageTool.mockClear();
    mocks.createMusicGenerateTool.mockClear();
    mocks.createPdfTool.mockClear();
    mocks.createVideoGenerateTool.mockClear();
    mocks.createWebFetchTool.mockClear();
    mocks.createWebSearchTool.mockClear();
    mocks.getActiveRuntimeWebToolsMetadata.mockClear();
    mocks.textToSpeech.mockClear();
  });

  it("does not materialize optional core tools outside an explicit allowlist", async () => {
    const { createOpenClawTools } = await import("./openclaw-tools.js");

    const tools = createOpenClawTools({
      coreToolAllowlist: ["sessions_list"],
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(tools.map((tool) => tool.name)).toEqual(["sessions_list"]);
    expect(mocks.createImageGenerateTool).not.toHaveBeenCalled();
    expect(mocks.createImageTool).not.toHaveBeenCalled();
    expect(mocks.createMusicGenerateTool).not.toHaveBeenCalled();
    expect(mocks.createPdfTool).not.toHaveBeenCalled();
    expect(mocks.createVideoGenerateTool).not.toHaveBeenCalled();
    expect(mocks.createWebFetchTool).not.toHaveBeenCalled();
    expect(mocks.createWebSearchTool).not.toHaveBeenCalled();
    expect(mocks.getActiveRuntimeWebToolsMetadata).not.toHaveBeenCalled();
  });

  it("passes planned generation availability into media tool factories", async () => {
    const { createOpenClawTools } = await import("./openclaw-tools.js");

    createOpenClawTools({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "image-owner/model" },
            videoGenerationModel: { primary: "video-owner/model" },
            musicGenerationModel: { primary: "music-owner/model" },
          },
        },
      },
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.createImageGenerateTool).toHaveBeenCalledWith(
      expect.objectContaining({ precomputedAvailability: true }),
    );
    expect(mocks.createVideoGenerateTool).toHaveBeenCalledWith(
      expect.objectContaining({ precomputedAvailability: true }),
    );
    expect(mocks.createMusicGenerateTool).toHaveBeenCalledWith(
      expect.objectContaining({ precomputedAvailability: true }),
    );
  });

  it("passes the resolved shared config into the tts tool", async () => {
    const injectedConfig = {
      messages: {
        tts: {
          auto: "always",
          provider: "microsoft",
          providers: {
            microsoft: {
              voice: "en-US-AvaNeural",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const { __testing, createOpenClawTools } = await import("./openclaw-tools.js");
    __testing.setDepsForTest({ config: injectedConfig });

    try {
      const tool = createOpenClawTools({
        disableMessageTool: true,
        disablePluginTools: true,
      }).find((candidate) => candidate.name === "tts");

      if (!tool) {
        throw new Error("missing tts tool");
      }

      await tool.execute("call-1", { text: "hello from config" });

      expect(mocks.textToSpeech).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "hello from config",
          cfg: injectedConfig,
        }),
      );
    } finally {
      __testing.setDepsForTest();
    }
  });

  it("keeps direct TTS tool guidance explicit even when the tool is available", async () => {
    const { __testing, createOpenClawTools } = await import("./openclaw-tools.js");
    __testing.setDepsForTest({ config: {} });

    try {
      const tool = createOpenClawTools({
        disableMessageTool: true,
        disablePluginTools: true,
      }).find((candidate) => candidate.name === "tts");

      if (!tool) {
        throw new Error("missing tts tool");
      }

      expect(tool.description).toContain("Use only for explicit audio intent");
      expect(tool.description).toContain("Never use for ordinary text replies");
    } finally {
      __testing.setDepsForTest();
    }
  });

  it("passes the resolved session agent id into the tts tool", async () => {
    const injectedConfig = {
      agents: {
        list: [{ id: "reader" }, { id: "main" }],
      },
    } satisfies OpenClawConfig;

    const { __testing, createOpenClawTools } = await import("./openclaw-tools.js");
    __testing.setDepsForTest({ config: injectedConfig });

    try {
      const tool = createOpenClawTools({
        agentSessionKey: "agent:reader:telegram:chat:123",
        disableMessageTool: true,
        disablePluginTools: true,
      }).find((candidate) => candidate.name === "tts");

      if (!tool) {
        throw new Error("missing tts tool");
      }

      await tool.execute("call-1", { text: "hello from reader" });

      expect(mocks.textToSpeech).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "hello from reader",
          agentId: "reader",
        }),
      );
    } finally {
      __testing.setDepsForTest();
    }
  });

  it("passes the active account id into the tts tool", async () => {
    const injectedConfig = {
      channels: {
        feishu: {
          accounts: {
            "feishu-main": {
              tts: {
                provider: "microsoft",
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const { __testing, createOpenClawTools } = await import("./openclaw-tools.js");
    __testing.setDepsForTest({ config: injectedConfig });

    try {
      const tool = createOpenClawTools({
        agentChannel: "feishu",
        agentAccountId: "feishu-main",
        disableMessageTool: true,
        disablePluginTools: true,
      }).find((candidate) => candidate.name === "tts");

      if (!tool) {
        throw new Error("missing tts tool");
      }

      await tool.execute("call-1", { text: "hello from account" });

      expect(mocks.textToSpeech).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "hello from account",
          cfg: injectedConfig,
          channel: "feishu",
          accountId: "feishu-main",
        }),
      );
    } finally {
      __testing.setDepsForTest();
    }
  });
});

describe("createOpenClawTools cron context wiring", () => {
  beforeEach(() => {
    mocks.createCronToolOptions.mockClear();
  });

  it("passes preserved channel delivery context into the cron tool", async () => {
    const { createOpenClawTools } = await import("./openclaw-tools.js");

    createOpenClawTools({
      agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
      agentChannel: "matrix",
      agentAccountId: "bot-a",
      agentTo: "room:!FallbackRoom:Example.Org",
      agentThreadId: "$FallbackThread:Example.Org",
      currentChannelId: "room:!AbCdEf1234567890:example.org",
      currentThreadTs: "$RootEvent:Example.Org",
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.createCronToolOptions).toHaveBeenCalledWith({
      agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
      currentDeliveryContext: {
        channel: "matrix",
        to: "room:!AbCdEf1234567890:example.org",
        accountId: "bot-a",
        threadId: "$RootEvent:Example.Org",
      },
    });
  });

  it("uses agent route context when auto-threading context is unavailable", async () => {
    const { createOpenClawTools } = await import("./openclaw-tools.js");

    createOpenClawTools({
      agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
      agentChannel: "matrix",
      agentAccountId: "bot-a",
      agentTo: "room:!FallbackRoom:Example.Org",
      agentThreadId: "$FallbackThread:Example.Org",
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.createCronToolOptions).toHaveBeenCalledWith({
      agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
      currentDeliveryContext: {
        channel: "matrix",
        to: "room:!FallbackRoom:Example.Org",
        accountId: "bot-a",
        threadId: "$FallbackThread:Example.Org",
      },
    });
  });

  it("passes self-remove scope into the cron tool", async () => {
    const { createOpenClawTools } = await import("./openclaw-tools.js");

    createOpenClawTools({
      agentSessionKey: "agent:main:cron:job-current",
      cronSelfRemoveOnlyJobId: "job-current",
      disableMessageTool: true,
      disablePluginTools: true,
    });

    expect(mocks.createCronToolOptions).toHaveBeenCalledWith({
      agentSessionKey: "agent:main:cron:job-current",
      currentDeliveryContext: {
        channel: undefined,
        to: undefined,
        accountId: undefined,
        threadId: undefined,
      },
      selfRemoveOnlyJobId: "job-current",
    });
  });
});
