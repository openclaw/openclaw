import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "./runtime-api.js";
import { buildMonoWav } from "./voice-audio.js";
import { generateMattermostVoiceReply, processMattermostVoiceTurn } from "./voice-turn.js";

const cfg = {} as OpenClawConfig;
const runtime = {} as RuntimeEnv;

describe("Mattermost voice turn", () => {
  it("runs STT and a hidden agent turn before synthesizing the reply", async () => {
    const transcribe = vi.fn(async () => "what time is it");
    const runAgent = vi.fn(async () => ({ payloads: [{ text: "It is half past three." }] }));
    const synthesize = vi.fn(async () => ({ success: true, audioPath: "/tmp/reply.mp3" }));
    const result = await processMattermostVoiceTurn(
      {
        accountId: "default",
        agentId: "main",
        cfg,
        channelId: "dm-channel",
        runtime,
        samples: new Int16Array([1, 1, 2, 2, 3, 3]),
        sessionKey: "agent:main:main",
        userId: "human-user",
      },
      {
        withAudioFile: async (_samples, run) => await run("/tmp/input.wav"),
        transcribe,
        runAgent,
        synthesize,
      },
    );

    expect(transcribe).toHaveBeenCalledWith({
      agentId: "main",
      cfg,
      filePath: "/tmp/input.wav",
    });
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        agentId: "main",
        allowModelOverride: false,
        deliver: false,
        message: "what time is it",
        messageChannel: "mattermost",
        messageProvider: "mattermost-voice",
        sessionKey: "agent:main:main",
        transcriptMessage: "what time is it",
        runContext: expect.objectContaining({
          chatId: "dm-channel",
          currentChannelId: "dm-channel",
          currentInboundAudio: true,
          senderId: "human-user",
        }),
      }),
      runtime,
    );
    expect(synthesize).toHaveBeenCalledWith({
      cfg,
      text: "It is half past three.",
    });
    expect(result).toEqual({ audioPath: "/tmp/reply.mp3" });
  });

  it("passes abort signals to hidden agent voice turns", async () => {
    const controller = new AbortController();
    const runAgent = vi.fn(async () => ({ payloads: [{ text: "Sure." }] }));
    const synthesize = vi.fn(async () => ({ success: true, audioPath: "/tmp/reply.mp3" }));
    await generateMattermostVoiceReply(
      {
        accountId: "default",
        agentId: "main",
        abortSignal: controller.signal,
        cfg,
        channelId: "dm-channel",
        message: "hello",
        runtime,
        sessionKey: "agent:main:main",
        userId: "human-user",
      },
      {
        runAgent,
        synthesize,
      },
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: controller.signal,
        message: "hello",
      }),
      runtime,
    );
  });

  it("does not synthesize an error reply when the hidden agent voice turn is aborted", async () => {
    const controller = new AbortController();
    const synthesize = vi.fn();
    const result = await generateMattermostVoiceReply(
      {
        accountId: "default",
        agentId: "main",
        abortSignal: controller.signal,
        cfg,
        channelId: "dm-channel",
        message: "hello",
        runtime,
        sessionKey: "agent:main:main",
        userId: "human-user",
      },
      {
        runAgent: async () => {
          controller.abort();
          throw new Error("aborted");
        },
        synthesize,
      },
    );

    expect(result).toBeUndefined();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("strips markdown formatting before synthesizing voice replies", async () => {
    const synthesize = vi.fn(async () => ({ success: true, audioPath: "/tmp/reply.mp3" }));
    await processMattermostVoiceTurn(
      {
        accountId: "default",
        agentId: "main",
        cfg,
        channelId: "dm-channel",
        runtime,
        samples: new Int16Array([1, 1]),
        sessionKey: "agent:main:main",
        userId: "human-user",
      },
      {
        withAudioFile: async (_samples, run) => await run("/tmp/input.wav"),
        transcribe: async () => "tell me a pineapple fact",
        runAgent: async () => ({
          payloads: [
            {
              text: [
                "## Pineapple fact",
                "",
                "- **Pineapples** are [berries](https://example.com).",
                "- They use `CAM` photosynthesis.",
                "",
                "> That is *wild*.",
              ].join("\n"),
            },
          ],
        }),
        synthesize,
      },
    );

    expect(synthesize).toHaveBeenCalledWith({
      cfg,
      text: "Pineapple fact\nPineapples are berries.\nThey use CAM photosynthesis.\nThat is wild.",
    });
  });

  it("stops when STT returns no text", async () => {
    const runAgent = vi.fn();
    const synthesize = vi.fn();
    const result = await processMattermostVoiceTurn(
      {
        accountId: "default",
        agentId: "main",
        cfg,
        channelId: "dm-channel",
        runtime,
        samples: new Int16Array([1, 1]),
        sessionKey: "agent:main:main",
        userId: "human-user",
      },
      {
        withAudioFile: async (_samples, run) => await run("/tmp/input.wav"),
        transcribe: async () => "  ",
        runAgent,
        synthesize,
      },
    );

    expect(result).toBeUndefined();
    expect(runAgent).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("does not synthesize an empty agent response", async () => {
    const synthesize = vi.fn();
    const result = await processMattermostVoiceTurn(
      {
        accountId: "default",
        agentId: "main",
        cfg,
        channelId: "dm-channel",
        runtime,
        samples: new Int16Array([1, 1]),
        sessionKey: "agent:main:main",
        userId: "human-user",
      },
      {
        withAudioFile: async (_samples, run) => await run("/tmp/input.wav"),
        transcribe: async () => "hello",
        runAgent: async () => ({ payloads: [{ text: " " }] }),
        synthesize,
      },
    );

    expect(result).toBeUndefined();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("speaks one fixed error when the agent turn fails before producing content", async () => {
    const synthesize = vi.fn(async () => ({ success: true, audioPath: "/tmp/reply.mp3" }));
    const result = await processMattermostVoiceTurn(
      {
        accountId: "default",
        agentId: "main",
        cfg,
        channelId: "dm-channel",
        runtime,
        samples: new Int16Array([1, 1]),
        sessionKey: "agent:main:main",
        userId: "human-user",
      },
      {
        withAudioFile: async (_samples, run) => await run("/tmp/input.wav"),
        transcribe: async () => "hello",
        runAgent: async () => ({
          payloads: [
            { text: "[assistant turn failed before producing content]" },
            {
              text: [
                "[assistant turn failed before producing content]",
                "[assistant turn failed before producing content]",
              ].join("\n"),
            },
          ],
        }),
        synthesize,
      },
    );

    expect(synthesize).toHaveBeenCalledWith({
      cfg,
      text: "There was an error processing your request. Check the logs for more information.",
    });
    expect(result).toEqual({ audioPath: "/tmp/reply.mp3" });
  });

  it("speaks one fixed error when the agent result has an error payload", async () => {
    const synthesize = vi.fn(async () => ({ success: true, audioPath: "/tmp/reply.mp3" }));
    const result = await processMattermostVoiceTurn(
      {
        accountId: "default",
        agentId: "main",
        cfg,
        channelId: "dm-channel",
        runtime,
        samples: new Int16Array([1, 1]),
        sessionKey: "agent:main:main",
        userId: "human-user",
      },
      {
        withAudioFile: async (_samples, run) => await run("/tmp/input.wav"),
        transcribe: async () => "hello",
        runAgent: async () => ({
          payloads: [{ text: "LLM request failed.", isError: true }],
        }),
        synthesize,
      },
    );

    expect(synthesize).toHaveBeenCalledWith({
      cfg,
      text: "There was an error processing your request. Check the logs for more information.",
    });
    expect(result).toEqual({ audioPath: "/tmp/reply.mp3" });
  });

  it("speaks one fixed error when the agent result has run-level error metadata", async () => {
    const synthesize = vi.fn(async () => ({ success: true, audioPath: "/tmp/reply.mp3" }));
    const result = await processMattermostVoiceTurn(
      {
        accountId: "default",
        agentId: "main",
        cfg,
        channelId: "dm-channel",
        runtime,
        samples: new Int16Array([1, 1]),
        sessionKey: "agent:main:main",
        userId: "human-user",
      },
      {
        withAudioFile: async (_samples, run) => await run("/tmp/input.wav"),
        transcribe: async () => "hello",
        runAgent: async () => ({
          payloads: [{ text: "Low level provider error." }],
          meta: { error: { kind: "provider_failure" } },
        }),
        synthesize,
      },
    );

    expect(synthesize).toHaveBeenCalledWith({
      cfg,
      text: "There was an error processing your request. Check the logs for more information.",
    });
    expect(result).toEqual({ audioPath: "/tmp/reply.mp3" });
  });

  it("speaks one fixed error when the agent turn rejects", async () => {
    const synthesize = vi.fn(async () => ({ success: true, audioPath: "/tmp/reply.mp3" }));
    const result = await processMattermostVoiceTurn(
      {
        accountId: "default",
        agentId: "main",
        cfg,
        channelId: "dm-channel",
        runtime,
        samples: new Int16Array([1, 1]),
        sessionKey: "agent:main:main",
        userId: "human-user",
      },
      {
        withAudioFile: async (_samples, run) => await run("/tmp/input.wav"),
        transcribe: async () => "hello",
        runAgent: async () => {
          throw new Error("provider rejected");
        },
        synthesize,
      },
    );

    expect(synthesize).toHaveBeenCalledWith({
      cfg,
      text: "There was an error processing your request. Check the logs for more information.",
    });
    expect(result).toEqual({ audioPath: "/tmp/reply.mp3" });
  });

  it("does not treat successful replies that mention the legacy error marker as failures", async () => {
    const synthesize = vi.fn(async () => ({ success: true, audioPath: "/tmp/reply.mp3" }));
    const result = await processMattermostVoiceTurn(
      {
        accountId: "default",
        agentId: "main",
        cfg,
        channelId: "dm-channel",
        runtime,
        samples: new Int16Array([1, 1]),
        sessionKey: "agent:main:main",
        userId: "human-user",
      },
      {
        withAudioFile: async (_samples, run) => await run("/tmp/input.wav"),
        transcribe: async () => "what was the error",
        runAgent: async () => ({
          payloads: [
            {
              text: "The marker [assistant turn failed before producing content] means the previous turn failed.",
            },
          ],
        }),
        synthesize,
      },
    );

    expect(synthesize).toHaveBeenCalledWith({
      cfg,
      text: "The marker [assistant turn failed before producing content] means the previous turn failed.",
    });
    expect(result).toEqual({ audioPath: "/tmp/reply.mp3" });
  });

  it("returns synthesized WAV duration for playback timeout budgeting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mattermost-voice-turn-"));
    try {
      const audioPath = join(dir, "reply.wav");
      writeFileSync(audioPath, buildMonoWav(new Int16Array(16_000), 16_000));
      const result = await processMattermostVoiceTurn(
        {
          accountId: "default",
          agentId: "main",
          cfg,
          channelId: "dm-channel",
          runtime,
          samples: new Int16Array([1, 1]),
          sessionKey: "agent:main:main",
          userId: "human-user",
        },
        {
          withAudioFile: async (_samples, run) => await run("/tmp/input.wav"),
          transcribe: async () => "hello",
          runAgent: async () => ({ payloads: [{ text: "hello back" }] }),
          synthesize: async () => ({ success: true, audioPath }),
        },
      );

      expect(result).toEqual({ audioPath, durationMilliseconds: 1000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
