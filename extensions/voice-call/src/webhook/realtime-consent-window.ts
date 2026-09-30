/**
 * Watchdog for the realtime consent question.
 *
 * The model is instructed to give the caller a few seconds to answer the opening consent
 * question and then apologise and hang up on silence, but nothing in the bridge ever *wakes* the
 * model on silence — it just sits on an open line. When the explicit consent flow is enabled, this
 * arms a single timer after the first completed assistant turn and, if the caller never speaks,
 * tells the caller-facing code the window expired so it can prompt the goodbye and end the call.
 *
 * Deliberately narrow: config, rather than transcript punctuation, admits the flow. With the
 * default-off opt-in disabled, assistant turns never arm it. Once the caller has spoken, the
 * watchdog is disarmed permanently. A response that arrives after the window fired is still
 * recorded so the caller-facing code can tell "never answered" apart from "answered late".
 */
export type RealtimeConsentWindowOptions = {
  /** Whether this call is running the explicit opening-consent flow. */
  enabled: boolean;
  /** How long the caller is given to answer once the bot has stopped speaking. */
  windowMs: number;
  /**
   * Extra time added to the answer window when carrier playback was never confirmed. The window
   * must not pretend an unconfirmed question reached the caller: the bounded no-ack escape path
   * still runs, but it starts from a conservative point rather than the normal full window.
   */
  windowMsExtension?: () => number;
  /** How often to re-check while the bot is still speaking. */
  pollMs: number;
  /** True while the agent's own audio is still draining, so the countdown has not started. */
  isBotSpeaking: () => boolean;
  /** True while this bridge still owns the call; a stale bridge must not fire. */
  isCallActive: () => boolean;
  /** Called exactly once, after the caller has stayed silent for the whole window. */
  onExpired: () => void;
  /** Called when a caller response arrives after the window already fired. */
  onLateResponse?: () => void;
};

export class RealtimeConsentWindow {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private armed = false;
  private fired = false;
  private callerResponded = false;

  constructor(private readonly options: RealtimeConsentWindowOptions) {}

  /** Record the completed opening turn; only the explicit consent flow can arm the timer. */
  noteAssistantTurn(): void {
    if (!this.options.enabled || this.fired || this.callerResponded || this.armed) {
      return;
    }
    this.armed = true;
    this.arm();
  }

  /**
   * The carrier confirmed the consent question actually played. Restart the answer deadline so the
   * caller's full configured window is measured from confirmed playback rather than from the
   * earlier bounded no-ack fallback that may have resolved the mark first.
   */
  notePlaybackConfirmed(): void {
    if (!this.options.enabled || this.fired || this.callerResponded || !this.armed) {
      return;
    }
    this.arm();
  }

  /** The caller said something; the consent gate is satisfied and the watchdog must never fire. */
  noteCallerResponded(): void {
    const firstResponse = !this.callerResponded;
    this.callerResponded = true;
    this.clearTimer();
    if (this.fired && firstResponse) {
      this.options.onLateResponse?.();
    }
  }

  /** Stop the watchdog without marking the caller as having responded (call teardown). */
  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private effectiveWindowMs(): number {
    return this.options.windowMs + (this.options.windowMsExtension?.() ?? 0);
  }

  private arm(): void {
    if (this.callerResponded || this.fired) {
      return;
    }
    this.clearTimer();
    const countdown = (): void => {
      this.timer = undefined;
      if (this.callerResponded || this.fired || !this.options.isCallActive()) {
        return;
      }
      if (this.options.isBotSpeaking()) {
        this.timer = setTimeout(countdown, this.options.pollMs);
        this.timer.unref?.();
        return;
      }
      this.timer = setTimeout(() => this.fire(), this.effectiveWindowMs());
      this.timer.unref?.();
    };
    this.timer = setTimeout(countdown, this.options.pollMs);
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = undefined;
    if (this.callerResponded || this.fired || !this.options.isCallActive()) {
      return;
    }
    if (this.options.isBotSpeaking()) {
      this.arm();
      return;
    }
    this.fired = true;
    this.options.onExpired();
  }
}
