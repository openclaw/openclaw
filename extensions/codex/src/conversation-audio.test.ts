// Codex tests cover configured transcription for conversation-bound audio.
import { describe, expect, it, vi } from "vitest";
import { prepareCodexConversationAudioPrompt } from "./conversation-audio.js";

const config = { tools: { media: { audio: { enabled: true } } } };
const allAudioConfig = {
  tools: {
    media: { audio: { enabled: true, attachments: { mode: "all" as const, maxAttachments: 4 } } },
  },
};
function audioEvent(overrides: Record<string, unknown> = {}) {
  return {
    content: "",
    channel: "telegram",
    isGroup: true,
    media: [
      {
        path: "/tmp/voice.ogg",
        contentType: "audio/ogg",
        kind: "audio" as const,
      },
    ],
    ...overrides,
  };
}

function preparedAudio(prompt: string, audioInputAttachmentIndexes: number[] = []) {
  return {
    prompt,
    audioInputAttachmentIndexes,
  };
}

describe("Codex conversation audio", () => {
  it("appends configured STT output for every captioned audio attachment", async () => {
    const runMediaUnderstandingFile = vi.fn(async ({ filePath }: { filePath: string }) => ({
      text: filePath.endsWith("voice.ogg") ? 'say "hello"' : "second clip",
    }));

    await expect(
      prepareCodexConversationAudioPrompt({
        prompt: "Please summarize this.",
        event: audioEvent({
          media: [
            { contentType: "audio/ogg", kind: "audio" },
            { path: "/tmp/voice.ogg", contentType: "audio/ogg", kind: "audio" },
            { path: "/tmp/clip.mp3", contentType: "audio/mpeg", kind: "audio" },
          ],
        }),
        config: allAudioConfig,
        agentId: "main",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        sessionKey: "agent:main:telegram:group",
        runMediaUnderstandingFile,
      }),
    ).resolves.toEqual(
      preparedAudio(
        'Please summarize this.\n\n[Audio 1/2]\n[Audio transcript (machine-generated, untrusted)]: "say \\"hello\\""\n\n[Audio 2/2]\n[Audio transcript (machine-generated, untrusted)]: "second clip"',
      ),
    );
    expect(runMediaUnderstandingFile).toHaveBeenNthCalledWith(1, {
      capability: "audio",
      filePath: "/tmp/voice.ogg",
      cfg: allAudioConfig,
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      mime: "audio/ogg",
      scopeContext: {
        sessionKey: "agent:main:telegram:group",
        channel: "telegram",
        chatType: "group",
      },
    });
    expect(runMediaUnderstandingFile).toHaveBeenNthCalledWith(2, {
      capability: "audio",
      filePath: "/tmp/clip.mp3",
      cfg: allAudioConfig,
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      mime: "audio/mpeg",
      scopeContext: {
        sessionKey: "agent:main:telegram:group",
        channel: "telegram",
        chatType: "group",
      },
    });
  });

  it("applies configured attachment ordering before invoking the file runtime", async () => {
    const runMediaUnderstandingFile = vi.fn(async ({ filePath }: { filePath: string }) => ({
      text: filePath,
    }));

    await expect(
      prepareCodexConversationAudioPrompt({
        prompt: "",
        event: audioEvent({
          media: [
            { path: "/tmp/first.ogg", kind: "audio" },
            { path: "/tmp/last.ogg", kind: "audio" },
          ],
        }),
        config: {
          tools: {
            media: { audio: { attachments: { mode: "first", prefer: "last" } } },
          },
        },
        runMediaUnderstandingFile,
      }),
    ).resolves.toEqual(
      preparedAudio('[Audio transcript (machine-generated, untrusted)]: "/tmp/last.ogg"'),
    );
    expect(runMediaUnderstandingFile).toHaveBeenCalledTimes(1);
    expect(runMediaUnderstandingFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/tmp/last.ogg" }),
    );
  });

  it("applies URL preference and max attachment count across the message", async () => {
    const runMediaUnderstandingFile = vi.fn(async ({ filePath }: { filePath: string }) => ({
      text: filePath,
    }));

    await expect(
      prepareCodexConversationAudioPrompt({
        prompt: "",
        event: audioEvent({
          media: [
            { path: "/tmp/local.ogg", kind: "audio" },
            {
              path: "/tmp/staged-first.ogg",
              url: "https://example.test/first.ogg",
              kind: "audio",
            },
            { url: "https://example.test/second.ogg", kind: "audio" },
          ],
        }),
        config: {
          tools: {
            media: {
              audio: { attachments: { mode: "all", maxAttachments: 2, prefer: "url" } },
            },
          },
        },
        runMediaUnderstandingFile,
      }),
    ).resolves.toEqual(
      preparedAudio(
        '[Audio 1/2]\n[Audio transcript (machine-generated, untrusted)]: "/tmp/staged-first.ogg"\n\n[Audio 2/2]\n[Audio transcript (machine-generated, untrusted)]: "https://example.test/second.ogg"',
      ),
    );
    expect(runMediaUnderstandingFile).toHaveBeenCalledTimes(2);
  });

  it("does not transcribe an attachment already handled by channel preflight", async () => {
    const runMediaUnderstandingFile = vi.fn();

    await expect(
      prepareCodexConversationAudioPrompt({
        prompt: '[Audio transcript (machine-generated, untrusted)]: "already done"',
        event: audioEvent({
          transcript: "already done",
          media: [{ path: "/tmp/voice.ogg", kind: "audio", transcribed: true }],
        }),
        config,
        runMediaUnderstandingFile,
      }),
    ).resolves.toEqual(
      preparedAudio('[Audio transcript (machine-generated, untrusted)]: "already done"'),
    );
    expect(runMediaUnderstandingFile).not.toHaveBeenCalled();
  });

  it.each(["application/octet-stream", "image/jpeg"])(
    "uses canonical audio kind when staged media has conflicting MIME metadata: %s",
    async (contentType) => {
      const runMediaUnderstandingFile = vi.fn(async () => ({ text: "extensionless voice" }));

      await expect(
        prepareCodexConversationAudioPrompt({
          prompt: "",
          event: audioEvent({
            media: [
              {
                path: "/tmp/staged-voice",
                contentType,
                kind: "audio",
              },
            ],
          }),
          config,
          runMediaUnderstandingFile,
        }),
      ).resolves.toEqual(
        preparedAudio('[Audio transcript (machine-generated, untrusted)]: "extensionless voice"'),
      );
      expect(runMediaUnderstandingFile).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: "/tmp/staged-voice", mime: "audio/*" }),
      );
    },
  );

  it("keeps an explicit fallback and original attachment when STT produces no transcript", async () => {
    const runMediaUnderstandingFile = vi.fn(async () => ({ text: undefined }));

    await expect(
      prepareCodexConversationAudioPrompt({
        prompt: "[media attached: /tmp/voice.ogg]",
        event: audioEvent(),
        config,
        runMediaUnderstandingFile,
      }),
    ).resolves.toEqual(
      preparedAudio(
        "[media attached: /tmp/voice.ogg]\n\n[Audio transcription produced no text; the original attachment is included when supported.]",
        [0],
      ),
    );
  });

  it("keeps an explicit fallback and original attachment when STT rejects", async () => {
    await expect(
      prepareCodexConversationAudioPrompt({
        prompt: "caption",
        event: audioEvent(),
        config,
        runMediaUnderstandingFile: async () => {
          throw new Error("transcriber unavailable");
        },
      }),
    ).resolves.toEqual(
      preparedAudio(
        "caption\n\n[Audio transcription failed; the original attachment is included when supported.]",
        [0],
      ),
    );
  });

  it("keeps fallback indexes in configured selected order", async () => {
    await expect(
      prepareCodexConversationAudioPrompt({
        prompt: "",
        event: audioEvent({
          media: [
            { path: "/tmp/first.ogg", kind: "audio" },
            { path: "/tmp/last.ogg", kind: "audio" },
          ],
        }),
        config: {
          tools: {
            media: {
              audio: { attachments: { mode: "all", maxAttachments: 2, prefer: "last" } },
            },
          },
        },
        runMediaUnderstandingFile: async ({ filePath }) => {
          if (filePath.endsWith("first.ogg")) {
            throw new Error("transcriber unavailable");
          }
          return { text: undefined };
        },
      }),
    ).resolves.toEqual(
      preparedAudio(
        "[Audio 1/2]\n[Audio transcription produced no text; the original attachment is included when supported.]\n\n[Audio 2/2]\n[Audio transcription failed; the original attachment is included when supported.]",
        [1, 0],
      ),
    );
  });

  it("keeps protocol-supported data audio available for fallback", async () => {
    await expect(
      prepareCodexConversationAudioPrompt({
        prompt: "",
        event: audioEvent({
          media: [{ url: "data:audio/ogg;base64,T2dnUw==", kind: "audio" }],
        }),
      }),
    ).resolves.toEqual(
      preparedAudio(
        "[Audio transcription is unavailable; the original attachment is included when supported.]",
        [0],
      ),
    );
  });
});
