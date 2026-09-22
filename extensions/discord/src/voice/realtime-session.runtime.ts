import { randomUUID } from "node:crypto";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  registerRealtimeVoiceSelection,
  type RealtimeVoiceCloseDisposition,
  type RealtimeVoiceSelectionHandle,
  type RealtimeVoiceSelectionRequest,
  type RealtimeVoiceTranscriptEntry,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { DiscordRealtimePlayer } from "./realtime-player.js";
import type { DiscordRealtimeRecordingInput } from "./realtime-recording.js";
import {
  DiscordRealtimeSpeakerSession,
  type DiscordRealtimeSessionParams,
} from "./realtime-speaker-session.js";
import type {
  VoiceRealtimeSession,
  VoiceRealtimeSpeakerContext,
  VoiceRealtimeSpeakerTurn,
  VoiceSessionEntry,
} from "./session.js";

const logger = createSubsystemLogger("discord/voice");
const MAX_REALTIME_SPEAKERS = 8;
const REALTIME_SPEAKER_IDLE_MS = 60_000;

type SpeakerSession = {
  userId: string;
  senderIsOwner: boolean;
  transcripts: VoiceSessionEntry["transcripts"];
  session: DiscordRealtimeSpeakerSession;
};

/** The room shares its agent and player; each provider connection has one immutable speaker. */
export class DiscordRealtimeVoiceSession implements VoiceRealtimeSession {
  private readonly player: DiscordRealtimePlayer;
  private readonly speakers = new Map<string, SpeakerSession>();
  private readonly sessions = new Set<SpeakerSession>();
  private warmSession: DiscordRealtimeSpeakerSession | undefined;
  private nextSessionId = 0;
  private closed = false;
  private readonly closingSpeakers = new Set<Promise<void>>();
  private closeCompletion: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private voiceSelection: RealtimeVoiceSelectionHandle | undefined;
  private voiceOverride: string | undefined;
  private changingVoice = false;
  private readonly callAbort = new AbortController();
  private readonly candidates = new Set<DiscordRealtimeSpeakerSession>();

