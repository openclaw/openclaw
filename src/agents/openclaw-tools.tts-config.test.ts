import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTools, createOpenClawToolsAsync } from "./openclaw-tools.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import type { AnyAgentTool } from "./tools/common.js";
import type { MediaGenerateToolOptions } from "./tools/media-generate-background.js";

const mocks = vi.hoisted(() => {
  const stubTool = (name: string, execute: AnyAgentTool["execute"] = vi.fn()): AnyAgentTool => ({
    name,
    label: name,
    displaySummary: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute,
  });
  const background: AnyAgentTool["execute"] = async () => ({
    content: [{ type: "text", text: "Background task started." }],
    details: {},
  });
  return {
    cron: vi.fn((_options: unknown) => stubTool("cron")),
    transcripts: vi.fn((_options: unknown) => stubTool("transcripts")),
    status: vi.fn((_options: unknown) => stubTool("session_status")),
    image: vi.fn((_options?: MediaGenerateToolOptions) => stubTool("image_generate", background)),
    music: vi.fn((_options?: MediaGenerateToolOptions) => stubTool("music_generate", background)),
    video: vi.fn((_options?: MediaGenerateToolOptions) => stubTool("video_generate", background)),
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
function expectOptions(mock: Mock, options: object, ...rest: unknown[]) {
  expect(mock).toHaveBeenLastCalledWith(expect.objectContaining(options), ...rest);
}
const channelCaller = {
  kind: "channel",
  channel: "discord",
  accountId: "delivery",
  senderId: "requester",
};
const cronKey = "agent:main:cron:daily-media";
const cronRunKey = `${cronKey}:run:run-123`;
const qaKey = "agent:main:qa-channel:default:direct:media-requester";
const mediaModel = { primary: "fixture/model" };

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  vi.clearAllMocks();
});
afterEach(() => clearRuntimeConfigSnapshot());

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
  expectOptions(mocks.textToSpeech, {
    text: "hello from reader",
    agentId: "reader",
    channel: "feishu",
    accountId: "feishu-main",
  });
  expect(mocks.textToSpeech.mock.calls[0]?.[0].cfg).toBe(config);
});

it.each([
  ["delivery account", {}, { caller: expect.objectContaining(channelCaller) }],
  ["missing channel", { gatewayCallerChannel: null }, { callerUnavailable: true }],
  ["local caller", { gatewayCallerLocal: true }, { callerUnavailable: true }],
  [
    "local schedule",
    { gatewayCallerLocal: true, gatewayCallerScheduled: true },
    { caller: { kind: "operator", source: "scheduled" } },
  ],
] as const)("constructs transcripts with %s provenance", (scenario, options, expected) => {
  createTools({
    agentChannel: "discord",
    agentAccountId: "delivery",
    gatewayCallerAccountId: scenario === "delivery account" ? undefined : "creator",
    requesterSenderId: scenario === "local schedule" ? undefined : "requester",
    ...options,
  });
  expectOptions(mocks.transcripts, expected);
  if (scenario === "missing channel") {
    expect(mocks.transcripts.mock.lastCall?.[0]).not.toHaveProperty("caller");
  }
});

it.each([
  [cronKey, cronRunKey, cronRunKey],
  [qaKey, "agent:main:main", qaKey],
  ["agent:main:policy", "agent:work:run", "agent:main:policy"],
])(
  "passes a separate durable requester key for background media from %s",
  async (agentSessionKey, runSessionKey, taskSessionKey) => {
    await createOpenClawToolsAsync({
      disableMessageTool: true,
      disablePluginTools: true,
      authProfileStore: { version: 1, profiles: {} },
      config: {
        agents: {
          entries: { main: {}, work: {} },
          defaults: { mediaModels: { image: mediaModel, music: mediaModel, video: mediaModel } },
        },
      },
      agentSessionKey,
      sandboxAgentId: "main",
      sandboxed: true,
      runSessionKey,
      onYield: vi.fn(),
    });
    const expectedOptions = {
      agentSessionKey: taskSessionKey,
      requesterRunSessionKey: runSessionKey,
      sandboxSessionKey: agentSessionKey,
      sandboxAgentId: "main",
      requesterAgentId: runSessionKey.startsWith("agent:work:") ? "work" : "main",
    };
    for (const factory of [mocks.image, mocks.video, mocks.music]) {
      expectOptions(factory, expectedOptions, true);
    }
  },
);

it.each([
  [
    "channel delivery",
    {
      agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
      agentChannel: "matrix",
      agentAccountId: "bot-a",
      agentTo: "room:!FallbackRoom:Example.Org",
      agentThreadId: "$FallbackThread:Example.Org",
      currentChannelId: "room:!AbCdEf1234567890:example.org",
      currentThreadTs: "$RootEvent:Example.Org",
    },
    {
      currentDeliveryContext: {
        channel: "matrix",
        to: "room:!AbCdEf1234567890:example.org",
        accountId: "bot-a",
        threadId: "$RootEvent:Example.Org",
      },
    },
  ],
  [
    "self-remove scope",
    {
      agentSessionKey: "agent:main:cron:job-current",
      cronSelfRemoveOnlyJobId: "job-current",
    },
    {
      agentSessionKey: "agent:main:cron:job-current",
      selfRemoveOnlyJobId: "job-current",
    },
  ],
] as const)("passes %s into cron", (_name, options, expected) => {
  createTools(options);
  expectOptions(mocks.cron, expected);
});
