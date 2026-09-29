import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  MeetingBrowserParticipationAdapter,
  MeetingParticipationSource,
} from "openclaw/plugin-sdk/meeting-runtime";

export type GoogleMeetChatSource = MeetingParticipationSource & {
  kind: "chat";
  speaker?: string;
  at?: string;
  historical?: boolean;
};

export type GoogleMeetChatSnapshot = { epoch: string; sources: GoogleMeetChatSource[] };

/** A model response cannot choose speech; only the original participant request can. */
export function explicitlyRequestsMeetChatVoice(text: string): boolean {
  if (
    /\b(?:do not|don't|never)\s+(?:\w+\s+){0,2}(?:speak|say|read|reply|answer|respond)\b|\bno\s+(?:voice|speech)\b|\b(?:not|never)\s+(?:aloud|out loud|by voice|using voice|verbally)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return /(?:^|[.!?\n]\s*)(?:@?[\p{L}\p{N}_-]+[,:]\s*)?(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you|i\s+(?:want|need)\s+you\s+to|i(?:'d|\s+would)\s+like\s+you\s+to)\s+(?:please\s+)?)?(?:answer|respond|reply|read|say|speak)\b[^\n.!?]{0,100}\b(?:aloud|out loud|by voice|using voice|verbally)\b/iu.test(
    text,
  );
}

type ObservedChatSource = { source: GoogleMeetChatSource; sourceId?: string };
type ChatObservationState = {
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  versions: Map<string, string>;
  jobs: Map<string, AbortController>;
  attempted: Set<string>;
  answers: Promise<void>;
  epoch?: string;
};

/** Plugin-owned incoming chat; all reply admission remains with the session owner. */
export class GoogleMeetChatObserver {
  readonly #sessions = new Map<string, ChatObservationState>();

  constructor(
    private readonly options: {
      isActive(sessionId: string): boolean;
      autoReply(sessionId: string): boolean;
      read(sessionId: string): Promise<GoogleMeetChatSnapshot>;
      observeEpoch(sessionId: string, epoch: string): boolean;
      observe(sessionId: string, source: GoogleMeetChatSource): string | undefined;
      assertCurrent(sessionId: string, sourceId: string): void;
      consult(params: {
        sessionId: string;
        source: GoogleMeetChatSource;
        context: GoogleMeetChatSource[];
        signal: AbortSignal;
      }): Promise<string>;
      reply(params: {
        sessionId: string;
        sourceId: string;
        requestId: string;
        text: string;
        output: "chat" | "voice";
      }): Promise<ReturnType<MeetingBrowserParticipationAdapter["parseActionResult"]>>;
      /** Held contributions may consume an explicit invitation without consulting again. */
      consumeInvitation?(sessionId: string, sourceId: string): Promise<boolean>;
      onError(sessionId: string, error: unknown): void;
    },
  ) {}

  async start(sessionId: string): Promise<void> {
    if (this.#sessions.has(sessionId)) {
      return;
    }
    const state: ChatObservationState = {
      controller: new AbortController(),
      versions: new Map(),
      jobs: new Map(),
      attempted: new Set(),
      answers: Promise.resolve(),
    };
    this.#sessions.set(sessionId, state);
    await this.#poll(sessionId, state);
  }

  stop(sessionId: string): void {
    const state = this.#sessions.get(sessionId);
    if (!state) {
      return;
    }
    this.#sessions.delete(sessionId);
    state.controller.abort();
    clearTimeout(state.timer);
    for (const job of state.jobs.values()) {
      job.abort();
    }
  }

