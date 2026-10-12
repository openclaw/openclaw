import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTools, createOpenClawToolsAsync } from "./openclaw-tools.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import type { AnyAgentTool } from "./tools/common.js";
import type { MediaGenerateToolOptions } from "./tools/media-generate-background.js";

const mocks = vi.hoisted(() => {
  const stubTool = (name: string): AnyAgentTool => ({
    name,
    label: name,
    displaySummary: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
  });
  const backgroundMediaTool = (name: string, options?: MediaGenerateToolOptions): AnyAgentTool => ({
    ...stubTool(name),
    execute: async () => {
      await options?.onAsyncTaskStarted?.("Media generation started.");
      return { content: [{ type: "text", text: "Background task started." }], details: {} };
    },
  });
  return {
    cron: vi.fn((_options: unknown) => stubTool("cron")),
    transcripts: vi.fn((_options: unknown) => stubTool("transcripts")),
    status: vi.fn((_options: unknown) => stubTool("session_status")),
    image: vi.fn((options?: MediaGenerateToolOptions) =>
      backgroundMediaTool("image_generate", options),
    ),
    music: vi.fn((options?: MediaGenerateToolOptions) =>
      backgroundMediaTool("music_generate", options),
    ),
    video: vi.fn((options?: MediaGenerateToolOptions) =>
      backgroundMediaTool("video_generate", options),
    ),
    textToSpeech: vi.fn<typeof import("../tts/tts.js").textToSpeech>(async () => ({
      success: true,
      audioPath: "/tmp/openclaw/tts-config-test.opus",
      provider: "microsoft",
      voiceCompatible: true,
    })),
  };
});

vi.mock("./tools/cron-tool.js", () => ({ createCronTool: mocks.cron }));
vi.mock("./tools/transcripts-tool.js", () => ({ createTranscriptsTool: mocks.transcripts }));
vi.mock("./tools/session-status-tool.js", () => ({ createSessionStatusTool: mocks.status }));
vi.mock("./tools/image-generate-tool.js", () => ({ createImageGenerateTool: mocks.image }));
vi.mock("./tools/music-generate-tool.js", () => ({ createMusicGenerateTool: mocks.music }));
vi.mock("./tools/video-generate-tool.js", () => ({ createVideoGenerateTool: mocks.video }));
vi.mock("../tts/tts.js", () => ({ textToSpeech: mocks.textToSpeech }));

function createTools(options: OpenClawToolsOptions) {
  return createOpenClawTools({ disableMessageTool: true, disablePluginTools: true, ...options });
}

const mediaConfig = {
  agents: {
    defaults: {
      mediaModels: {
        image: { primary: "image-owner/model" },
        music: { primary: "music-owner/model" },
        video: { primary: "video-owner/model" },
      },
    },
  },
} satisfies OpenClawConfig;

describe("createOpenClawTools context wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the session agent and active account configuration into TTS", async () => {
    const config = {
      agents: { entries: { reader: {}, main: {} } },
      channels: { feishu: { accounts: { "feishu-main": { tts: { provider: "microsoft" } } } } },
    } satisfies OpenClawConfig;
    const tool = createTools({
      config,
      agentSessionKey: "agent:reader:feishu:chat:123",
      agentChannel: "feishu",
      agentAccountId: "feishu-main",
    }).find((candidate) => candidate.name === "tts");
    expect(tool).toBeDefined();
    await tool?.execute("call-1", { text: "hello from reader" });
    expect(mocks.textToSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello from reader",
        agentId: "reader",
        channel: "feishu",
        accountId: "feishu-main",
      }),
    );
    expect(mocks.textToSpeech.mock.calls[0]?.[0].cfg).toBe(config);
  });

  it("uses the delivery account when no separate transcript authority exists", () => {
    createTools({
      agentChannel: "discord",
      agentAccountId: "delivery",
      requesterSenderId: "requester",
    });
    expect(mocks.transcripts).toHaveBeenLastCalledWith(
      expect.objectContaining({
        caller: expect.objectContaining({
          kind: "channel",
          channel: "discord",
          accountId: "delivery",
          senderId: "requester",
        }),
      }),
    );
  });

  it("hides transcripts when caller-channel provenance is unavailable", () => {
    const caller = {
      agentChannel: "discord",
      agentAccountId: "delivery",
      gatewayCallerAccountId: "creator",
      requesterSenderId: "requester",
    };
    createTools({ ...caller, gatewayCallerChannel: null });
    expect(mocks.transcripts).not.toHaveBeenCalled();
    createTools({ ...caller, gatewayCallerLocal: true });
    expect(mocks.transcripts).not.toHaveBeenCalled();
  });

  it("keeps transcripts channel-less for explicit local scheduled provenance", () => {
    createTools({
      agentChannel: "discord",
      agentAccountId: "delivery",
      gatewayCallerAccountId: "creator",
      gatewayCallerLocal: true,
      gatewayCallerScheduled: true,
    });
    expect(mocks.transcripts).toHaveBeenLastCalledWith(
      expect.objectContaining({
        caller: { kind: "operator", source: "scheduled" },
      }),
    );
  });

  it.each([
    [
      "agent:main:cron:daily-media",
      "agent:main:cron:daily-media:run:run-123",
      "agent:main:cron:daily-media:run:run-123",
    ],
    [
      "agent:main:qa-channel:default:direct:media-requester",
      "agent:main:main",
      "agent:main:qa-channel:default:direct:media-requester",
    ],
  ])(
    "passes a separate durable requester key for background media from %s",
    async (agentSessionKey, runSessionKey, taskSessionKey) => {
      await createOpenClawToolsAsync({
        disableMessageTool: true,
        disablePluginTools: true,
        authProfileStore: { version: 1, profiles: {} },
        config: mediaConfig,
        agentSessionKey,
        runSessionKey,
        onYield: vi.fn(),
      });
      for (const factory of [mocks.image, mocks.video, mocks.music]) {
        expect(factory).toHaveBeenCalledWith(
          expect.objectContaining({
            agentSessionKey: taskSessionKey,
            requesterRunSessionKey: runSessionKey,
          }),
          true,
        );
      }
    },
  );

  it("passes preserved channel delivery context into cron", () => {
    const sessionKey = "agent:main:matrix:channel:!abcdef1234567890:example.org";
    createTools({
      agentSessionKey: sessionKey,
      agentChannel: "matrix",
      agentAccountId: "bot-a",
      agentTo: "room:!FallbackRoom:Example.Org",
      agentThreadId: "$FallbackThread:Example.Org",
      currentChannelId: "room:!AbCdEf1234567890:example.org",
      currentThreadTs: "$RootEvent:Example.Org",
    });
    expect(mocks.cron).toHaveBeenCalledWith(
      expect.objectContaining({
        currentDeliveryContext: {
          channel: "matrix",
          to: "room:!AbCdEf1234567890:example.org",
          accountId: "bot-a",
          threadId: "$RootEvent:Example.Org",
        },
      }),
    );
  });

  it("passes self-remove scope into cron", () => {
    createTools({
      agentSessionKey: "agent:main:cron:job-current",
      cronSelfRemoveOnlyJobId: "job-current",
    });
    expect(mocks.cron).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: "agent:main:cron:job-current",
        selfRemoveOnlyJobId: "job-current",
      }),
    );
  });
});
