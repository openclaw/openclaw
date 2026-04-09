/**
 * Own-voice suppression filter.
 *
 * Prevents the bot from re-transcribing its own TTS output by filtering
 * audio segments whose speaker ID matches the bot's own speaker ID in
 * the unmixed audio stream.
 *
 * The bot's speaker ID is resolved when the .NET worker emits a
 * participant-joined event for the bot's own AAD identity.
 */

export class OwnVoiceFilter {
  private botSpeakerIds = new Set<number>();

  /**
   * Register a speaker ID as belonging to the bot.
   * Called when we identify the bot's own participant entry in the call.
   */
  registerBotSpeakerId(speakerId: number): void {
    this.botSpeakerIds.add(speakerId);
  }

  /**
   * Check whether the given speaker ID should be suppressed
   * (i.e. it is the bot's own voice).
   */
  shouldSuppress(speakerId: number): boolean {
    return this.botSpeakerIds.has(speakerId);
  }

  /** Clear all registered bot speaker IDs (cleanup on session end). */
  clear(): void {
    this.botSpeakerIds.clear();
  }
}