  async #poll(sessionId: string, state: ChatObservationState): Promise<void> {
    if (!this.options.isActive(sessionId)) {
      this.stop(sessionId);
      return;
    }
    try {
      const { epoch, sources } = await this.options.read(sessionId);
      if (state.controller.signal.aborted) {
        return;
      }
      if (!this.options.isActive(sessionId)) {
        this.stop(sessionId);
        return;
      }
      if (!this.options.observeEpoch(sessionId, epoch)) {
        return;
      }
      if (state.epoch !== epoch) {
        for (const job of state.jobs.values()) {
          job.abort();
        }
        state.epoch = epoch;
      }
      const observed: ObservedChatSource[] = [];
      // Observe every revision before starting any consult. A corrected source
      // revokes the previous source handle while its model call is still running.
      for (const source of sources) {
        if (source.historical) {
          continue;
        }
        const sourceId = this.options.observe(sessionId, source);
        observed.push({ source, sourceId });
      }
      for (const { source, sourceId } of observed) {
        const key = JSON.stringify([source.epoch, source.id]);
        if (!sourceId) {
          // Expiry or capacity revocation can retire an unchanged native revision.
          state.jobs.get(key)?.abort();
        }
        if (state.versions.get(key) === source.revision) {
          continue;
        }
        state.versions.set(key, source.revision);
        state.jobs.get(key)?.abort();
        if (
          !sourceId ||
          !this.options.autoReply(sessionId) ||
          source.ownEcho !== false ||
          state.attempted.has(key)
        ) {
          continue;
        }
        const job = new AbortController();
        state.jobs.set(key, job);
        state.answers = state.answers.then(() =>
          this.#answer(sessionId, state, key, { source, sourceId }, sources, job),
        );
      }
      for (const key of state.versions.keys()) {
        if (state.versions.size <= 512) {
          break;
        }
        if (!state.jobs.has(key)) {
          state.versions.delete(key);
          state.attempted.delete(key);
        }
      }
    } catch (error) {
      if (!state.controller.signal.aborted) {
        this.options.onError(sessionId, error);
      }
    } finally {
      if (!state.controller.signal.aborted) {
        state.timer = setTimeout(() => void this.#poll(sessionId, state), 1_000);
        state.timer.unref?.();
      }
    }
  }

  async #answer(
    sessionId: string,
    state: ChatObservationState,
    key: string,
    entry: ObservedChatSource & { sourceId: string },
    context: GoogleMeetChatSource[],
    job: AbortController,
  ): Promise<void> {
    const assertCurrent = () => {
      job.signal.throwIfAborted();
      state.controller.signal.throwIfAborted();
      this.options.assertCurrent(sessionId, entry.sourceId);
    };
    try {
      assertCurrent();
      if (await this.options.consumeInvitation?.(sessionId, entry.sourceId)) {
        state.attempted.add(key);
        return;
      }
      assertCurrent();
      const consultation = this.options.consult({
        sessionId,
        source: entry.source,
        context,
        signal: job.signal,
      });
      // A canceled read-only consult cannot hold later answers hostage. Keep native
      // reply settlement below serialized even when its source is canceled.
      const canceled = createDeferred<never>();
      const onAbort = () => canceled.reject(job.signal.reason);
      job.signal.addEventListener("abort", onAbort, { once: true });
      if (job.signal.aborted) {
        onAbort();
      }
      const answer = await Promise.race([canceled.promise, consultation]).finally(() => {
        job.signal.removeEventListener("abort", onAbort);
      });
      assertCurrent();
      const trimmed = answer.trim();
      if (!trimmed || trimmed === "NO_REPLY") {
        return;
      }
      // An edited native message can supersede a pending answer, but it cannot
      // reopen an already attempted effect, including an uncertain send.
      state.attempted.add(key);
      const result = await this.options.reply({
        sessionId,
        sourceId: entry.sourceId,
        requestId: `chat-reply:${entry.sourceId}`,
        text: answer,
        output: explicitlyRequestsMeetChatVoice(entry.source.text) ? "voice" : "chat",
      });
      if (result.status !== "succeeded") {
        this.options.onError(
          sessionId,
          new Error(result.message ?? `The native chat reply ${result.status}.`),
        );
      }
    } catch (error) {
      if (!job.signal.aborted && !state.controller.signal.aborted) {
        this.options.onError(sessionId, error);
      }
    } finally {
      if (state.jobs.get(key) === job) {
        state.jobs.delete(key);
      }
    }
  }
}
