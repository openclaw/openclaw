/**
 * Cut-through TTS — start streaming audio playback before the full
 * reply is generated. Supports barge-in (stop playback when a human
 * starts speaking over the bot).
 *
 * For the initial implementation, this generates the full TTS audio first
 * and then streams it. True cut-through (sentence-level chunked TTS
 * interleaved with LLM streaming) is a future enhancement.
 */

import { formatErrorMessage } from "openclaw/plugin-sdk/infra-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { WorkerBridge } from "./worker-bridge.js";

const logTts = (message: string) => {
  logVerbose(`msteams voice/tts: ${message}`);
};

export class CutThroughTTS {
  private activeCalls = new Set<string>();
  private bridge: WorkerBridge;

  constructor(bridge: WorkerBridge) {
    this.bridge = bridge;
  }

  /**
   * Stream a pre-rendered TTS audio file to the worker for playback.
   * Marks the call as having active playback for barge-in detection.
   */
  async playAudioFile(callId: string, audioPath: string): Promise<void> {
    this.activeCalls.add(callId);
    try {
      const fs = await import("node:fs/promises");
      const audioData = await fs.readFile(audioPath);
      await this.bridge.playAudio(callId, [new Uint8Array(audioData)]);
      logTts(`playback sent for call ${callId} (${audioData.length} bytes)`);
    } finally {
      this.activeCalls.delete(callId);
    }
  }

  /**
   * Barge-in: immediately stop playback for the given call.
   * Called when a human starts speaking over the bot.
   */
  async bargeIn(callId: string): Promise<void> {
    if (!this.activeCalls.has(callId)) return;

    try {
      await this.bridge.stopPlayback(callId);
      logTts(`barge-in: stopped playback for call ${callId}`);
    } catch (err) {
      logTts(`barge-in error: ${formatErrorMessage(err)}`);
    } finally {
      this.activeCalls.delete(callId);
    }
  }

  /** Check if a call currently has active TTS playback. */
  isPlaying(callId: string): boolean {
    return this.activeCalls.has(callId);
  }

  /** Clean up (remove all active call tracking). */
  clear(): void {
    this.activeCalls.clear();
  }
}
