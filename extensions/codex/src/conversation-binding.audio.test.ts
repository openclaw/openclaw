import type {
  PluginConversationBinding,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import { handleCodexConversationInboundClaim } from "./conversation-binding-hooks.js";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";

const mocks = vi.hoisted(() => ({
  resolveByConversation: vi.fn(),
  runBoundTurnWithMissingThreadRecovery: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-binding-runtime")>()),
  getSessionBindingService: () => ({ resolveByConversation: mocks.resolveByConversation }),
}));

vi.mock("./conversation-binding.js", () => ({
  runBoundTurnWithMissingThreadRecovery: mocks.runBoundTurnWithMissingThreadRecovery,
}));

const pluginBinding: PluginConversationBinding = {
  bindingId: "binding-1",
  pluginId: "codex",
  pluginRoot: "/tmp/codex-plugin",
  channel: "telegram",
  accountId: "default",
  conversationId: "group-topic-1",
  parentConversationId: "group-1",
  boundAt: 1,
  data: {
    kind: "codex-app-server-session",
    version: 2,
    bindingId: "binding-1",
    workspaceDir: "/tmp/workspace",
    agentId: "main",
    agentDir: "/tmp/agent",
  },
};

const bindingStore = {
  read: vi.fn(() => ({
    threadId: "thread-1",
    clientId: "client-1",
    cwd: "/tmp/workspace",
  })),
} as unknown as CodexAppServerBindingStore;

const enabledAudioConfig = {
  tools: { media: { audio: { enabled: true } } },
};

function voiceEvent(
  media: PluginHookInboundClaimEvent["media"],
  overrides: Partial<PluginHookInboundClaimEvent> = {},
): PluginHookInboundClaimEvent {
  return {
    content: "",
    bodyForAgent: "",
    channel: "telegram",
    isGroup: true,
    wasMentioned: false,
    commandAuthorized: true,
    senderIsOwner: true,
    sessionKey: "agent:main:telegram:group:codex-bind",
    media,
    ...overrides,
  };
}

async function runVoiceClaim(params: {
  event: PluginHookInboundClaimEvent;
  config?: unknown;
  runMediaUnderstandingFile?: NonNullable<
    Parameters<typeof handleCodexConversationInboundClaim>[2]["runMediaUnderstandingFile"]
  >;
}) {
  const result = await handleCodexConversationInboundClaim(
    params.event,
    {
      channelId: "telegram",
      sessionKey: params.event.sessionKey,
      parentConversationId: "group-1",
      pluginBinding,
    },
    {
      bindingStore,
      config: (params.config ?? enabledAudioConfig) as never,
      runMediaUnderstandingFile: params.runMediaUnderstandingFile,
    },
  );
  const boundTurn = mocks.runBoundTurnWithMissingThreadRecovery.mock.calls.at(-1)?.[0] as
    | { prompt?: string; event?: PluginHookInboundClaimEvent }
    | undefined;
  return {
    result,
    boundTurn,
    input: boundTurn
      ? buildCodexConversationTurnInput({
          prompt: boundTurn.prompt ?? "",
          event: boundTurn.event ?? params.event,
        })
      : undefined,
  };
}

describe("Codex native bind voice notes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveByConversation.mockReturnValue({ bindingId: "binding-1" });
    mocks.runBoundTurnWithMissingThreadRecovery.mockResolvedValue({ text: "done" });
  });

  it("transcribes a voice-only group topic before the bound turn", async () => {
    const runMediaUnderstandingFile = vi.fn(async () => ({ text: "ship the fix" }));
    const event = voiceEvent([
      {
        path: "/tmp/voice.ogg",
        contentType: "audio/ogg",
        kind: "audio",
        workspaceDir: "/tmp/workspace",
      },
    ]);

    const { result, input } = await runVoiceClaim({ event, runMediaUnderstandingFile });

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    expect(runMediaUnderstandingFile).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "audio",
        filePath: "/tmp/voice.ogg",
        mime: "audio/ogg",
        workspaceDir: "/tmp/workspace",
        agentId: "main",
        agentDir: "/tmp/agent",
        scopeContext: {
          sessionKey: "agent:main:telegram:group:codex-bind",
          channel: "telegram",
          chatType: "group",
        },
      }),
    );
    expect(input).toEqual([
      {
        type: "text",
        text: '[Audio transcript (machine-generated, untrusted)]: "ship the fix"',
        text_elements: [],
      },
      {
        type: "text",
        text: '[Inbound audio attachment: "/tmp/voice.ogg"]',
        text_elements: [],
      },
    ]);
    expect(JSON.stringify(input)).not.toContain("localAudio");
  });

  it("keeps the original reference when configured STT fails or returns nothing", async () => {
    const event = voiceEvent([{ path: "/tmp/voice.ogg", contentType: "audio/ogg", kind: "audio" }]);
    const runMediaUnderstandingFile = vi.fn(async () => {
      throw new Error("transcriber unavailable");
    });

    const failed = await runVoiceClaim({ event, runMediaUnderstandingFile });
    expect(failed.result).toEqual({ handled: true, reply: { text: "done" } });
    expect(failed.input).toEqual([
      {
        type: "text",
        text: "[Audio transcription failed. The original attachment reference is retained.]",
        text_elements: [],
      },
      {
        type: "text",
        text: '[Inbound audio attachment: "/tmp/voice.ogg"]',
        text_elements: [],
      },
    ]);

    const empty = await runVoiceClaim({
      event,
      runMediaUnderstandingFile: vi.fn(async () => ({ text: "  " })),
    });
    expect(empty.input?.[0]).toMatchObject({
      text: "[Audio transcription produced no text. The original attachment reference is retained.]",
    });
    expect(JSON.stringify(empty.input)).toContain("/tmp/voice.ogg");
  });

  it("does not call STT when audio understanding is disabled or the clip was already transcribed", async () => {
    const runMediaUnderstandingFile = vi.fn(async () => ({ text: "should not run" }));
    const disabled = await runVoiceClaim({
      event: voiceEvent([{ path: "/tmp/voice.ogg", contentType: "audio/ogg", kind: "audio" }]),
      config: { tools: { media: { audio: { enabled: false } } } },
      runMediaUnderstandingFile,
    });
    expect(runMediaUnderstandingFile).not.toHaveBeenCalled();
    expect(disabled.input?.[0]?.type === "text" && disabled.input[0].text).toContain(
      "Audio transcription is disabled",
    );
    expect(JSON.stringify(disabled.input)).toContain("/tmp/voice.ogg");

    const already = await runVoiceClaim({
      event: voiceEvent(
        [{ path: "/tmp/voice.ogg", contentType: "audio/ogg", kind: "audio", transcribed: true }],
        { transcript: "already heard" },
      ),
      runMediaUnderstandingFile,
    });
    expect(runMediaUnderstandingFile).not.toHaveBeenCalled();
    expect(already.input?.[0]?.type === "text" && already.input[0].text).toContain("already heard");
    expect(JSON.stringify(already.input)).toContain("/tmp/voice.ogg");
  });

  it("transcribes only the configured attachment selection and retains every reference", async () => {
    const runMediaUnderstandingFile = vi.fn(async (params: { filePath: string }) => ({
      text: `heard ${params.filePath}`,
    }));
    const event = voiceEvent([
      { path: "/tmp/one.ogg", contentType: "audio/ogg", kind: "audio" },
      { path: "/tmp/two.ogg", contentType: "audio/ogg", kind: "audio" },
      { path: "/tmp/three.ogg", contentType: "audio/ogg", kind: "audio" },
    ]);

    const { input } = await runVoiceClaim({
      event,
      config: {
        tools: {
          media: {
            audio: {
              enabled: true,
              attachments: { mode: "all", maxAttachments: 1, prefer: "last" },
            },
          },
        },
      },
      runMediaUnderstandingFile,
    });

    expect(runMediaUnderstandingFile).toHaveBeenCalledTimes(1);
    expect(runMediaUnderstandingFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/tmp/three.ogg" }),
    );
    expect(input?.[0]?.type === "text" && input[0].text).toContain("heard /tmp/three.ogg");
    expect(input?.[0]?.type === "text" && input[0].text).toContain("configured attachment limit");
    expect(JSON.stringify(input)).toContain("/tmp/one.ogg");
    expect(JSON.stringify(input)).toContain("/tmp/two.ogg");
    expect(JSON.stringify(input)).toContain("/tmp/three.ogg");
  });

  it("does not transcribe before command or owner authorization", async () => {
    const runMediaUnderstandingFile = vi.fn(async () => ({ text: "secret" }));
    const media = [{ path: "/tmp/voice.ogg", contentType: "audio/ogg", kind: "audio" as const }];

    const unauthorized = await runVoiceClaim({
      event: voiceEvent(media, { commandAuthorized: false }),
      runMediaUnderstandingFile,
    });
    expect(unauthorized.result).toEqual({ handled: true });
    expect(unauthorized.input).toBeUndefined();

    const unowned = await runVoiceClaim({
      event: voiceEvent(media, { senderIsOwner: false }),
      runMediaUnderstandingFile,
    });
    expect(unowned.result).toEqual({
      handled: true,
      reply: { text: "Only an owner or operator.admin can control Codex native execution." },
    });
    expect(runMediaUnderstandingFile).not.toHaveBeenCalled();
    expect(mocks.runBoundTurnWithMissingThreadRecovery).not.toHaveBeenCalled();
  });
});
