/**
 * Minimal Telnyx Call Control client for the missed-call-to-SMS flow.
 *
 * We only need a narrow subset of the Call Control API:
 *   - answer an inbound call
 *   - start recording (for voicemail capture)
 *   - speak a greeting before/after recording (optional; Telnyx native TTS)
 *   - fetch a recording download URL
 *   - hang up
 *
 * Uses direct fetch against https://api.telnyx.com/v2 — no telnyx SDK
 * dep, keeping the extension lean and matching the repo pattern of
 * talking to providers via raw HTTP.
 *
 * Webhook signature verification lives in webhook.ts.
 */

import type { RuntimeLogger } from "./runtime.js";

const TELNYX_API = "https://api.telnyx.com/v2";

export interface TelnyxCallsClientOptions {
  apiKey: string;
  logger: RuntimeLogger;
}

export class TelnyxCallsClient {
  private readonly apiKey: string;
  private readonly logger: RuntimeLogger;

  constructor(opts: TelnyxCallsClientOptions) {
    this.apiKey = opts.apiKey;
    this.logger = opts.logger;
  }

  /** Answer an inbound call. Per Telnyx call.initiated webhook flow. */
  async answer(callControlId: string): Promise<void> {
    await this.post(`/calls/${encodeURIComponent(callControlId)}/actions/answer`, {});
  }

  /**
   * Start a recording on a live call. `channels: "single"` keeps the file
   * small; `format: "mp3"` is Deepgram-friendly. Recording stops on
   * playback end, silence, or call hangup.
   */
  async startRecording(
    callControlId: string,
    opts: { maxLengthSecs?: number; playBeep?: boolean } = {},
  ): Promise<void> {
    await this.post(`/calls/${encodeURIComponent(callControlId)}/actions/record_start`, {
      format: "mp3",
      channels: "single",
      play_beep: opts.playBeep ?? true,
      max_length: opts.maxLengthSecs ?? 60,
    });
  }

  async stopRecording(callControlId: string): Promise<void> {
    await this.post(`/calls/${encodeURIComponent(callControlId)}/actions/record_stop`, {});
  }

  /**
   * Speak a greeting using Telnyx native TTS. This is the fastest path —
   * no external TTS provider needed for the voicemail greeting. Quality
   * is "robotic but intelligible" per voice tier 2 research, which is
   * acceptable for a 5-second prompt.
   */
  async speak(
    callControlId: string,
    text: string,
    opts: { voice?: string; language?: string } = {},
  ): Promise<void> {
    await this.post(`/calls/${encodeURIComponent(callControlId)}/actions/speak`, {
      payload: text,
      voice: opts.voice ?? "female",
      language: opts.language ?? "en-US",
    });
  }

  async hangup(callControlId: string): Promise<void> {
    await this.post(`/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {});
  }

  /**
   * Fetch a recording's download URL from its recording_id (delivered in
   * the call.recording.saved webhook). Returns the first public URL
   * (MP3) the recording exposes.
   */
  async getRecordingUrl(recordingId: string): Promise<string | undefined> {
    const resp = await this.get(`/recordings/${encodeURIComponent(recordingId)}`);
    const data = (resp as { data?: { download_urls?: { mp3?: string } } }).data;
    return data?.download_urls?.mp3;
  }

  // --------------- low-level HTTP helpers ---------------

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const resp = await fetch(`${TELNYX_API}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `telnyx POST ${path} failed: ${resp.status} ${resp.statusText} ${text}`,
      );
    }
    if (resp.status === 204) return null;
    return resp.json().catch(() => null);
  }

  private async get(path: string): Promise<unknown> {
    const resp = await fetch(`${TELNYX_API}${path}`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `telnyx GET ${path} failed: ${resp.status} ${resp.statusText} ${text}`,
      );
    }
    return resp.json();
  }
}
