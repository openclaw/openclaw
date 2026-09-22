import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { CommandInteraction } from "../internal/discord.js";
import { createDiscordVoiceCommand } from "./command.js";
import { createDiscordRecordingFixture } from "./transcripts-recording.test-support.js";
import { discordVoiceTranscriptsSourceProvider } from "./transcripts-source.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

const OWNER = "100000000000000001";
const unavailable = {
  text: undefined,
  decision: {
    capability: "audio",
    outcome: "skipped",
    attachments: [{ attachmentIndex: 0, attempts: [] }],
    attachmentDispositions: { 0: { kind: "no-model" } },
    attachmentProcessing: { 0: "omitted" },
  },
} satisfies Awaited<ReturnType<PluginRuntime["mediaUnderstanding"]["transcribeAudioFile"]>>;

defineDiscordVoiceTests((harness) => {
  const {
    expect,
    it,
    vi,
    startTranscripts,
    stopTranscripts,
    transcribeAudioFileMock,
    lastRealtimeBridgeParams,
    emitFinalRealtimeUserTranscript,
    agentCommandMock,
    realtimeSessionMock,
    resolveVoiceIngressWithParticipantsMock,
  } = harness;
  const fixture = createDiscordRecordingFixture(harness);

  it.each(["resolve", "reject", "synchronous"] as const)(
    "retains final recording through provider close (%s) before completing leave",
    async (completion) => {
      const f = await fixture();
      transcribeAudioFileMock.mockResolvedValue(unavailable);
      await startTranscripts(f.manager, f.sink);
      await f.audio(OWNER, 1);
      const provider = lastRealtimeBridgeParams();
      const closed = createDeferred<void>();
      const stored = createDeferred<void>();
      f.sink.mockImplementationOnce(() => stored.promise);
      realtimeSessionMock.close.mockImplementationOnce(() => {
        if (completion === "synchronous") {
          provider.onTranscript?.("user", "Final meeting note.", true);
          provider.onTranscript?.("user", "Second final note.", true);
          return undefined;
        }
        return closed.promise;
      });
      const closeConversation = vi.spyOn(f.entry.conversations, "close");
      const stopPlayback = vi.spyOn(f.entry.player, "stop");
      const leave = f.manager.leave({ guildId: "g1" });
      const finished = vi.fn();
      void leave.then(finished);
      try {
        expect(f.manager.status()).toEqual([]);
        expect(f.entry.sessionLifecycle.status).toBe("stopped");
        expect(stopPlayback).toHaveBeenCalledWith(true);
        expect(closeConversation).not.toHaveBeenCalled();
        void f.entry.stop();
        expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
        if (completion !== "synchronous") {
          provider.onTranscript?.("user", "Final meeting note.", true);
          provider.onTranscript?.("user", "Second final note.", true);
        }
        expect(f.sink).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: "Final meeting note." }),
        );
        expect(agentCommandMock).not.toHaveBeenCalled();
        if (completion === "reject") {
          closed.reject(new Error("Provider close failed"));
        } else {
          closed.resolve();
        }
        await Promise.resolve();
        expect(finished).not.toHaveBeenCalled();
        expect(closeConversation).not.toHaveBeenCalled();
      } finally {
        closed.resolve();
        stored.resolve();
        await leave;
      }
      expect(f.sink.mock.calls.map(([utterance]) => utterance.text)).toEqual([
        "Final meeting note.",
        "Second final note.",
      ]);
      expect(closeConversation).toHaveBeenCalledOnce();
      provider.onTranscript?.("user", "After close.", true);
      expect(f.sink).toHaveBeenCalledTimes(2);
      await f.manager.destroy();
    },
  );

  it("does not hold shutdown for realtime finals whose batch eligibility is unresolved", async () => {
    const f = await fixture();
    const batch = createDeferred<void>();
    transcribeAudioFileMock.mockImplementationOnce(async () => {
      await batch.promise;
      return unavailable;
    });
    await startTranscripts(f.manager, f.sink);
    let leaving: ReturnType<typeof f.manager.leave> | undefined;
    try {
      const receiving = f.begin(OWNER);
      await vi.waitFor(() => expect(f.streams.has(OWNER)).toBe(true));
      f.streams.get(OWNER)!.end(Buffer.alloc(96_000, 1));
      await receiving;
      await vi.waitFor(() => expect(transcribeAudioFileMock).toHaveBeenCalledOnce());
      await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "Unproven final.");
      expect(f.sink).not.toHaveBeenCalled();
      const conversationClosed = vi.spyOn(f.entry.conversations, "close");
      leaving = f.manager.leave({ guildId: "g1" });
      expect(conversationClosed).toHaveBeenCalledOnce();
    } finally {
      batch.resolve();
      await f.entry.processingQueue;
      await leaving;
      await f.manager.destroy();
    }
    expect(f.sink).not.toHaveBeenCalled();
  });

  it("waits for a detached room's provider when the manager is destroyed", async () => {
    const f = await fixture();
    transcribeAudioFileMock.mockResolvedValue(unavailable);
    await startTranscripts(f.manager, f.sink);
    await f.audio(OWNER, 1);
    const provider = lastRealtimeBridgeParams();
    const closed = createDeferred<void>();
    realtimeSessionMock.close.mockReturnValueOnce(closed.promise);
    const stopped = f.entry.stop();
    const destroyed = f.manager.destroy();
    const finished = vi.fn();
    void destroyed.then(finished);
    try {
      await Promise.resolve();
      expect(finished).not.toHaveBeenCalled();
      provider.onTranscript?.("user", "Detached room final.", true);
      expect(f.sink).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Detached room final." }),
      );
    } finally {
      closed.resolve();
      await stopped;
      await destroyed;
    }
    expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
  });

  it.each(["agent-proxy", "bidi"] as const)(
    "retains fully bound %s recording and exposes limited coverage through vc status",
    async (mode) => {
      const f = await fixture(mode);
      transcribeAudioFileMock.mockResolvedValue(unavailable);
      expect(await startTranscripts(f.manager, f.sink)).toMatchObject({ ok: true });
      await f.audio(OWNER, 1);
      await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "Keep the meeting note.");
      expect(f.sink).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          text: "Keep the meeting note.",
          speaker: { id: OWNER, label: "Owner" },
        }),
      );
      expect(agentCommandMock).not.toHaveBeenCalled();
      const reply = vi.fn();
      const command = createDiscordVoiceCommand({
        cfg: {},
        discordConfig: {},
        accountId: "default",
        groupPolicy: "open",
        useAccessGroups: false,
        getManager: () => f.manager,
        ephemeralDefault: true,
      });
      await command.run({
        guild: { id: "g1", name: "Guild" },
        user: { id: OWNER, username: "owner" },
        rawData: { data: { options: [{ name: "status", type: 1 }] }, member: { roles: [] } },
        defer: vi.fn(),
        reply,
      } as unknown as CommandInteraction);
      expect(reply).toHaveBeenCalledWith({
        content: expect.stringContaining("only safely bound realtime finals can be recorded"),
        ephemeral: true,
      });
    },
  );

  it("preserves realtime-only capture when batch audio is explicitly disabled", async () => {
    const cfg = {
      channels: { discord: { token: "test-token", voice: { enabled: true } } },
      tools: { media: { audio: { enabled: false } } },
    };
    const f = await fixture("agent-proxy", false, cfg);
    await startTranscripts(f.manager, f.sink);
    expect(
      await discordVoiceTranscriptsSourceProvider.start!({
        cfg,
        onUtterance: f.sink,
        session: {
          sessionId: "notes-1",
          startedAt: new Date().toISOString(),
          source: {
            providerId: "discord-voice",
            accountId: "default",
            guildId: "g1",
            channelId: "1001",
          },
        },
      }),
    ).toMatchObject({ ok: true });
    await f.audio(OWNER, 1);
    await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "Realtime-only note.");
    expect(f.sink).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "Realtime-only note." }),
    );
    expect(transcribeAudioFileMock).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "silent", "transcribed"] as const)(
    "holds an early realtime final until the batch result settles as %s",
    async (outcome) => {
      const f = await fixture();
      const pending = createDeferred<void>();
      transcribeAudioFileMock.mockImplementation(async () => {
        await pending.promise;
        return outcome === "unavailable"
          ? unavailable
          : outcome === "silent"
            ? {
                ...unavailable,
                decision: {
                  ...unavailable.decision,
                  attachmentDispositions: { 0: { kind: "failed" } },
                  attachmentProcessing: { 0: "completed" },
                },
              }
            : { text: "Batch note." };
      });
      await startTranscripts(f.manager, f.sink);
      const receiving = f.begin(OWNER);
      f.streams.get(OWNER)!.end(Buffer.alloc(96_000, 1));
      await receiving;
      try {
        await vi.waitFor(() => expect(transcribeAudioFileMock).toHaveBeenCalledOnce());
        await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "Realtime note.");
        expect(f.sink).not.toHaveBeenCalled();
      } finally {
        pending.resolve();
        await f.entry.processingQueue;
        await Promise.all(f.conversations.mock.results.map((result) => result.value));
      }
      await vi.waitFor(() =>
        expect(f.sink.mock.calls.map(([utterance]) => utterance.text)).toEqual(
          outcome === "unavailable"
            ? ["Realtime note."]
            : outcome === "transcribed"
              ? ["Batch note."]
              : [],
        ),
      );
      await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "Late duplicate.");
      expect(f.sink).toHaveBeenCalledTimes(
        outcome === "unavailable" ? 2 : outcome === "transcribed" ? 1 : 0,
      );
    },
  );

  it.each(["failure", "oversized", "unknown-omitted"] as const)(
    "does not reinterpret %s batch input as unavailable",
    async (outcome) => {
      const f = await fixture();
      if (outcome === "failure") {
        transcribeAudioFileMock.mockRejectedValue(new Error("Transcription failed"));
      } else {
        transcribeAudioFileMock.mockResolvedValue({
          text: undefined,
          decision: {
            ...unavailable.decision,
            attachments:
              outcome === "oversized"
                ? [
                    {
                      attachmentIndex: 0,
                      attempts: [
                        { type: "provider", outcome: "skipped", reason: "maxBytes exceeded" },
                      ],
                    },
                  ]
                : unavailable.decision.attachments,
            attachmentDispositions:
              outcome === "oversized"
                ? { 0: { kind: "failed", reason: "maxBytes exceeded" } }
                : undefined,
          },
        });
      }
      await startTranscripts(f.manager, f.sink);
      await f.audio(OWNER, 1);
      await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "Unproven note.");
      expect(f.sink).not.toHaveBeenCalled();
    },
  );

  it.each(["same", "replaced"] as const)(
    "keeps %s capture receipts across delayed conversation authorization",
    async (captureState) => {
      const f = await fixture();
      const pending = createDeferred<void>();
      const finishedInputs = vi.spyOn(f.entry.conversations, "finishAudio");
      const { resolveDiscordVoiceIngressContextWithParticipants: original } = await vi.importActual<
        typeof import("./participant-context.js")
      >("./participant-context.js");
      resolveVoiceIngressWithParticipantsMock.mockImplementation(
        async (...args: Parameters<typeof original>) => {
          await pending.promise;
          return await original(...args);
        },
      );
      transcribeAudioFileMock.mockResolvedValue(unavailable);
      await startTranscripts(f.manager, f.sink);
      const receiving = f.begin(OWNER);
      f.streams.get(OWNER)!.end(Buffer.alloc(96_000, 1));
      await receiving;
      const replacement = vi.fn();
      try {
        await f.entry.processingQueue;
        expect(realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
        if (captureState === "replaced") {
          await startTranscripts(f.manager, replacement, "notes-2");
        }
      } finally {
        pending.resolve();
        await Promise.all(finishedInputs.mock.results.map((result) => result.value));
      }
      expect(realtimeSessionMock.sendAudio).toHaveBeenCalled();
      await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "Old capture note.");
      expect(f.sink).toHaveBeenCalledTimes(captureState === "same" ? 1 : 0);
      expect(replacement).not.toHaveBeenCalled();
      await f.audio(OWNER, 2);
      await emitFinalRealtimeUserTranscript(lastRealtimeBridgeParams(), "New capture note.");
      const currentSink = captureState === "same" ? f.sink : replacement;
      expect(currentSink).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "New capture note." }),
      );
    },
  );

  it.each(["start", "replace", "continuity reset"] as const)(
    "rejects ambiguous input spanning capture %s and recovers on a fresh connection",
    async (transition) => {
      const f = await fixture();
      transcribeAudioFileMock.mockResolvedValue(unavailable);
      if (transition !== "start") {
        await startTranscripts(f.manager, f.sink);
      }
      const receiving = f.begin(OWNER);
      await vi.waitFor(() => expect(f.streams.has(OWNER)).toBe(true));
      const stream = f.streams.get(OWNER)!;
      stream.write(Buffer.alloc(96_000, 1));
      await vi.waitFor(() => expect(realtimeSessionMock.sendAudio).toHaveBeenCalled());
      const oldBridge = lastRealtimeBridgeParams();
      const replacement = vi.fn();
      if (transition === "continuity reset") {
        oldBridge.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      } else {
        await startTranscripts(f.manager, replacement, "notes-2");
      }
      stream.end(Buffer.alloc(96_000, 2));
      await receiving;
      await f.entry.processingQueue;
      await Promise.all(f.conversations.mock.results.map((result) => result.value));
      await emitFinalRealtimeUserTranscript(oldBridge, "Mixed note.");
      expect(f.sink).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
      if (transition === "continuity reset") {
        await stopTranscripts();
        await startTranscripts(f.manager, replacement, "notes-2");
      }
      await f.audio(OWNER, 3);
      const nextBridge = lastRealtimeBridgeParams();
      expect(nextBridge).not.toBe(oldBridge);
      await emitFinalRealtimeUserTranscript(oldBridge, "Late old note.");
      await emitFinalRealtimeUserTranscript(nextBridge, "Fresh note.");
      expect(replacement).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Fresh note." }),
      );
    },
  );

  it.each(["count", "bytes"] as const)(
    "bounds pending realtime final %s including a blocked publication",
    async (bound) => {
      const f = await fixture();
      transcribeAudioFileMock.mockResolvedValue(unavailable);
      await startTranscripts(f.manager, f.sink);
      await f.audio(OWNER, 1);
      const pending = createDeferred<void>();
      f.sink.mockImplementationOnce(() => pending.promise);
      const bridge = lastRealtimeBridgeParams();
      try {
        bridge.onTranscript?.("user", "first", true);
        expect(f.sink).toHaveBeenCalledOnce();
        if (bound === "count") {
          for (let i = 0; i < 1_000; i++) {
            bridge.onTranscript?.("user", "queued", true);
          }
        } else {
          bridge.onTranscript?.("user", "x".repeat(1024 * 1024 - 4), true);
        }
      } finally {
        pending.resolve();
      }
      await emitFinalRealtimeUserTranscript(bridge, "After overflow.");
      expect(f.sink).toHaveBeenCalledOnce();
    },
  );
});