  constructor(private readonly params: DiscordRealtimeSessionParams) {
    this.player = new DiscordRealtimePlayer(params.entry.player);
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("Discord realtime voice session is closed");
    }
    const session = this.createSession();
    this.warmSession = session;
    await session.connect();
    if (this.closed) {
      await this.closeSpeaker(session);
      return;
    }
    this.voiceSelection = registerRealtimeVoiceSelection({
      voiceSessionId: `discord:${this.params.entry.voiceSessionKey}:${randomUUID()}`,
      agentId: this.params.entry.route.agentId,
      sessionKey: this.params.entry.route.sessionKey,
      read: () => this.currentSession().readVoiceSelection(),
      changeVoice: (voice, request) => this.changeVoice(voice, request),
      assertCurrent: () => this.assertOpen(),
    });
    this.idleTimer = setInterval(() => this.releaseIdleSpeakers(), REALTIME_SPEAKER_IDLE_MS);
    this.idleTimer.unref?.();
  }

  close(disposition: RealtimeVoiceCloseDisposition = "abort"): void | Promise<void> {
    if (this.closed) {
      return this.closeCompletion;
    }
    this.closed = true;
    this.voiceSelection?.unregister();
    if (disposition === "abort") {
      this.callAbort.abort(new Error("Discord voice call closed"));
    }
    clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    // Retire the physical player first: lane teardown must not start the next queued response.
    this.player.close();
    if (this.warmSession) {
      void this.closeSpeaker(this.warmSession, disposition);
      this.warmSession = undefined;
    }
    for (const { session } of this.sessions) {
      void this.closeSpeaker(session, disposition);
    }
    for (const session of this.candidates) {
      void this.closeSpeaker(session, disposition);
    }
    this.candidates.clear();
    this.speakers.clear();
    this.sessions.clear();
    if (this.closingSpeakers.size > 0) {
      this.closeCompletion = Promise.allSettled(this.closingSpeakers).then(() => undefined);
    }
    return this.closeCompletion;
  }

  beginSpeakerTurn(
    context: VoiceRealtimeSpeakerContext,
    userId: string,
    recordingInput?: DiscordRealtimeRecordingInput,
  ): VoiceRealtimeSpeakerTurn {
    if (this.closed) {
      throw new Error("Discord realtime voice session is closed");
    }
    if (this.changingVoice) {
      throw new Error(
        "Discord voice is reconnecting. Please speak again when the voice change finishes.",
      );
    }
    for (const previous of this.sessions) {
      if (previous.userId === userId && previous.senderIsOwner !== context.senderIsOwner) {
        this.retireSpeaker(previous, "admission-changed");
      }
    }
    let speaker = this.speakers.get(userId);
    const transcripts = recordingInput?.initialReceipt
      ? recordingInput.initialReceipt.capture
      : this.params.entry.transcripts;
    if (speaker && speaker.transcripts !== transcripts) {
      // Subscription replacement fences transcript delivery, but must not cut a valid spoken
      // answer short. The old connection drains with its original source and receives no new input.
      this.speakers.delete(userId);
      speaker.session.drain();
      speaker = undefined;
    }
    if (!speaker) {
      this.releaseIdleSpeakers();
      if (this.sessions.size >= MAX_REALTIME_SPEAKERS) {
        const message = "Voice is busy with other speakers. Please try again after their replies.";
        this.notify(message);
        throw new Error(message);
      }
      const warm = this.warmSession;
      this.warmSession = undefined;
      const session = warm ?? this.createSession();
      speaker = {
        userId,
        senderIsOwner: context.senderIsOwner,
        transcripts,
        session,
      };
      this.speakers.set(userId, speaker);
      this.sessions.add(speaker);
      if (!warm) {
        // Provider queues own pre-ready audio; create the bridge synchronously before capture
        // sends its first chunk, while connection errors remain local to this speaker.
        void session.connect().catch((error: unknown) => this.handleSpeakerFailure(session, error));
      }
    }
    return speaker.session.beginSpeakerTurn(context, userId, recordingInput);
  }

  canReceiveDuringPlayback(): boolean {
    const session = this.warmSession ?? this.sessions.values().next().value?.session;
    return session?.canReceiveDuringPlayback() ?? false;
  }

  private createSession(
    voice = this.voiceOverride,
    previous?: DiscordRealtimeSpeakerSession,
  ): DiscordRealtimeSpeakerSession {
    const session = new DiscordRealtimeSpeakerSession({
      ...this.params,
      player: this.player,
      sessionId: `discord:${this.params.entry.voiceSessionKey}:realtime:${++this.nextSessionId}`,
      voiceOverride: voice,
      standby: previous !== undefined,
      conversationHistory: previous?.snapshotConversation(),
      runAgentTurn: async (turn) => {
        const signal = turn.signal
          ? AbortSignal.any([turn.signal, this.callAbort.signal])
          : this.callAbort.signal;
        const text = await this.params.runAgentTurn({
          ...turn,
          signal,
          voiceSelection: this.voiceSelection,
        });
        signal.throwIfAborted();
        return text;
      },
      onTerminalError: (error) => this.handleSpeakerFailure(session, error),
    });
    return session;
  }

  private handleSpeakerFailure(session: DiscordRealtimeSpeakerSession, error: unknown): void {
    if (this.closed) {
      return;
    }
    if (this.warmSession === session) {
      this.params.onTerminalError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const speaker of this.sessions) {
      if (speaker.session !== session) {
        continue;
      }
      logger.warn(
        `discord voice: realtime speaker failed user=${speaker.userId}: ${formatErrorMessage(error)}`,
      );
      this.retireSpeaker(speaker, "provider-failed");
      this.notify("I lost a speaker's voice connection. Please try speaking again.");
      return;
    }
  }

  private notify(text: string): void {
    const session = this.warmSession ?? this.sessions.values().next().value?.session;
    session?.notify(text);
  }

  private assertOpen(): void {
    this.callAbort.signal.throwIfAborted();
    if (this.closed) {
      throw new Error("Discord voice call is closed");
    }
  }

  private currentSession(): DiscordRealtimeSpeakerSession {
    this.assertOpen();
    const session = this.warmSession ?? this.speakers.values().next().value?.session;
    if (!session) {
      throw new Error("Discord voice connection is not available");
    }
    return session;
  }

  private async changeVoice(voice: string, request: RealtimeVoiceSelectionRequest): Promise<void> {
    this.assertOpen();
    request.assertCurrent();
    const selection = this.currentSession().readVoiceSelection();
    if (!selection.canChange) {
      throw new Error(
        "This Discord voice connection cannot change voices. Configure a voice and rejoin.",
      );
    }
    const signal = request.signal
      ? AbortSignal.any([this.callAbort.signal, request.signal])
      : this.callAbort.signal;
    const previousOverride = this.voiceOverride;
    const previousVoice = selection.voice;
    const originalWarm = this.warmSession;
    const originalSpeakers = [...this.speakers.values()];
    const originalSessions = [...this.sessions];
    const originals = [
      ...(originalWarm ? [originalWarm] : []),
      ...originalSessions.map((speaker) => speaker.session),
    ];
    const replacements = new Map<DiscordRealtimeSpeakerSession, DiscordRealtimeSpeakerSession>();
    const checkpoints = new Map<
      DiscordRealtimeSpeakerSession,
      RealtimeVoiceTranscriptEntry | undefined
    >();
    let retired = false;
    let adopted = false;
    const assertOriginals = () => {
      this.assertOpen();
      if (
        this.warmSession !== originalWarm ||
        this.speakers.size !== originalSpeakers.length ||
        originalSpeakers.some((speaker) => this.speakers.get(speaker.userId) !== speaker) ||
        originals.some((session) => session.hasActiveInput())
      ) {
        throw new Error("Discord speakers changed while switching voices. Please try again.");
      }
    };
    const discardCandidates = async () => {
      const discarded = [...replacements.values()];
      replacements.clear();
      for (const candidate of discarded) {
        this.candidates.delete(candidate);
      }
      await Promise.allSettled(
        discarded.map((candidate) => Promise.resolve(this.closeSpeaker(candidate))),
      );
    };
    const prepare = async (
      targetVoice: string | undefined,
      preparationSignal: AbortSignal,
      assertCurrent: () => void,
    ) => {
      for (const original of originals) {
        preparationSignal.throwIfAborted();
        assertCurrent();
        const previous = replacements.get(original);
        if (previous && checkpoints.get(original) === original.conversationCheckpoint()) {
          continue;
        }
        if (previous) {
          replacements.delete(original);
          this.candidates.delete(previous);
          await this.closeSpeaker(previous);
          preparationSignal.throwIfAborted();
          assertCurrent();
        }
        checkpoints.set(original, original.conversationCheckpoint());
        const candidate = this.createSession(targetVoice, original);
        this.candidates.add(candidate);
        replacements.set(original, candidate);
        await this.connectCandidate(candidate, preparationSignal);
        assertCurrent();
        if (targetVoice && candidate.readVoiceSelection().voice !== targetVoice) {
          throw new Error("Discord voice provider did not select the requested voice");
        }
      }
    };
    const adopt = (override: string | undefined) => {
      for (const candidate of replacements.values()) {
        candidate.readVoiceSelection();
      }
      for (const candidate of replacements.values()) {
        candidate.activateOutput();
        this.candidates.delete(candidate);
      }
      this.voiceOverride = override;
      if (originalWarm) {
        this.warmSession = replacements.get(originalWarm);
      }
      for (const original of originalSessions) {
        this.sessions.delete(original);
      }
      for (const speaker of originalSessions) {
        const replacement = { ...speaker, session: replacements.get(speaker.session)! };
        if (this.speakers.get(speaker.userId) === speaker) {
          this.speakers.set(speaker.userId, replacement);
        }
        this.sessions.add(replacement);
      }
      for (const [original, replacement] of replacements) {
        original.transferPendingSpeechTo(replacement);
      }
      adopted = true;
    };
    try {
      await Promise.all(originals.map((session) => session.waitForInputIdle(signal)));
      await prepare(voice, signal, request.assertCurrent);
      await Promise.all(originals.map((session) => session.waitForInputIdle(signal)));
      signal.throwIfAborted();
      request.assertCurrent();
      assertOriginals();
      this.changingVoice = true;
      retired = true;
      // Provider close drains final speech, not accepted agent work. The source harness retains
      // that completed history so replacements can include tails delivered during cleanup.
      const pendingDrains: Promise<void>[] = [];
      this.player.transition(() => {
        for (const original of originals) {
          pendingDrains.push(Promise.resolve(this.closeSpeaker(original, "detach")));
        }
      });
      const drains = await Promise.allSettled(pendingDrains);
      const failedDrain = drains.find((result) => result.status === "rejected");
      if (failedDrain?.status === "rejected") {
        throw toErrorObject(failedDrain.reason, "Discord voice transcript cleanup failed");
      }
      await prepare(voice, signal, request.assertCurrent);
      signal.throwIfAborted();
      request.assertCurrent();
      assertOriginals();
      adopt(voice);
      logger.info(`discord voice: voice changed guild=${this.params.entry.guildId} voice=${voice}`);
    } catch (error) {
      if (retired && !this.callAbort.signal.aborted) {
        await discardCandidates();
        try {
          // The former sockets are closed. Recovery recreates their previous voice and final
          // history under the room lifecycle, even if the requesting tool timed out or was cancelled.
          await prepare(previousVoice, this.callAbort.signal, assertOriginals);
          assertOriginals();
          adopt(previousOverride);
        } catch (recoveryError) {
          await discardCandidates();
          this.callAbort.signal.throwIfAborted();
          const failure = new Error(
            `Discord voice change failed and the previous voice could not reconnect: ${formatErrorMessage(recoveryError)}. Join voice again to retry.`,
          );
          void this.close("detach");
          this.params.onTerminalError(failure);
          throw failure;
        }
        throw new Error(
          `Discord voice change failed; the previous voice was restored: ${formatErrorMessage(error)}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (!adopted) {
        await discardCandidates();
      }
      if (retired) {
        this.changingVoice = false;
      }
    }
  }

  private async connectCandidate(
    session: DiscordRealtimeSpeakerSession,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        session.connect(),
        new Promise<never>((_resolve, reject) => {
          abort = () => {
            void this.closeSpeaker(session);
            reject(toErrorObject(signal?.reason, "Discord voice change cancelled"));
          };
          signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (abort) {
        signal?.removeEventListener("abort", abort);
      }
    }
  }

  private releaseIdleSpeakers(): void {
    if (this.changingVoice) {
      return;
    }
    const cutoff = Date.now() - REALTIME_SPEAKER_IDLE_MS;
    for (const speaker of this.sessions) {
      const reason = speaker.session.releaseReasonBefore(cutoff);
      if (reason) {
        this.retireSpeaker(speaker, reason);
      }
    }
  }

  private closeSpeaker(
    session: DiscordRealtimeSpeakerSession,
    disposition: RealtimeVoiceCloseDisposition = "abort",
  ): void | Promise<void> {
    let completion: void | Promise<void>;
    try {
      completion = session.close(disposition);
    } catch (error) {
      if (disposition !== "detach") {
        logger.warn(`discord voice: realtime speaker close failed: ${formatErrorMessage(error)}`);
        return;
      }
      completion = Promise.reject(toErrorObject(error, "Discord realtime speaker cleanup failed"));
    }
    if (completion) {
      const pending = completion;
      this.closingSpeakers.add(pending);
      const forget = () => {
        this.closingSpeakers.delete(pending);
      };
      void pending.then(forget, (error: unknown) => {
        forget();
        logger.warn(`discord voice: realtime speaker close failed: ${formatErrorMessage(error)}`);
      });
    }
    return completion;
  }

  private retireSpeaker(speaker: SpeakerSession, reason: string): void {
    // A draining generation can finish after this user's replacement has started.
    if (this.speakers.get(speaker.userId) === speaker) {
      this.speakers.delete(speaker.userId);
    }
    this.sessions.delete(speaker);
    void this.closeSpeaker(speaker.session);
    logger.info(
      `discord voice: realtime speaker retired user=${speaker.userId} reason=${reason}${reason === "input-timeout" ? "; idle speaker input expired; speak again to reconnect" : ""}`,
    );
  }
}
