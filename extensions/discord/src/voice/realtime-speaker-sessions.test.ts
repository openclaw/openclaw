import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    agentCommandMock,
    agentCommandArgsAt,
    beginSpeakerTurn,
    createJoinedAgentProxyFixture,
    createRealtimeSessionMock,
    createRealtimeVoiceBridgeSessionMock,
    emitFinalRealtimeUserTranscript,
    lastAgentCommandArgs,
    lastRealtimeBridge,
    realtimeBridgeAt,
    loggerWarnMock,
    sentUserMessages,
    createClient,
    startTranscripts,
    receiveRecordedSpeech,
    resolveConfiguredRealtimeVoiceProviderMock,
    resolveVoiceIngressWithParticipantsMock,
    createAgentProxyManager,
  }) => {
    const useNativeDelegation = () =>
      resolveConfiguredRealtimeVoiceProviderMock.mockReturnValue({
        provider: {
          id: "openai",
          capabilities: { supportsActivationNameGating: false, handlesAgentConsult: true },
        },
        providerConfig: { model: "gpt-live-1", voice: "marin" },
      });

    it("routes native Live delegations with each speaker's authority without duplicate transcript turns", async () => {
      useNativeDelegation();
      resolveVoiceIngressWithParticipantsMock.mockImplementation(async ({ userId }) => ({
        senderIsOwner: userId === "owner",
        speakerLabel: userId,
      }));
      agentCommandMock.mockResolvedValue({ payloads: [{ text: "Agenda checked." }] });
      const { entry, manager, bridgeParams } = await createJoinedAgentProxyFixture();
      try {
        expect(bridgeParams.autoRespondToAudio).toBe(true);
        beginSpeakerTurn(entry, {
          userId: "guest",
          senderIsOwner: false,
          speakerLabel: "guest",
        }).close();
        const guest = lastRealtimeBridge();
        beginSpeakerTurn(entry, {
          userId: "owner",
          senderIsOwner: true,
          speakerLabel: "owner",
        }).close();
        const owner = lastRealtimeBridge();
        await emitFinalRealtimeUserTranscript(guest.bridgeParams, "Read the agenda.");
        await emitFinalRealtimeUserTranscript(owner.bridgeParams, "Check the appointment.");
        expect(agentCommandMock).not.toHaveBeenCalled();
        for (const [index, source] of [guest, owner].entries()) {
          const signal = new AbortController().signal;
          const runner = source.bridgeParams.runAgentConsult;
          expect(runner).toBeTypeOf("function");
          await expect(runner!({ prompt: "Check my request", signal })).resolves.toEqual({
            text: "Agenda checked.",
          });
          expect(agentCommandArgsAt(index)).toMatchObject({
            senderIsOwner: index === 1,
            sessionKey: "discord:g1:c1",
            abortSignal: signal,
          });
        }
        await manager.destroy();
        await expect(guest.bridgeParams.runAgentConsult!({ prompt: "Stale task" })).rejects.toThrow(
          "closed",
        );
        expect(agentCommandMock).toHaveBeenCalledTimes(2);
      } finally {
        await manager.destroy();
      }
    });

    it("rejects native delegation when the admitted speaker loses owner authority", async () => {
      useNativeDelegation();
      const { entry, manager, bridgeParams } = await createJoinedAgentProxyFixture();
      try {
        beginSpeakerTurn(entry, { userId: "owner", senderIsOwner: true }).close();
        resolveVoiceIngressWithParticipantsMock.mockResolvedValue({
          senderIsOwner: false,
          speakerLabel: "owner",
        });
        const runner = bridgeParams.runAgentConsult;
        expect(runner).toBeTypeOf("function");
        await expect(
          runner!({ prompt: "Run my task", signal: new AbortController().signal }),
        ).rejects.toThrow("authorization changed");
        expect(agentCommandMock).not.toHaveBeenCalled();
      } finally {
        await manager.destroy();
      }
    });

    it.each([{ requireWakeName: true }, { consultPolicy: "always" as const }])(
      "rejects unsupported host turn policy for native Live: %j",
      async (realtime) => {
        useNativeDelegation();
        const manager = createAgentProxyManager(undefined, { voice: { realtime } });
        try {
          await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining("owns voice responses and delegation"),
          });
        } finally {
          await manager.destroy();
        }
      },
    );

    it("preserves immediate acknowledgments for installed providers with unscoped marks", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture();
      try {
        beginSpeakerTurn(entry).close();
        const source = lastRealtimeBridge();
        source.bridgeParams.audioSink.sendMark?.("legacy-mark");
        expect(source.session.acknowledgeMark).toHaveBeenCalledExactlyOnceWith("legacy-mark");
      } finally {
        await manager.destroy();
      }
    });

    it.each(["guest-first", "owner-first"] as const)(
      "keeps speaker authority and transcript labels with their input connections: %s",
      async (order) => {
        const client = createClient();
        client.fetchMember.mockImplementation(async (_guildId, userId) => ({
          nickname: userId === "guest" ? "Ada" : "Grace",
          roles: [],
          user: { id: userId },
        }));
        const { entry, manager } = await createJoinedAgentProxyFixture({
          client,
          config: { voice: { realtime: { requireWakeName: false } } },
        });
        const onUtterance = vi.fn();
        try {
          await startTranscripts(manager, onUtterance, "shared-room");
          beginSpeakerTurn(entry, {
            userId: "guest",
            speakerLabel: "Ada",
            senderIsOwner: false,
            extraSystemPrompt: "Guest room context.",
          }).close();
          const guest = lastRealtimeBridge();
          beginSpeakerTurn(entry, {
            userId: "owner",
            speakerLabel: "Grace",
            senderIsOwner: true,
            extraSystemPrompt: "Owner room context.",
          }).close();
          const owner = lastRealtimeBridge();
          const turns = [
            {
              source: guest,
              text: "Summarize the agenda.",
              id: "guest",
              label: "Ada",
              owner: false,
              prompt: "Guest room context.",
            },
            {
              source: owner,
              text: "Read the next appointment.",
              id: "owner",
              label: "Grace",
              owner: true,
              prompt: "Owner room context.",
            },
          ];
          if (order === "owner-first") {
            turns.reverse();
          }
          for (const [index, turn] of turns.entries()) {
            await emitFinalRealtimeUserTranscript(turn.source.bridgeParams, turn.text);
            expect(agentCommandArgsAt(index)).toMatchObject({
              senderIsOwner: turn.owner,
              extraSystemPrompt: turn.prompt,
              agentId: "agent-1",
              sessionKey: "discord:g1:c1",
            });
            expect(onUtterance).toHaveBeenCalledTimes(index);
            await receiveRecordedSpeech(manager, turn.text, entry, turn.id);
            expect(onUtterance).toHaveBeenCalledWith(
              expect.objectContaining({
                sessionId: "shared-room",
                text: turn.text,
                speaker: { id: turn.id, label: turn.label },
              }),
            );
          }
          expect(agentCommandMock).toHaveBeenCalledTimes(2);
        } finally {
          await manager.destroy();
        }
      },
    );

    it("does not let a silent speaker consume another speaker's pending audio", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: false } } },
      });
      try {
        beginSpeakerTurn(entry).close();
        const owner = lastRealtimeBridge();
        beginSpeakerTurn(entry, { senderIsOwner: false, initialAudio: null }).close();
        const silentGuest = lastRealtimeBridge();
        await emitFinalRealtimeUserTranscript(silentGuest.bridgeParams, "Unbound transcript.");
        expect(agentCommandMock).not.toHaveBeenCalled();
        await emitFinalRealtimeUserTranscript(owner.bridgeParams, "Read my agenda.");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(lastAgentCommandArgs().senderIsOwner).toBe(true);
      } finally {
        await manager.destroy();
      }
    });

    it("retains one speaker's authority across multiple final transcripts from one capture", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: false } } },
      });
      try {
        beginSpeakerTurn(entry, {
          senderIsOwner: false,
          extraSystemPrompt: "Guest context.",
        }).close();
        const guest = lastRealtimeBridge();
        await emitFinalRealtimeUserTranscript(guest.bridgeParams, "Read the agenda.");
        await emitFinalRealtimeUserTranscript(guest.bridgeParams, "Then summarize the notes.");
        expect(agentCommandMock).toHaveBeenCalledTimes(2);
        for (const index of [0, 1]) {
          expect(agentCommandArgsAt(index)).toMatchObject({
            senderIsOwner: false,
            extraSystemPrompt: "Guest context.",
          });
        }
      } finally {
        await manager.destroy();
      }
    });

    it("keeps a wake-name follow-up available to its speaker after another person speaks", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: true } } },
      });
      try {
        beginSpeakerTurn(entry).close();
        const owner = lastRealtimeBridge();
        await emitFinalRealtimeUserTranscript(owner.bridgeParams, "OpenClaw");
        beginSpeakerTurn(entry, { senderIsOwner: false }).close();
        const guest = lastRealtimeBridge();
        await emitFinalRealtimeUserTranscript(guest.bridgeParams, "A separate conversation.");
        expect(agentCommandMock).not.toHaveBeenCalled();
        await emitFinalRealtimeUserTranscript(owner.bridgeParams, "Read my agenda.");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(lastAgentCommandArgs().senderIsOwner).toBe(true);
      } finally {
        await manager.destroy();
      }
    });

    it("refreshes descriptive context without replacing the speaker's connection", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: false } } },
      });
      try {
        beginSpeakerTurn(entry, {
          senderIsOwner: false,
          speakerLabel: "Ada",
          extraSystemPrompt: "Old roster.",
        }).close();
        const guest = lastRealtimeBridge();
        await emitFinalRealtimeUserTranscript(guest.bridgeParams, "First question.");
        beginSpeakerTurn(entry, {
          senderIsOwner: false,
          speakerLabel: "Ada Lovelace",
          extraSystemPrompt: "Updated roster.",
        }).close();
        await emitFinalRealtimeUserTranscript(guest.bridgeParams, "Second question.");
        expect(guest.session.close).not.toHaveBeenCalled();
        expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledOnce();
        expect(lastAgentCommandArgs()).toMatchObject({
          senderIsOwner: false,
          extraSystemPrompt: "Updated roster.",
        });
      } finally {
        await manager.destroy();
      }
    });

    it("drops late transcript and tool callbacks when a speaker's admission changes", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: false } } },
      });
      try {
        beginSpeakerTurn(entry, { userId: "same-user", senderIsOwner: false }).close();
        const retired = lastRealtimeBridge();
        beginSpeakerTurn(entry, { userId: "same-user", senderIsOwner: true }).close();
        const owner = lastRealtimeBridge();
        expect(retired.session.close).toHaveBeenCalledOnce();
        await emitFinalRealtimeUserTranscript(retired.bridgeParams, "Stale guest question.");
        await retired.bridgeParams.onToolCall?.(
          {
            itemId: "old-item",
            callId: "old-call",
            name: "openclaw_agent_consult",
            args: { question: "Stale guest tool call." },
          },
          retired.session,
        );
        expect(agentCommandMock).not.toHaveBeenCalled();
        await emitFinalRealtimeUserTranscript(owner.bridgeParams, "Fresh owner question.");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(lastAgentCommandArgs().senderIsOwner).toBe(true);
      } finally {
        await manager.destroy();
      }
    });

    it("delivers an in-flight reply through its original connection after a transcript subscription changes", async () => {
      const answer = createDeferred<{ payloads: Array<{ text: string }> }>();
      agentCommandMock.mockReturnValueOnce(answer.promise);
      const { entry, manager } = await createJoinedAgentProxyFixture();
      const oldTranscript = vi.fn();
      const newTranscript = vi.fn();
      let pending: Promise<void> | void = undefined;
      try {
        await startTranscripts(manager, oldTranscript, "old-subscription");
        const originalCapture = beginSpeakerTurn(entry);
        const original = lastRealtimeBridge();
        pending = original.bridgeParams.onToolCall?.(
          {
            itemId: "old-item",
            callId: "old-call",
            name: "openclaw_agent_consult",
            args: { question: "Original question." },
          },
          original.session,
        );
        await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledOnce());
        await startTranscripts(manager, newTranscript, "new-subscription");
        beginSpeakerTurn(entry).close();
        const replacement = lastRealtimeBridge();
        const sentBeforeLateAudio = original.session.sendAudio.mock.calls.length;
        originalCapture.sendInputAudio(Buffer.alloc(8));
        expect(original.session.sendAudio).toHaveBeenCalledTimes(sentBeforeLateAudio);
        expect(original.session.close).not.toHaveBeenCalled();
        answer.resolve({ payloads: [{ text: "Original answer." }] });
        await pending;
        expect(original.session.submitToolResult).toHaveBeenCalledWith("old-call", {
          text: "Original answer.",
        });
        expect(replacement.session.submitToolResult).not.toHaveBeenCalled();
        await emitFinalRealtimeUserTranscript(replacement.bridgeParams, "Fresh question.");
        expect(newTranscript).not.toHaveBeenCalled();
        await receiveRecordedSpeech(manager, "Fresh question.", entry);
        expect(newTranscript).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: "new-subscription", text: "Fresh question." }),
        );
        expect(oldTranscript).not.toHaveBeenCalled();
        expect(agentCommandMock).toHaveBeenCalledTimes(2);
      } finally {
        answer.resolve({ payloads: [] });
        await pending;
        await manager.destroy();
      }
    });

    it("waits for every speaker to drain when another speaker's cleanup rejects", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture();
      beginSpeakerTurn(entry, { userId: "owner" }).close();
      beginSpeakerTurn(entry, { userId: "guest", senderIsOwner: false }).close();
      const pendingProvider = lastRealtimeBridge().session;
      const pending = createDeferred<void>();
      const { DiscordRealtimeSpeakerSession } = await import("./realtime-speaker-session.js");
      const close = vi.spyOn(DiscordRealtimeSpeakerSession.prototype, "close");
      const conversationClosed = vi.spyOn(entry.conversations, "close");
      let leaving: ReturnType<typeof manager.leave> | undefined;
      try {
        pendingProvider.close.mockReturnValueOnce(pending.promise);
        close.mockImplementationOnce(
          function (this: InstanceType<typeof DiscordRealtimeSpeakerSession>) {
            close.mockRestore();
            return Promise.resolve(this.close()).then(() => {
              throw new Error("Speaker cleanup failed");
            });
          },
        );
        leaving = manager.leave({ guildId: entry.guildId });
        await vi.waitFor(() =>
          expect(loggerWarnMock).toHaveBeenCalledWith(
            expect.stringContaining("Speaker cleanup failed"),
          ),
        );
        expect(pendingProvider.close).toHaveBeenCalledOnce();
        expect(conversationClosed).not.toHaveBeenCalled();
      } finally {
        pending.resolve();
        close.mockRestore();
        await leaving;
        await manager.destroy();
      }
      expect(conversationClosed).toHaveBeenCalledOnce();
    });

    it("keeps a healthy speaker connected when another speaker's provider connection fails", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: false } } },
      });
      try {
        beginSpeakerTurn(entry).close();
        const owner = lastRealtimeBridge();
        const failed = createRealtimeSessionMock();
        failed.connect.mockRejectedValueOnce(new Error("provider unavailable"));
        createRealtimeVoiceBridgeSessionMock.mockReturnValueOnce(failed);
        beginSpeakerTurn(entry, { senderIsOwner: false }).close();
        await vi.waitFor(() => expect(failed.close).toHaveBeenCalled());
        expect(owner.session.close).not.toHaveBeenCalled();
        expect(manager.status()).toHaveLength(1);
        expect(
          sentUserMessages(owner.session).some((message) =>
            message.includes("Please try speaking again"),
          ),
        ).toBe(true);
        await emitFinalRealtimeUserTranscript(owner.bridgeParams, "Read my agenda.");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(lastAgentCommandArgs().senderIsOwner).toBe(true);
      } finally {
        await manager.destroy();
      }
    });

    it("reclaims expired noise-only speakers without giving late callbacks a replacement's authority", async () => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: false } } },
      });
      try {
        for (let index = 0; index < 8; index += 1) {
          beginSpeakerTurn(entry, { userId: `guest-${index}`, senderIsOwner: false }).close();
        }
        const retired = lastRealtimeBridge();
        expect(() => beginSpeakerTurn(entry, { userId: "owner", senderIsOwner: true })).toThrow(
          "Voice is busy",
        );
        clock.mockReturnValue(now + 60_001);
        for (let index = 0; index < 8; index += 1) {
          // WebRTC transport silence keeps arriving after the speaker stops.
          realtimeBridgeAt(index).bridgeParams.onEvent?.({
            direction: "server",
            type: "output_audio.rtp",
          });
        }
        beginSpeakerTurn(entry, { userId: "owner", senderIsOwner: true }).close();
        const owner = lastRealtimeBridge();
        expect(retired.session.close).toHaveBeenCalledOnce();
        await emitFinalRealtimeUserTranscript(retired.bridgeParams, "Expired guest question.");
        expect(agentCommandMock).not.toHaveBeenCalled();
        await emitFinalRealtimeUserTranscript(owner.bridgeParams, "Fresh owner question.");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(lastAgentCommandArgs().senderIsOwner).toBe(true);
      } finally {
        clock.mockRestore();
        await manager.destroy();
      }
    });
  },
);
