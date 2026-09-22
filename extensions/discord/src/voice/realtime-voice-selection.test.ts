import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    agentCommandMock,
    beginSpeakerTurn,
    createJoinedAgentProxyFixture,
    createRealtimeSessionMock,
    createRealtimeVoiceBridgeSessionMock,
    emitFinalRealtimeUserTranscript,
    lastRealtimeBridge,
    lastAgentCommandArgs,
    registerRealtimeVoiceSelectionMock,
    resolveConfiguredRealtimeVoiceProviderMock,
    resolveVoiceIngressWithParticipantsMock,
    sentUserMessages,
  }) => {
    const useNativeVoices = () => {
      resolveConfiguredRealtimeVoiceProviderMock.mockImplementation((params) => ({
        provider: { id: "openai" },
        capabilities: {
          supportsActivationNameGating: false,
          handlesAgentConsult: true,
          voices: ["marin", "cedar"],
        },
        providerConfig: { model: "gpt-live-1", voice: "marin", ...params?.providerConfigOverrides },
      }));
      createRealtimeVoiceBridgeSessionMock.mockImplementation(() => {
        const session = createRealtimeSessionMock();
        session.bridge.supportsToolResultSuppression = false;
        return session;
      });
    };
    const useGoogleVoices = (voices = ["Puck", "Kore"]) => {
      resolveConfiguredRealtimeVoiceProviderMock.mockImplementation((params) => ({
        provider: { id: "google" },
        capabilities: {
          supportsActivationNameGating: false,
          ...(voices.length > 0 ? { voices } : {}),
        },
        providerConfig: {
          model: "gemini-3.1-flash-live-preview",
          voice: "Puck",
          ...params?.providerConfigOverrides,
        },
      }));
      createRealtimeVoiceBridgeSessionMock.mockImplementation(() => {
        const session = createRealtimeSessionMock();
        session.bridge.supportsToolResultSuppression = false;
        session.bridge.supportsToolResultContinuation = false;
        return session;
      });
    };
    const selectionOwner = () => registerRealtimeVoiceSelectionMock.mock.calls.at(-1)![0];
    const selectionHandle = () => {
      const result = registerRealtimeVoiceSelectionMock.mock.results.at(-1);
      if (!result || result.type !== "return") {
        throw new Error("The room did not register its voice selection handle");
      }
      return result.value;
    };

    it("rejects voice replacement when the provider has no voice catalog", async () => {
      useGoogleVoices([]);
      const { entry, manager } = await createJoinedAgentProxyFixture();
      try {
        beginSpeakerTurn(entry).close();
        const original = lastRealtimeBridge();
        const connections = createRealtimeVoiceBridgeSessionMock.mock.calls.length;
        expect(selectionOwner().read()).toMatchObject({
          provider: "google",
          voice: "Puck",
          canChange: false,
        });
        await expect(
          selectionOwner().changeVoice("Kore", { assertCurrent: () => {} }),
        ).rejects.toThrow("cannot change voices");
        expect(original.session.close).not.toHaveBeenCalled();
        expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(connections);
        expect(selectionOwner().read()).toMatchObject({ voice: "Puck" });
        expect(manager.status()).toHaveLength(1);
      } finally {
        await manager.destroy();
      }
    });

    it.each([false, true])(
      "switches Gemini from its own function call and speaks the late answer once (transcript first=%s)",
      async (transcriptFirst) => {
        useGoogleVoices();
        const answer = createDeferred<{ payloads: Array<{ text: string }> }>();
        const { entry, manager } = await createJoinedAgentProxyFixture({
          config: { voice: { realtime: { requireWakeName: false, consultPolicy: "always" } } },
        });
        let submission: Promise<void> | undefined;
        try {
          beginSpeakerTurn(entry).close();
          const original = lastRealtimeBridge();
          agentCommandMock.mockImplementationOnce(async () => {
            await selectionOwner().changeVoice("Kore", { assertCurrent: () => {} });
            return await answer.promise;
          });
          if (transcriptFirst) {
            vi.useFakeTimers();
            original.bridgeParams.onTranscript?.(
              "user",
              "Switch to Kore and check the agenda.",
              true,
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(agentCommandMock).not.toHaveBeenCalled();
          }
          submission = Promise.resolve(
            original.bridgeParams.onToolCall?.(
              {
                itemId: "gemini-switch-item",
                callId: "gemini-switch-call",
                name: "openclaw_agent_consult",
                args: { question: "Switch to Kore and check the agenda." },
              },
              original.session,
            ),
          );
          await vi.waitFor(() => expect(selectionOwner().read()).toMatchObject({ voice: "Kore" }));
          const replacement = lastRealtimeBridge();
          expect(replacement.session).not.toBe(original.session);
          expect(original.session.close).toHaveBeenCalledExactlyOnceWith({ disposition: "detach" });
          expect(sentUserMessages(replacement.session)).toHaveLength(0);
          const signal = lastAgentCommandArgs().abortSignal;
          expect(signal).toBeInstanceOf(AbortSignal);
          if (signal instanceof AbortSignal) {
            expect(signal.aborted).toBe(false);
          }
          answer.resolve({ payloads: [{ text: "The agenda starts with the budget review." }] });
          await submission;
          expect(sentUserMessages(replacement.session)).toEqual([
            expect.stringContaining("The agenda starts with the budget review."),
          ]);
          expect(sentUserMessages(original.session)).toHaveLength(0);
          expect(original.session.submitToolResult).not.toHaveBeenCalled();
          expect(replacement.session.submitToolResult).not.toHaveBeenCalled();
          expect(agentCommandMock).toHaveBeenCalledOnce();
        } finally {
          answer.resolve({ payloads: [] });
          await submission;
          vi.useRealTimers();
          await manager.destroy();
        }
      },
    );

    it("hands a pending Gemini forced consult joined by a function call to the new voice", async () => {
      useGoogleVoices();
      const answer = createDeferred<{ payloads: Array<{ text: string }> }>();
      agentCommandMock.mockReturnValueOnce(answer.promise);
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: false } } },
      });
      let submission: Promise<void> | undefined;
      try {
        beginSpeakerTurn(entry).close();
        const original = lastRealtimeBridge();
        await emitFinalRealtimeUserTranscript(original.bridgeParams, "Finish the agenda task.");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        submission = Promise.resolve(
          original.bridgeParams.onToolCall?.(
            {
              itemId: "gemini-join-item",
              callId: "gemini-join-call",
              name: "openclaw_agent_consult",
              args: { question: "Finish the agenda task." },
            },
            original.session,
          ),
        );
        await selectionOwner().changeVoice("Kore", { assertCurrent: () => {} });
        const replacement = lastRealtimeBridge();
        answer.resolve({ payloads: [{ text: "The agenda task is finished." }] });
        await submission;
        expect(sentUserMessages(replacement.session)).toEqual([
          expect.stringContaining("The agenda task is finished."),
        ]);
        expect(sentUserMessages(original.session)).toHaveLength(0);
        expect(original.session.submitToolResult).not.toHaveBeenCalled();
        expect(agentCommandMock).toHaveBeenCalledOnce();
      } finally {
        answer.resolve({ payloads: [] });
        await submission;
        await manager.destroy();
      }
    });

    it.each(["accepted", "pending"] as const)(
      "does not replay a Gemini answer after provider submission starts (%s)",
      async (submissionState) => {
        useGoogleVoices();
        const answer = createDeferred<{ payloads: Array<{ text: string }> }>();
        const providerSubmission = createDeferred<void>();
        const submissionStarted = createDeferred<void>();
        agentCommandMock.mockReturnValueOnce(answer.promise);
        const { entry, manager } = await createJoinedAgentProxyFixture({
          config: { voice: { realtime: { requireWakeName: false } } },
        });
        let submission: Promise<void> | undefined;
        try {
          beginSpeakerTurn(entry).close();
          const original = lastRealtimeBridge();
          await emitFinalRealtimeUserTranscript(original.bridgeParams, "Read the agenda result.");
          original.session.submitToolResult.mockImplementationOnce(() => {
            submissionStarted.resolve();
            return submissionState === "pending" ? providerSubmission.promise : undefined;
          });
          submission = Promise.resolve(
            original.bridgeParams.onToolCall?.(
              {
                itemId: "gemini-submitted-item",
                callId: "gemini-submitted-call",
                name: "openclaw_agent_consult",
                args: { question: "Read the agenda result." },
              },
              original.session,
            ),
          );
          answer.resolve({ payloads: [{ text: "The agenda is ready." }] });
          await submissionStarted.promise;
          if (submissionState === "accepted") {
            await submission;
          }
          await selectionOwner().changeVoice("Kore", { assertCurrent: () => {} });
          const replacement = lastRealtimeBridge();
          expect(sentUserMessages(replacement.session)).toHaveLength(0);
          providerSubmission.resolve();
          await submission;
          expect(original.session.submitToolResult.mock.calls).toEqual([
            ["gemini-submitted-call", { text: "The agenda is ready." }],
          ]);
          expect(sentUserMessages(original.session)).toHaveLength(0);
          expect(sentUserMessages(replacement.session)).toHaveLength(0);
          expect(replacement.session.submitToolResult).not.toHaveBeenCalled();
          expect(agentCommandMock).toHaveBeenCalledOnce();
        } finally {
          answer.resolve({ payloads: [] });
          providerSubmission.resolve();
          await submission;
          await manager.destroy();
        }
      },
    );

    it("changes the room voice from a native delegation and speaks its answer on the replacement", async () => {
      useNativeVoices();
      const { entry, manager } = await createJoinedAgentProxyFixture();
      const bindRun = vi.spyOn(selectionHandle(), "bindRun");
      try {
        beginSpeakerTurn(entry, { userId: "owner", senderIsOwner: true }).close();
        const original = lastRealtimeBridge();
        original.bridgeParams.onTranscript?.(
          "user",
          "Remember that the agenda starts with budget.",
          true,
        );
        original.bridgeParams.onTranscript?.("assistant", "Budget comes first.", true);
        agentCommandMock.mockImplementationOnce(async () => {
          const input = lastAgentCommandArgs();
          expect(bindRun).toHaveBeenCalledOnce();
          const binding = bindRun.mock.calls[0]![0];
          expect(input.runId).toBe(binding.runId);
          expect(selectionOwner().read()).toMatchObject({
            voice: "marin",
            voices: ["marin", "cedar"],
            canChange: true,
          });
          await selectionOwner().changeVoice("cedar", { assertCurrent: binding.assertCurrent });
          expect(input.abortSignal).toBeInstanceOf(AbortSignal);
          if (input.abortSignal instanceof AbortSignal) {
            expect(input.abortSignal.aborted).toBe(false);
          }
          return { payloads: [{ text: "I'm speaking with Cedar now." }] };
        });
        await expect(
          original.bridgeParams.runAgentConsult!({ prompt: "Switch to Cedar." }),
        ).resolves.toEqual({ text: "I'm speaking with Cedar now." });
        const replacement = lastRealtimeBridge();
        expect(replacement.session).not.toBe(original.session);
        expect(replacement.bridgeParams.instructions).toContain("Budget comes first.");
        expect(replacement.bridgeParams.instructions).toContain("quoted conversation history");
        expect(original.session.close).toHaveBeenCalledExactlyOnceWith({ disposition: "detach" });
        expect(selectionOwner().read()).toMatchObject({ voice: "cedar" });
        expect(
          sentUserMessages(replacement.session).some((text) =>
            text.includes("I'm speaking with Cedar now."),
          ),
        ).toBe(true);
        expect(manager.status()).toHaveLength(1);
        expect(original.session.submitToolResult).not.toHaveBeenCalled();
      } finally {
        await manager.destroy();
      }
    });

    it("does not hand cancelled native consult speech to the replacement", async () => {
      useNativeVoices();
      const [{ DiscordRealtimeSpeakerSession }, { DiscordRealtimePlayer }] = await Promise.all([
        import("./realtime-speaker-session.js"),
        import("./realtime-player.js"),
      ]);
      const { entry, manager } = await createJoinedAgentProxyFixture();
      const player = new DiscordRealtimePlayer(entry.player);
      const answer = createDeferred<string>();
      const cancellation = new AbortController();
      const context = { senderIsOwner: true, speakerLabel: "Owner" };
      const runAgentTurn = vi.fn(() => answer.promise);
      const createSpeaker = (sessionId: string, voiceOverride: string) =>
        new DiscordRealtimeSpeakerSession({
          accountId: "default",
          cfg: {},
          discordConfig: { voice: { enabled: true, realtime: { provider: "openai" } } },
          entry,
          mode: "agent-proxy",
          player,
          sessionId,
          voiceOverride,
          runAgentTurn,
          resolveSpeakerContext: async () => context,
          onTerminalError: vi.fn(),
        });
      const original = createSpeaker("cancelled-consult-source", "marin");
      const replacement = createSpeaker("cancelled-consult-replacement", "cedar");
      try {
        await original.connect();
        const sourceBridge = lastRealtimeBridge();
        const turn = original.beginSpeakerTurn(context, "u-owner");
        turn.sendInputAudio(Buffer.alloc(3840));
        turn.close();
        const consultation = sourceBridge.bridgeParams.runAgentConsult!({
          prompt: "Check the agenda.",
          signal: cancellation.signal,
        });
        const rejected = expect(consultation).rejects.toThrow("Consult cancelled");
        await original.close("detach");
        await replacement.connect();
        const replacementBridge = lastRealtimeBridge();
        original.transferPendingSpeechTo(replacement);
        answer.resolve("The cancelled agenda answer.");
        cancellation.abort(new Error("Consult cancelled"));
        await rejected;
        expect(runAgentTurn).toHaveBeenCalledOnce();
        expect(sentUserMessages(sourceBridge.session)).toHaveLength(0);
        expect(sentUserMessages(replacementBridge.session)).toHaveLength(0);
      } finally {
        answer.resolve("");
        await original.close();
        await replacement.close();
        player.close();
        await manager.destroy();
      }
    });

    it.each(["native", "fallback"] as const)(
      "retains a %s answer that finishes while the old provider closes",
      async (path) => {
        if (path === "native") {
          useNativeVoices();
        } else {
          useGoogleVoices();
        }
        const answer = createDeferred<{ payloads: Array<{ text: string }> }>();
        const closing = createDeferred<void>();
        const finishClose = createDeferred<void>();
        agentCommandMock.mockReturnValueOnce(answer.promise);
        const { entry, manager } = await createJoinedAgentProxyFixture(
          path === "fallback"
            ? { config: { voice: { realtime: { toolPolicy: "none", debounceMs: 0 } } } }
            : {},
        );
        let consultation: Promise<{ text: string }> | undefined;
        let switching: Promise<void> | undefined;
        try {
          beginSpeakerTurn(entry).close();
          const original = lastRealtimeBridge();
          if (path === "native") {
            consultation = original.bridgeParams.runAgentConsult!({ prompt: "Check the agenda." });
          } else {
            await emitFinalRealtimeUserTranscript(original.bridgeParams, "Check the agenda.");
          }
          await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledOnce());
          original.session.close.mockImplementationOnce(async () => {
            closing.resolve();
            await finishClose.promise;
          });
          switching = selectionOwner().changeVoice(path === "native" ? "cedar" : "Kore", {
            assertCurrent: () => {},
          });
          await closing.promise;
          const replacement = lastRealtimeBridge();
          answer.resolve({ payloads: [{ text: "The agenda is ready." }] });
          await setImmediate();
          expect(sentUserMessages(original.session)).toHaveLength(0);
          expect(sentUserMessages(replacement.session)).toHaveLength(0);
          finishClose.resolve();
          await switching;
          await consultation;
          await vi.waitFor(() =>
            expect(sentUserMessages(replacement.session)).toEqual([
              expect.stringContaining("The agenda is ready."),
            ]),
          );
          expect(agentCommandMock).toHaveBeenCalledOnce();
          expect(original.session.submitToolResult).not.toHaveBeenCalled();
        } finally {
          finishClose.resolve();
          answer.resolve({ payloads: [] });
          await switching;
          await consultation;
          await manager.destroy();
        }
      },
    );

    it.each([false, true])(
      "hands unspoken answers to the new voice in order (playback started=%s)",
      async (playbackStarted) => {
        resolveConfiguredRealtimeVoiceProviderMock.mockImplementation((params) => ({
          provider: { id: "openai" },
          capabilities: { supportsActivationNameGating: true, voices: ["marin", "cedar"] },
          providerConfig: {
            model: "gpt-realtime-2.1",
            voice: "marin",
            ...params?.providerConfigOverrides,
          },
        }));
        agentCommandMock
          .mockResolvedValueOnce({ payloads: [{ text: "Earlier answer." }] })
          .mockResolvedValueOnce({ payloads: [{ text: "First queued answer." }] })
          .mockResolvedValueOnce({ payloads: [{ text: "Second queued answer." }] });
        const { entry, manager, player } = await createJoinedAgentProxyFixture({
          config: { voice: { realtime: { requireWakeName: false, bargeIn: false } } },
        });
        const connection = createDeferred<void>();
        let switching: Promise<void> | undefined;
        try {
          if (!playbackStarted) {
            beginSpeakerTurn(entry, { userId: "guest", senderIsOwner: false }).close();
            lastRealtimeBridge().bridgeParams.audioSink.sendAudio(Buffer.alloc(24_000));
          }
          beginSpeakerTurn(entry, { userId: "owner", senderIsOwner: true }).close();
          const original = lastRealtimeBridge();
          await emitFinalRealtimeUserTranscript(original.bridgeParams, "First question.");
          original.bridgeParams.audioSink.sendAudio(Buffer.alloc(24_000));
          original.bridgeParams.onTranscript?.("assistant", "Earlier answer.", true);
          // The owner either plays now or waits behind the guest's physical player request.
          expect(player.play).toHaveBeenCalledOnce();
          expect(
            sentUserMessages(original.session).some((text) => text.includes("Earlier answer.")),
          ).toBe(true);
          const candidate = createRealtimeSessionMock();
          candidate.connect.mockReturnValueOnce(connection.promise);
          createRealtimeVoiceBridgeSessionMock.mockReturnValueOnce(candidate);
          switching = selectionOwner().changeVoice("cedar", { assertCurrent: () => {} });
          await vi.waitFor(() => expect(candidate.connect).toHaveBeenCalled());
          for (const question of ["Second question.", "Third question."]) {
            beginSpeakerTurn(entry, { userId: "owner", senderIsOwner: true }).close();
            await emitFinalRealtimeUserTranscript(original.bridgeParams, question);
          }
          expect(
            sentUserMessages(original.session).some((text) => text.includes("queued answer.")),
          ).toBe(false);
          connection.resolve();
          await switching;
          const replacement = lastRealtimeBridge();
          const expected = [
            ...(playbackStarted ? [] : ["Earlier answer."]),
            "First queued answer.",
            "Second queued answer.",
          ];
          for (const [index, answer] of expected.entries()) {
            const spoken = sentUserMessages(replacement.session);
            expect(spoken).toHaveLength(index + 1);
            expect(spoken[index]).toContain(answer);
            if (index + 1 < expected.length) {
              replacement.bridgeParams.onEvent?.({ direction: "server", type: "response.created" });
              replacement.bridgeParams.onResponseDone?.({ status: "completed" });
            }
          }
        } finally {
          connection.resolve();
          await switching;
          await manager.destroy();
        }
      },
    );

    it.each([false, true])(
      "settles unfinished forced speech through repeated replacements (left=%s)",
      async (left) => {
        resolveConfiguredRealtimeVoiceProviderMock.mockImplementation((params) => ({
          provider: { id: "openai" },
          capabilities: { supportsActivationNameGating: true, voices: ["marin", "cedar"] },
          providerConfig: {
            model: "gpt-realtime-2.1",
            voice: "marin",
            ...params?.providerConfigOverrides,
          },
        }));
        const agentResult = createDeferred<{ payloads: Array<{ text: string }> }>();
        agentCommandMock.mockReturnValueOnce(agentResult.promise);
        const { entry, manager } = await createJoinedAgentProxyFixture({
          config: { voice: { realtime: { requireWakeName: false } } },
        });
        let submission: Promise<void> | undefined;
        try {
          beginSpeakerTurn(entry).close();
          const original = lastRealtimeBridge();
          await emitFinalRealtimeUserTranscript(original.bridgeParams, "Finish the long task.");
          submission = Promise.resolve(
            original.bridgeParams.onToolCall?.(
              {
                itemId: "long-task-item",
                callId: "long-task-call",
                name: "openclaw_agent_consult",
                args: { question: "Finish the long task." },
              },
              original.session,
            ),
          );
          await selectionOwner().changeVoice("cedar", { assertCurrent: () => {} });
          await selectionOwner().changeVoice("marin", { assertCurrent: () => {} });
          const replacement = lastRealtimeBridge();
          expect(sentUserMessages(replacement.session)).toHaveLength(0);
          if (left) {
            await manager.destroy();
          }
          agentResult.resolve({ payloads: [{ text: "The long task is finished." }] });
          await submission;
          expect(sentUserMessages(replacement.session)).toEqual(
            left ? [] : [expect.stringContaining("The long task is finished.")],
          );
          expect(sentUserMessages(original.session)).toHaveLength(0);
          expect(agentCommandMock).toHaveBeenCalledOnce();
        } finally {
          agentResult.resolve({ payloads: [] });
          await submission;
          await manager.destroy();
        }
      },
    );

    it("retains speech completed while a replacement voice is connecting", async () => {
      useNativeVoices();
      const { entry, manager } = await createJoinedAgentProxyFixture();
      const connection = createDeferred<void>();
      let switching: Promise<void> | undefined;
      try {
        beginSpeakerTurn(entry).close();
        const original = lastRealtimeBridge();
        original.bridgeParams.onTranscript?.("user", "The budget review is first.", true);
        const candidate = createRealtimeSessionMock();
        candidate.connect.mockReturnValueOnce(connection.promise);
        createRealtimeVoiceBridgeSessionMock.mockReturnValueOnce(candidate);
        switching = selectionOwner().changeVoice("cedar", { assertCurrent: () => {} });
        await vi.waitFor(() => expect(candidate.connect).toHaveBeenCalled());
        expect(original.session.close).not.toHaveBeenCalled();
        beginSpeakerTurn(entry).close();
        original.bridgeParams.onTranscript?.("user", "Move the budget review to Thursday.", true);
        original.bridgeParams.onTranscript?.("assistant", "The review is now on Thursday.", true);
        connection.resolve();
        await switching;
        expect(selectionOwner().read()).toMatchObject({ voice: "cedar" });
        expect(lastRealtimeBridge().bridgeParams.instructions).toContain(
          "Move the budget review to Thursday.",
        );
        expect(lastRealtimeBridge().bridgeParams.instructions).toContain(
          "The review is now on Thursday.",
        );
      } finally {
        connection.resolve();
        await switching;
        await manager.destroy();
      }
    });

    it("keeps the idle sweep from retiring a guest during the room voice handoff", async () => {
      useNativeVoices();
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
      const draining = createDeferred<void>();
      const finishDrain = createDeferred<void>();
      let fixture: Awaited<ReturnType<typeof createJoinedAgentProxyFixture>> | undefined;
      let consultation: Promise<{ text: string }> | undefined;
      try {
        fixture = await createJoinedAgentProxyFixture();
        const { entry, manager } = fixture;
        beginSpeakerTurn(entry, { userId: "owner", senderIsOwner: true }).close();
        const owner = lastRealtimeBridge();
        beginSpeakerTurn(entry, { userId: "guest", senderIsOwner: false }).close();
        await vi.advanceTimersByTimeAsync(119_999);
        owner.session.close.mockImplementationOnce(async () => {
          draining.resolve();
          await finishDrain.promise;
        });
        agentCommandMock.mockImplementationOnce(async () => {
          await selectionOwner().changeVoice("cedar", { assertCurrent: () => {} });
          return { payloads: [{ text: "Cedar is ready." }] };
        });
        consultation = owner.bridgeParams.runAgentConsult!({ prompt: "Switch to Cedar." });
        await draining.promise;
        await vi.advanceTimersByTimeAsync(1);
        finishDrain.resolve();
        await expect(consultation).resolves.toEqual({ text: "Cedar is ready." });
        expect(selectionOwner().read()).toMatchObject({ voice: "cedar" });
        expect(manager.status()).toHaveLength(1);
        const connections = createRealtimeVoiceBridgeSessionMock.mock.calls.length;
        beginSpeakerTurn(entry, { userId: "guest", senderIsOwner: false }).close();
        expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(connections);
      } finally {
        finishDrain.resolve();
        await consultation?.catch(() => {});
        await fixture?.manager.destroy();
        vi.useRealTimers();
      }
    });

    it("preserves final transcript drain while the native voice-changing consultation stays active", async () => {
      useNativeVoices();
      const { entry, manager } = await createJoinedAgentProxyFixture();
      const draining = createDeferred<void>();
      const finishDrain = createDeferred<void>();
      const publishedTail = createDeferred<void>();
      let consultation: Promise<{ text: string }> | undefined;
      try {
        beginSpeakerTurn(entry).close();
        const original = lastRealtimeBridge();
        original.session.close.mockImplementationOnce(async () => {
          draining.resolve();
          await finishDrain.promise;
          original.bridgeParams.onTranscript?.(
            "user",
            "Remember the final agenda item: hiring.",
            true,
          );
          original.bridgeParams.onTranscript?.("assistant", "Hiring is the final item.", true);
          publishedTail.resolve();
        });
        agentCommandMock.mockImplementationOnce(async () => {
          await selectionOwner().changeVoice("cedar", { assertCurrent: () => {} });
          return { payloads: [{ text: "I'm using Cedar now." }] };
        });
        consultation = original.bridgeParams.runAgentConsult!({ prompt: "Switch to Cedar." });
        await draining.promise;
        expect(original.session.close).toHaveBeenCalledExactlyOnceWith({ disposition: "detach" });
        finishDrain.resolve();
        await publishedTail.promise;
        await expect(consultation).resolves.toEqual({ text: "I'm using Cedar now." });
        const replacement = lastRealtimeBridge();
        expect(replacement.bridgeParams.instructions).toContain(
          "Remember the final agenda item: hiring.",
        );
        expect(replacement.bridgeParams.instructions).toContain("Hiring is the final item.");
        expect(
          sentUserMessages(replacement.session).some((text) =>
            text.includes("I'm using Cedar now."),
          ),
        ).toBe(true);
        expect(selectionOwner().read()).toMatchObject({ voice: "cedar" });
      } finally {
        finishDrain.resolve();
        await consultation;
        await manager.destroy();
      }
    });

    it.each([false, true])(
      "recovers after final-history preparation fails (restoration fails=%s)",
      async (recoveryFails) => {
        useNativeVoices();
        const { entry, manager } = await createJoinedAgentProxyFixture();
        try {
          beginSpeakerTurn(entry).close();
          const original = lastRealtimeBridge();
          original.session.close.mockImplementationOnce(async () => {
            await Promise.resolve();
            original.bridgeParams.onTranscript?.("user", "Keep the final hiring notes.", true);
          });
          const prepared = createRealtimeSessionMock();
          const failedRefresh = createRealtimeSessionMock();
          failedRefresh.connect.mockRejectedValueOnce(new Error("Final replacement unavailable"));
          const recovered = createRealtimeSessionMock();
          if (recoveryFails) {
            recovered.connect.mockRejectedValueOnce(new Error("Previous voice unavailable"));
          }
          createRealtimeVoiceBridgeSessionMock
            .mockReturnValueOnce(prepared)
            .mockReturnValueOnce(failedRefresh)
            .mockReturnValueOnce(recovered);
          agentCommandMock.mockImplementationOnce(async () => {
            const input = lastAgentCommandArgs();
            if (!(input.abortSignal instanceof AbortSignal)) {
              throw new Error("The native consultation has no cancellation signal");
            }
            await expect(
              selectionOwner().changeVoice("cedar", { assertCurrent: () => {} }),
            ).rejects.toThrow(
              recoveryFails
                ? "the previous voice could not reconnect"
                : "the previous voice was restored",
            );
            expect(input.abortSignal.aborted).toBe(false);
            return {
              payloads: [{ text: "The background task finished after the voice change failed." }],
            };
          });
          await expect(
            original.bridgeParams.runAgentConsult!({
              prompt: "Switch voices and finish the task.",
            }),
          ).resolves.toEqual({
            text: "The background task finished after the voice change failed.",
          });
          expect(original.session.close).toHaveBeenCalledExactlyOnceWith({ disposition: "detach" });
          expect(prepared.close).toHaveBeenCalledOnce();
          expect(failedRefresh.close).toHaveBeenCalledOnce();
          if (recoveryFails) {
            await vi.waitFor(() => expect(manager.status()).toHaveLength(0));
            expect(recovered.close).toHaveBeenCalledOnce();
          } else {
            expect(selectionOwner().read()).toMatchObject({ voice: "marin" });
            expect(lastRealtimeBridge().session).toBe(recovered);
            expect(lastRealtimeBridge().bridgeParams.instructions).toContain(
              "Keep the final hiring notes.",
            );
            expect(manager.status()).toHaveLength(1);
            expect(recovered.close).not.toHaveBeenCalled();
          }
        } finally {
          await manager.destroy();
        }
      },
    );

    it("keeps the original connection and voice when the replacement fails", async () => {
      useNativeVoices();
      const { entry, manager } = await createJoinedAgentProxyFixture();
      try {
        beginSpeakerTurn(entry).close();
        const original = lastRealtimeBridge();
        const failed = createRealtimeSessionMock();
        failed.connect.mockRejectedValueOnce(new Error("Voice provider unavailable"));
        createRealtimeVoiceBridgeSessionMock.mockReturnValueOnce(failed);
        await expect(
          selectionOwner().changeVoice("cedar", { assertCurrent: () => {} }),
        ).rejects.toThrow("Voice provider unavailable");
        expect(failed.close).toHaveBeenCalledOnce();
        expect(original.session.close).not.toHaveBeenCalled();
        expect(selectionOwner().read()).toMatchObject({ voice: "marin" });
        expect(manager.status()).toHaveLength(1);
      } finally {
        await manager.destroy();
      }
    });

    it("waits for microphone captures and moves all speakers to the same voice", async () => {
      useNativeVoices();
      resolveVoiceIngressWithParticipantsMock.mockImplementation(async ({ userId }) => ({
        senderIsOwner: userId === "owner",
        speakerLabel: userId,
      }));
      const { entry, manager } = await createJoinedAgentProxyFixture();
      try {
        beginSpeakerTurn(entry, { userId: "owner", senderIsOwner: true }).close();
        const owner = lastRealtimeBridge();
        const capture = beginSpeakerTurn(entry, { userId: "guest", senderIsOwner: false });
        const guest = lastRealtimeBridge();
        const switching = selectionOwner().changeVoice("cedar", { assertCurrent: () => {} });
        await Promise.resolve();
        expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(2);
        expect(owner.session.close).not.toHaveBeenCalled();
        expect(guest.session.close).not.toHaveBeenCalled();
        expect(selectionOwner().read()).toMatchObject({ voice: "marin" });
        capture.close();
        await switching;
        expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(4);
        expect(owner.session.close).toHaveBeenCalledExactlyOnceWith({ disposition: "detach" });
        expect(guest.session.close).toHaveBeenCalledExactlyOnceWith({ disposition: "detach" });
        expect(selectionOwner().read()).toMatchObject({ voice: "cedar" });
        beginSpeakerTurn(entry, { userId: "third", senderIsOwner: false }).close();
        expect(lastRealtimeBridge().bridgeParams.providerConfig).toMatchObject({ voice: "cedar" });
      } finally {
        await manager.destroy();
      }
    });

    it("closes candidates on cancellation and aborts retained delegation when the room leaves", async () => {
      useNativeVoices();
      const { entry, manager } = await createJoinedAgentProxyFixture();
      const connection = createDeferred<void>();
      try {
        beginSpeakerTurn(entry).close();
        const original = lastRealtimeBridge();
        const candidate = createRealtimeSessionMock();
        candidate.connect.mockReturnValueOnce(connection.promise);
        createRealtimeVoiceBridgeSessionMock.mockReturnValueOnce(candidate);
        const cancellation = new AbortController();
        const switching = selectionOwner().changeVoice("cedar", {
          assertCurrent: () => {},
          signal: cancellation.signal,
        });
        const rejected = expect(switching).rejects.toThrow("Cancelled voice change");
        await vi.waitFor(() => expect(candidate.connect).toHaveBeenCalled());
        cancellation.abort(new Error("Cancelled voice change"));
        await rejected;
        expect(candidate.close).toHaveBeenCalledOnce();
        expect(original.session.close).not.toHaveBeenCalled();
        const answer = createDeferred<{ payloads: Array<{ text: string }> }>();
        let sourceSignal: AbortSignal | undefined;
        agentCommandMock.mockImplementationOnce(async () => {
          const input = lastAgentCommandArgs();
          if (input.abortSignal instanceof AbortSignal) {
            sourceSignal = input.abortSignal;
          }
          await selectionOwner().changeVoice("cedar", { assertCurrent: () => {} });
          return await answer.promise;
        });
        const consultation = original.bridgeParams.runAgentConsult!({
          prompt: "Switch voice and check the agenda.",
        });
        const abandoned = expect(consultation).rejects.toThrow("Discord voice call closed");
        await vi.waitFor(() => expect(selectionOwner().read()).toMatchObject({ voice: "cedar" }));
        await manager.destroy();
        expect(sourceSignal?.aborted).toBe(true);
        answer.resolve({ payloads: [{ text: "Late reply" }] });
        await abandoned;
      } finally {
        connection.resolve();
        await manager.destroy();
      }
    });
  },
);
