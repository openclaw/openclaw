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

vi.mock("./app-server/sandbox-guard.js", () => ({
  resolveCodexNativeExecutionBlock: vi.fn(() => undefined),
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
  conversationId: "group-1",
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

const currentBinding = {
  threadId: "thread-1",
  clientId: "client-1",
  cwd: "/tmp/workspace",
};

const bindingStore = {
  read: vi.fn(() => currentBinding),
} as unknown as CodexAppServerBindingStore;

function voiceEvent(path: string): PluginHookInboundClaimEvent {
  return {
    content: "",
    bodyForAgent: "",
    channel: "telegram",
    isGroup: true,
    commandAuthorized: true,
    senderIsOwner: true,
    sessionKey: "agent:main:telegram:group:codex-bind",
    media: [{ path, contentType: "audio/ogg", kind: "audio", workspaceDir: "/tmp/workspace" }],
  };
}

async function runVoiceClaim(params: {
  path: string;
  runMediaUnderstandingFile: NonNullable<
    Parameters<typeof handleCodexConversationInboundClaim>[2]["runMediaUnderstandingFile"]
  >;
}) {
  const event = voiceEvent(params.path);
  const result = await handleCodexConversationInboundClaim(
    event,
    {
      channelId: "telegram",
      sessionKey: event.sessionKey,
      pluginBinding,
    },
    {
      bindingStore,
      config: { tools: { media: { audio: { enabled: true } } } },
      runMediaUnderstandingFile: params.runMediaUnderstandingFile,
    },
  );
  const boundTurn = mocks.runBoundTurnWithMissingThreadRecovery.mock.calls[0]?.[0];
  return {
    result,
    boundTurn,
    input: buildCodexConversationTurnInput({
      prompt: boundTurn?.prompt ?? "",
      event,
      audioInputAttachmentIndexes: boundTurn?.audioInputAttachmentIndexes,
    }),
  };
}

describe("Codex conversation binding audio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveByConversation.mockReturnValue({ bindingId: "binding-1" });
    mocks.runBoundTurnWithMissingThreadRecovery.mockResolvedValue({ reply: { text: "done" } });
  });

  it("transcribes a voice-only bound message before starting the turn", async () => {
    const runMediaUnderstandingFile = vi.fn(async () => ({ text: "ship the fix" }));

    const { result, input } = await runVoiceClaim({
      path: "/tmp/voice.ogg",
      runMediaUnderstandingFile,
    });

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    expect(runMediaUnderstandingFile).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "audio",
        filePath: "/tmp/voice.ogg",
        workspaceDir: "/tmp/workspace",
        mime: "audio/ogg",
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
    ]);
  });

  it.each([
    {
      name: "configured STT rejects",
      path: "/tmp/voice.ogg",
      runMediaUnderstandingFile: async () => {
        throw new Error("transcriber unavailable");
      },
      prompt: "[Audio transcription failed; the original attachment is included when supported.]",
    },
    {
      name: "STT produces no text",
      path: "/tmp/silence.ogg",
      runMediaUnderstandingFile: async () => ({ text: undefined }),
      prompt:
        "[Audio transcription produced no text; the original attachment is included when supported.]",
    },
  ])("keeps the original attachment when $name", async (testCase) => {
    const { result, input } = await runVoiceClaim(testCase);

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    expect(input).toEqual([
      { type: "text", text: testCase.prompt, text_elements: [] },
      { type: "localAudio", path: testCase.path },
    ]);
  });
});
