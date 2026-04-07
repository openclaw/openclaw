/**
 * Deepgram prerecorded transcription — fetch a recording URL, POST the
 * audio bytes to Deepgram, return the best transcript + confidence.
 *
 * Uses the prerecorded API (not streaming) because voicemails are short
 * fixed-length clips. Model defaults to nova-3 per voice tier 2 research.
 */

import type { RuntimeLogger } from "./runtime.js";

const DEEPGRAM_API = "https://api.deepgram.com/v1/listen";

export interface DeepgramClientOptions {
  apiKey: string;
  model?: string;
  logger: RuntimeLogger;
}

export interface TranscribeResult {
  transcript: string;
  confidence: number;
  rawResponse: unknown;
}

export class DeepgramClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly logger: RuntimeLogger;

  constructor(opts: DeepgramClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "nova-3";
    this.logger = opts.logger;
  }

  /**
   * Transcribe an audio file at a public URL. Works because Telnyx
   * recording download_urls.mp3 are publicly accessible (albeit
   * short-lived). If the URL isn't reachable by Deepgram, this throws.
   */
  async transcribeFromUrl(audioUrl: string): Promise<TranscribeResult> {
    const params = new URLSearchParams({
      model: this.model,
      smart_format: "true",
      punctuate: "true",
      // SMBs get callers speaking English, fine for v1. If a customer
      // serves Spanish-dominant areas we add language config later.
      language: "en",
    });

    const resp = await fetch(`${DEEPGRAM_API}?${params.toString()}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Token ${this.apiKey}`,
      },
      body: JSON.stringify({ url: audioUrl }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `deepgram transcribe failed: ${resp.status} ${resp.statusText} ${text}`,
      );
    }

    const json = (await resp.json()) as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{ transcript?: string; confidence?: number }>;
        }>;
      };
    };

    const alt = json.results?.channels?.[0]?.alternatives?.[0];
    if (!alt) {
      this.logger.warn(
        "[missed-call-sms] deepgram returned no transcription alternatives",
      );
      return { transcript: "", confidence: 0, rawResponse: json };
    }
    return {
      transcript: alt.transcript ?? "",
      confidence: alt.confidence ?? 0,
      rawResponse: json,
    };
  }
}
