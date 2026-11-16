import { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { DiscordVoiceIngressContext } from "./ingress.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests((h) => {
  const { expect, it, vi } = h;
  const pendingAdmission = async () => {
    const { manager, entry } = await h.createJoinedAgentProxyFixture();
    const connection = h.getSessionConnection(entry);
    const admission = createDeferred<DiscordVoiceIngressContext | null>();
    h.resolveVoiceIngressWithParticipantsMock.mockReturnValue(admission.promise);
    vi.useFakeTimers();
    return { manager, entry, connection, admission };
  };
  const zeroTransitionConnection = () => {
    const connection = h.useConnection();
    const dave = Object.assign(connection.state.networking.state.dave, {
      lastTransitionId: 0,
      reinitializing: false,
      recoverFromInvalidTransition: vi.fn(),
    });
    return { connection, dave };
  };
  it("keeps Live microphone input open during playback without local interruption while recording", async () => {
    h.realtimeSessionMock.bridge.outputAudioMode = "continuous";
    h.resolveVoiceIngressWithParticipantsMock.mockResolvedValue({
      speakerLabel: "Speaker",
      senderIsOwner: true,
    });
    const { manager, entry, player } = await h.createJoinedAgentProxyFixture();
    await h.startTranscripts(manager, vi.fn());
    player.state.status = "playing";
    await h.receiveRecordedSpeech(manager, "A spoken interruption", entry);
    expect(h.realtimeSessionMock.sendAudio).toHaveBeenCalled();
    expect(h.realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
  });

  it("keeps exact capture and bidi conversation after destructive recovery", async () => {
    const { manager } = await h.createJoinedBidiFixture({
      allowFrom: ["discord:u-owner"],
      voice: { realtime: { requireWakeName: true } },
    });
    const onUtterance = vi.fn();
    expect(await h.startTranscripts(manager, onUtterance)).toMatchObject({ ok: true });
    await h.receiveRecordedSpeech(manager, "before recovery");
    await h.emitFinalRealtimeUserTranscript(h.lastRealtimeBridgeParams(), "before recovery");
    expect(onUtterance).toHaveBeenCalledOnce();
    const oldEntry = h.getSessionEntry(manager);
    h.emitDecryptFailure(manager);
    h.emitDecryptFailure(manager);
    h.emitDecryptFailure(manager);
    await vi.waitFor(() => expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(2));
    await h.receiveRecordedSpeech(manager, "after recovery");
    await h.emitFinalRealtimeUserTranscript(h.lastRealtimeBridgeParams(), "after recovery");
    expect(onUtterance).toHaveBeenCalledTimes(2);
    expect(h.agentCommandMock).not.toHaveBeenCalled();
    await h.receiveRecordedSpeech(manager, "stale connection", oldEntry);
    expect(onUtterance).toHaveBeenCalledTimes(2);
    expect(await h.stopTranscripts()).toMatchObject({ ok: true });
    h.expectConnectedStatus(manager, "1001");
    h.beginSpeakerTurn(h.getSessionEntry(manager));
    await h.lastRealtimeBridgeParams().onToolCall?.(
      {
        itemId: "consult-after-recovery",
        callId: "consult-after-recovery",
        name: "openclaw_agent_consult",
        args: { question: "what changed?" },
      },
      h.realtimeSessionMock,
    );
    expect(h.agentCommandMock).toHaveBeenCalledOnce();
    expect(onUtterance).toHaveBeenCalledTimes(2);
  });
  it("authorizes realtime speakers before subscribing receiver streams", async () => {
    const connection = h.useConnection();
    const client = h.createClientWithMember("u-denied", "Denied", "3333", "Denied Speaker");
    const manager = h.createManager(
      h.makeVoiceConfig(
        { mode: "bidi", realtime: { provider: "openai", model: "gpt-realtime-2" } },
        {
          groupPolicy: "allowlist",
          guilds: { g1: { channels: { "1001": { roles: ["role:voice-allowed"] } } } },
        },
      ),
      client,
    );

    await manager.join({ guildId: "g1", channelId: "1001" });
    const entry = h.getSessionEntry(manager);
    expect(entry.audio.playerStatus).toBe("idle");
    h.getLastAudioPlayer().state.status = "playing";

    await h.handleSpeakingStart(manager, entry, "u-denied");

    expect(connection.receiver.subscribe).not.toHaveBeenCalled();
    expect(h.realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
    expect(client.fetchMember).toHaveBeenCalledWith("g1", "u-denied");
  });

  it("owns start/end/start during realtime admission without subscribing before authorization", async () => {
    const { manager, entry, connection, admission } = await pendingAdmission();
    try {
      const first = h.handleSpeakingStart(manager, entry, "u-speaker");
      h.getVoiceReceive(manager).scheduleCaptureFinalize(entry, "u-speaker");
      const resumed = h.handleSpeakingStart(manager, entry, "u-speaker");
      expect(h.resolveVoiceIngressWithParticipantsMock).toHaveBeenCalledOnce();
      expect(connection.receiver.subscribe).not.toHaveBeenCalled();
      expect(h.decodeOpusStreamChunksMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(entry.capture.size).toBe(1);

      admission.resolve({ speakerLabel: "Speaker", senderIsOwner: false });
      await Promise.all([first, resumed]);
      expect(connection.receiver.subscribe).toHaveBeenCalledOnce();
      expect(h.decodeOpusStreamChunksMock).toHaveBeenCalledOnce();
      expect(entry.capture.size).toBe(0);
    } finally {
      admission.resolve(null);
      await manager.destroy();
      vi.useRealTimers();
    }
  });

  it.each(["failed", "stopped", "silence expired"] as const)(
    "retires %s realtime admission without a late subscription",
    async (reason) => {
      const { manager, entry, connection, admission } = await pendingAdmission();
      try {
        const completion = h.handleSpeakingStart(manager, entry, "u-speaker");
        const outcome =
          reason === "failed"
            ? expect(completion).rejects.toThrow("admission failed")
            : expect(completion).resolves.toBeUndefined();
        h.getVoiceReceive(manager).scheduleCaptureFinalize(entry, "u-speaker");
        expect(connection.receiver.subscribe).not.toHaveBeenCalled();
        if (reason === "stopped") {
          await manager.destroy();
        } else if (reason === "silence expired") {
          await vi.advanceTimersByTimeAsync(2_500);
        }
        if (reason === "failed") {
          admission.reject(new Error("admission failed"));
        } else {
          admission.resolve({ speakerLabel: "Speaker", senderIsOwner: false });
        }
        await outcome;
        await vi.advanceTimersByTimeAsync(2_500);
        expect(connection.receiver.subscribe).not.toHaveBeenCalled();
        expect(h.decodeOpusStreamChunksMock).not.toHaveBeenCalled();
        expect(entry.capture.size).toBe(0);
      } finally {
        admission.resolve(null);
        await manager.destroy();
        vi.useRealTimers();
      }
    },
  );

  it("invalidates transition zero before re-arming receive passthrough", async () => {
    const { connection, dave } = zeroTransitionConnection();
    const manager = h.createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });
    connection.daveSetPassthroughMode.mockClear();

    await h.emitWorkerReceiveFailure(manager);

    expect(dave.recoverFromInvalidTransition).toHaveBeenCalledOnce();
    expect(dave.recoverFromInvalidTransition).toHaveBeenCalledWith(0);
    expect(connection.daveSetPassthroughMode).toHaveBeenCalledWith(true, 15);
    expect(dave.recoverFromInvalidTransition.mock.invocationCallOrder[0]).toBeLessThan(
      connection.daveSetPassthroughMode.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not invalidate resuming networking", async () => {
    const { connection, dave } = zeroTransitionConnection();
    const manager = h.createManager();
    await manager.join({ guildId: "g1", channelId: "1001" });
    connection.state.networking.state.code = "networking-resuming";
    await h.emitWorkerReceiveFailure(manager);
    expect(dave.recoverFromInvalidTransition).not.toHaveBeenCalled();
  });

  it("retires native DAVE receive callbacks when the session is replaced", async () => {
    const { connection, dave } = zeroTransitionConnection();
    h.joinVoiceChannelMock.mockReturnValueOnce(h.createConnectionMock());
    const manager = h.createManager();
    await manager.join({ guildId: "g1", channelId: "1001" });
    const capture = await h.openWorkerReceiveCapture(manager);
    await manager.join({ guildId: "g1", channelId: "1002" });
    await capture.receiving;
    expect(capture.source.destroyed).toBe(true);
    expect(capture.source.listenerCount("error")).toBe(0);
    expect(capture.entry.sessionLifecycle.status).toBe("stopped");
    const lateFault = vi.fn();
    capture.source.on("error", lateFault);
    capture.source.emit("error", new Error("DecryptionFailed(UnencryptedWhenPassthroughDisabled)"));
    capture.source.off("error", lateFault);
    expect(lateFault).toHaveBeenCalledOnce();
    expect(dave.recoverFromInvalidTransition).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(2);
    h.expectConnectedStatus(manager, "1002");
  });

  it("keeps passthrough and bounded rejoin when zero-transition recovery throws", async () => {
    const { connection, dave } = zeroTransitionConnection();
    dave.recoverFromInvalidTransition.mockImplementation(() => {
      throw new Error("voice gateway unavailable");
    });
    h.useConnection();
    const manager = h.createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });
    connection.daveSetPassthroughMode.mockClear();

    await h.emitWorkerReceiveFailure(manager);
    await h.emitWorkerReceiveFailure(manager);
    await h.emitWorkerReceiveFailure(manager);

    await vi.waitFor(() => {
      expect(connection.daveSetPassthroughMode).toHaveBeenCalledWith(true, 15);
      expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(2);
    });
  });

  it.each([false, true])(
    "does not rejoin during native DAVE recovery (stopped=%s)",
    async (stopped) => {
      const connection = h.useConnection();
      const stopEntry: { current?: () => void } = {};
      const { dave } = h.installFailingDaveSession(connection, "native", () =>
        stopEntry.current?.(),
      );
      const manager = h.createManager();
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = h.getSessionEntry(manager);
      if (stopped) {
        stopEntry.current = () => {
          void entry.stop();
        };
      } else {
        entry.receiveRecovery.decryptRecoveryInFlight = true;
      }
      connection.daveSetPassthroughMode.mockClear();
      await h.emitWorkerReceiveFailure(manager);
      expect(dave.reinitializing).toBe(true);
      expect(entry.receiveRecovery.decryptRecoveryInFlight).toBe(!stopped);
      expect(connection.destroy).toHaveBeenCalledTimes(stopped ? 1 : 0);
      expect(connection.daveSetPassthroughMode).not.toHaveBeenCalled();
      expect(h.joinVoiceChannelMock).toHaveBeenCalledOnce();
    },
  );

  it("suppresses followed-user reconciliation until the poisoned-DAVE cooldown expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    h.makePoisonedDaveConnections(1);
    const client = h.createClient();
    client.rest.get.mockResolvedValue({
      guild_id: "g1",
      user_id: "u-owner",
      channel_id: "1001",
    });
    const manager = h.createFollowManager({}, client, { guilds: { g1: {} } });

    try {
      await manager.autoJoin();
      await h.emitWorkerReceiveFailure(manager);
      await vi.waitFor(() => expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      await h.emitWorkerReceiveFailure(manager);
      expect(manager.status()).toEqual([]);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(2);
      const followedUsers = h.getVoiceFollowing(manager).followedUserChannels;
      expect(followedUsers.get("g1:u-owner")?.channelId).toBe("1001");

      await vi.advanceTimersByTimeAsync(20_000);

      expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(3);
      h.expectConnectedStatus(manager, "1001");
    } finally {
      await manager.destroy();
      vi.useRealTimers();
    }
  });

  it("follows a user who leaves and rejoins the same channel during a DAVE cooldown", async () => {
    h.makePoisonedDaveConnections(1);
    const manager = h.createFollowManager();

    await h.updateVoiceState(manager, "u-owner", "1001");
    await h.emitWorkerReceiveFailure(manager);
    await vi.waitFor(() => expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(2));
    await h.emitWorkerReceiveFailure(manager);

    await h.updateVoiceState(manager, "u-owner", null);
    await h.updateVoiceState(manager, "u-owner", "1001");

    expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(3);
    h.expectConnectedStatus(manager, "1001");
  });

  it("allows a poisoned-DAVE reconnect after the existing failure window expires", async () => {
    const firstConnection = h.useConnection();
    h.installFailingDaveSession(firstConnection, "native");
    h.useConnection();
    const manager = h.createManager();

    await manager.join({ guildId: "g1", channelId: "1001" });
    const attempts = h.getVoiceReceive(manager).daveRecoveryAttempts;
    attempts.set("g1", Date.now() - h.DECRYPT_FAILURE_WINDOW_MS);
    attempts.set("other-guild", Date.now());

    await h.emitWorkerReceiveFailure(manager);

    await vi.waitFor(() => expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(2));
    expect(attempts.has("other-guild")).toBe(true);
  });

  it("streams realtime with batch transcription disabled and resets receive recovery", async () => {
    const { manager, entry } = await h.createJoinedAgentProxyFixture({
      config: { allowFrom: ["discord:u-speaker"] },
      cfg: { tools: { media: { audio: { enabled: false } } } },
    });
    h.emitDecryptFailure(manager);
    h.emitDecryptFailure(manager);
    const attempts = h.getVoiceReceive(manager).daveRecoveryAttempts;
    attempts.set("g1", Date.now());
    expect(entry.receiveRecovery.decryptFailureCount).toBe(2);
    await h.receiveRecordedSpeech(manager, undefined, entry, "u-speaker");
    expect(h.decodeOpusStreamChunksMock).toHaveBeenCalledOnce();
    expect(h.realtimeSessionMock.sendAudio).toHaveBeenCalled();
    expect(h.transcribeAudioFileMock).not.toHaveBeenCalled();
    expect(h.loggerWarnMock).not.toHaveBeenCalledWith(
      expect.stringContaining("audio understanding is disabled"),
    );
    expect(entry.receiveRecovery).toMatchObject({
      decryptFailureCount: 0,
      lastDecryptFailureAt: 0,
    });
    expect(attempts.has("g1")).toBe(false);
    expect(h.joinVoiceChannelMock).toHaveBeenCalledOnce();
  });

  it.each([
    { mode: "bidi", captureOnly: false },
    { mode: "stt-tts", captureOnly: false },
    { mode: "stt-tts", captureOnly: true },
  ] as const)(
    "resets recovery once per stream while other speakers fail in $mode (captureOnly=$captureOnly)",
    async ({ mode, captureOnly }) => {
      const connection = h.useConnection();
      const manager = h.createManager(
        h.makeVoiceConfig(
          { mode, realtime: { provider: "openai" } },
          { groupPolicy: "open", allowFrom: ["discord:u-speaker", "discord:u-failing"] },
        ),
      );
      if (captureOnly) {
        expect(await h.startTranscripts(manager)).toMatchObject({ ok: true });
      } else {
        expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({
          ok: true,
        });
      }
      const entry = h.getSessionEntry(manager);
      let consumed = createDeferred<void>();
      const send = entry.audio.send.bind(entry.audio);
      vi.spyOn(entry.audio, "send").mockImplementation((command, transferList) => {
        send(command, transferList);
        if (command.type === "capture-ack") {
          consumed.resolve();
        }
      });
      h.decodeOpusStreamChunksMock.mockImplementation(async (input, callbacks) => {
        for await (const packet of input) {
          await callbacks.onChunk(Buffer.alloc(packet[0] === 0 ? 0 : 3_840), packet);
        }
      });
      const openStream = async (userId: string) => {
        const stream = new PassThrough({ objectMode: true });
        const subscribed = createDeferred<void>();
        connection.receiver.subscribe.mockImplementationOnce(() => {
          subscribed.resolve();
          return stream;
        });
        const receiving = h.handleSpeakingStart(manager, entry, userId);
        await subscribed.promise;
        return { stream, receiving };
      };
      const failOtherSpeaker = async () => {
        const other = await openStream("u-failing");
        // The native receiver destroys the speaker's subscription when decryption fails.
        other.stream.destroy(new Error("DecryptionFailed(InvalidCiphertext)"));
        await other.receiving;
      };
      const writePacket = async (stream: PassThrough, marker: number) => {
        consumed = createDeferred<void>();
        stream.write(Buffer.from([marker]));
        // Decoder completion only posts IPC. The credit acknowledges that the
        // parent consumed this frame and finished the recovery-state update.
        await consumed.promise;
      };
      const openHealthyStream = async () => {
        await failOtherSpeaker();
        await failOtherSpeaker();
        const attempts = h.getVoiceReceive(manager).daveRecoveryAttempts;
        attempts.set("g1", Date.now());
        const healthy = await openStream("u-speaker");
        await writePacket(healthy.stream, 0);
        expect(entry.receiveRecovery.decryptFailureCount).toBe(2);
        expect(attempts.has("g1")).toBe(true);
        await writePacket(healthy.stream, 1);
        expect(entry.receiveRecovery).toMatchObject({
          decryptFailureCount: 0,
          lastDecryptFailureAt: 0,
        });
        expect(attempts.has("g1")).toBe(false);
        return healthy;
      };

      const first = await openHealthyStream();
      first.stream.end();
      await first.receiving;
      await entry.processingQueue;
      // A fresh stream on the same entry still gets its own successful-audio reset.
      const healthy = await openHealthyStream();
      try {
        for (let failure = 1; failure <= 3; failure++) {
          await failOtherSpeaker();
          if (failure < 3) {
            await writePacket(healthy.stream, 1);
            expect(connection.destroy).not.toHaveBeenCalled();
          }
        }
        await vi.waitFor(() => {
          expect(h.joinVoiceChannelMock).toHaveBeenCalledTimes(2);
          expect(h.getSessionEntry(manager)).not.toBe(entry);
          h.expectConnectedStatus(manager, "1001");
        });
        expect(connection.destroy).toHaveBeenCalledOnce();
        expect(healthy.stream.destroyed).toBe(true);
        if (captureOnly) {
          expect(h.realtimeSessionMock.sendAudio).not.toHaveBeenCalled();
          expect(h.agentCommandMock).not.toHaveBeenCalled();
        }
      } finally {
        healthy.stream.destroy();
        await healthy.receiving;
        await manager.destroy();
      }
    },
  );

  it.each(["decoder", "abort"] as const)(
    "settles receive streams after a %s error",
    async (failure) => {
      const decoder = failure === "decoder";
      const connection = h.useConnection();
      const stream = new PassThrough({ objectMode: true });
      h.decodeOpusStreamChunksMock.mockImplementationOnce(async (input, params) => {
        for await (const packet of input) {
          const error = new Error(
            decoder ? "memory access out of bounds" : "The operation was aborted",
          );
          if (decoder) {
            params.onError?.(error);
            stream.emit("error", error);
            await params.onChunk(Buffer.alloc(8), packet);
          } else {
            await params.onChunk(Buffer.alloc(48_000), packet);
            error.name = "AbortError";
            params.onError?.(error);
          }
        }
      });
      const manager = h.createManager(
        h.makeVoiceConfig(
          decoder ? { mode: "agent-proxy", realtime: { provider: "openai" } } : {},
          { groupPolicy: "open", allowFrom: ["discord:u-speaker"] },
        ),
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = h.getSessionEntry(manager);
      const conversations = vi.spyOn(entry.conversations, "enqueue");
      connection.receiver.subscribe.mockReturnValueOnce(stream);
      const receiving = h.handleSpeakingStart(manager, entry, "u-speaker");
      stream.end(Buffer.from("opus-packet"));
      await receiving;
      await entry.processingQueue;
      await Promise.all(conversations.mock.results.map((result) => result.value));
      expect(stream.destroyed).toBe(true);
      expect(h.transcribeAudioFileMock).toHaveBeenCalledTimes(decoder ? 0 : 1);
      expect(entry.receiveRecovery.decryptFailureCount).toBe(decoder ? 1 : 0);
      if (decoder) {
        expect(stream.listenerCount("error")).toBe(0);
        expect(entry.capture.has("u-speaker")).toBe(false);
        expect(entry.receiveRecovery.lastDecryptFailureAt).toBeGreaterThan(0);
      }
    },
  );
});
