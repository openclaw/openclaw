import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PluginConversationBinding,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import { createConversationInspection } from "./app-server/session-binding.test-helpers.js";
import { handleCodexConversationInboundClaim } from "./conversation-binding-hooks.js";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";

const mocks = vi.hoisted(() => ({
  bindingId: vi.fn((): string | undefined => "binding-1"),
  runBoundTurnWithMissingThreadRecovery: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/conversation-binding-inspection-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("openclaw/plugin-sdk/conversation-binding-inspection-runtime")
    >();
  return {
    ...actual,
    inspectConversationBinding: (
      conversation: Parameters<typeof actual.inspectConversationBinding>[0],
    ) => createConversationInspection(conversation, mocks.bindingId()),
  };
});

vi.mock("./conversation-binding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./conversation-binding.js")>();
  return {
    ...actual,
    runBoundTurnWithMissingThreadRecovery: mocks.runBoundTurnWithMissingThreadRecovery,
  };
});

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

const threadBinding = {
  threadId: "thread-1",
  clientId: "client-1",
  cwd: "/tmp/workspace",
};
const bindingStore = {
  read: vi.fn(() => threadBinding),
  readAsync: vi.fn(async () => threadBinding),
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
    mocks.bindingId.mockReturnValue("binding-1");
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

  it("transcribes prefer:last clips in selected order and names skipped clips", async () => {
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
              attachments: { mode: "all", maxAttachments: 2, prefer: "last" },
            },
          },
        },
      },
      runMediaUnderstandingFile,
    });

    expect(runMediaUnderstandingFile.mock.calls.map((call) => call[0]?.filePath)).toEqual([
      "/tmp/three.ogg",
      "/tmp/two.ogg",
    ]);
    const text = input?.[0]?.type === "text" ? input[0].text : "";
    const third = text.indexOf("heard /tmp/three.ogg");
    const second = text.indexOf("heard /tmp/two.ogg");
    const skipped = text.indexOf(
      '[Audio transcription was skipped by the configured attachment limit. The original attachment reference is retained.]\n[Inbound audio attachment: "/tmp/one.ogg"]',
    );
    expect(third).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(third);
    expect(skipped).toBeGreaterThan(second);
    expect(text).not.toContain("heard /tmp/one.ogg");
  });

  it("passes an audio URL and classifying MIME for an opaque cached clip", async () => {
    const runMediaUnderstandingFile = vi.fn(async () => ({ text: "from the opaque clip" }));
    const event = voiceEvent([
      {
        path: "/tmp/opaque",
        url: "https://cdn.example.test/download/media.ogg",
        contentType: "application/octet-stream",
        kind: "audio",
      },
    ]);

    const { input } = await runVoiceClaim({ event, runMediaUnderstandingFile });

    expect(runMediaUnderstandingFile).toHaveBeenCalledTimes(1);
    const request = runMediaUnderstandingFile.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      capability: "audio",
      filePath: "/tmp/opaque",
      mediaUrl: "https://cdn.example.test/download/media.ogg",
      mime: "audio/*",
    });
    expect(request?.mime).not.toBe("application/octet-stream");
    expect(input?.[0]?.type === "text" && input[0].text).toContain("from the opaque clip");
    expect(JSON.stringify(input)).toContain("/tmp/opaque");
    expect(JSON.stringify(input)).not.toContain("localAudio");
  });

  it("runs a configured STT stub on the native bind path without changing image turns", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-voice-proof-"));
    const audioPath = path.join(root, "opaque-voice");
    const imagePath = path.join(root, "photo.png");
    const stubPath = path.join(root, "stt-stub.mjs");
    const markerPath = path.join(root, "stt-marker.txt");
    await fs.writeFile(audioPath, Buffer.alloc(2048, 7));
    await fs.writeFile(imagePath, Buffer.from("png-placeholder"));
    await fs.writeFile(
      stubPath,
      [
        'import { writeFileSync } from "node:fs";',
        "const marker = process.argv[2];",
        'const audio = process.argv[3] ?? "";',
        "writeFileSync(marker, audio);",
        'process.stdout.write("ship the fix\\n");',
        "",
      ].join("\n"),
    );
    const config = {
      tools: {
        media: {
          models: [
            {
              type: "cli" as const,
              command: process.execPath,
              args: [stubPath, markerPath, "{{AttachmentPath}}"],
              capabilities: ["audio" as const],
            },
          ],
          audio: { enabled: true },
        },
      },
    };

    const voice = await runVoiceClaim({
      event: voiceEvent([
        {
          path: audioPath,
          contentType: "application/octet-stream",
          kind: "audio",
          workspaceDir: root,
        },
      ]),
      config,
    });
    const heardPath = await fs.readFile(markerPath, "utf8");
    process.stdout.write(
      `\nVOICE_PROOF input=${JSON.stringify(voice.input)}\nVOICE_PROOF stt_path=${heardPath}\n`,
    );

    expect(voice.result).toEqual({ handled: true, reply: { text: "done" } });
    expect(heardPath).toBe(audioPath);
    expect(voice.input?.[0]).toEqual({
      type: "text",
      text: '[Audio transcript (machine-generated, untrusted)]: "ship the fix"',
      text_elements: [],
    });
    expect(JSON.stringify(voice.input)).toContain(audioPath);
    expect(JSON.stringify(voice.input)).not.toContain("localAudio");

    await fs.rm(markerPath);
    const image = await runVoiceClaim({
      event: voiceEvent([{ path: imagePath, contentType: "image/png", kind: "image" }], {
        content: "look",
        bodyForAgent: "look",
      }),
      config,
    });
    process.stdout.write(`IMAGE_PROOF input=${JSON.stringify(image.input)}\n`);
    expect(image.input).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: imagePath },
    ]);
    await expect(fs.access(markerPath)).rejects.toThrow();
  }, 30_000);
});
