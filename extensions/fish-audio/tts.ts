export const DEFAULT_FISH_AUDIO_BASE_URL = "https://api.fish.audio";

export function normalizeFishAudioBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return DEFAULT_FISH_AUDIO_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

export async function fishAudioTTS(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  referenceId: string;
  model: string;
  format: "mp3" | "opus" | "wav" | "pcm";
  latency?: "normal" | "balanced" | "low";
  speed?: number;
  temperature?: number;
  topP?: number;
  timeoutMs: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    referenceId,
    model,
    format,
    latency,
    speed,
    temperature,
    topP,
    timeoutMs,
  } = params;

  if (!text.trim()) {
    throw new Error("Fish Audio TTS: empty text");
  }
  if (!referenceId.trim()) {
    throw new Error("Fish Audio TTS: missing reference_id (voice)");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${normalizeFishAudioBaseUrl(baseUrl)}/v1/tts`;

    const body: Record<string, unknown> = {
      text,
      reference_id: referenceId,
      format,
    };

    if (latency && latency !== "normal") {
      body.latency = latency;
    }

    // Prosody settings
    if (speed != null) {
      body.prosody = { speed };
    }

    if (temperature != null) {
      body.temperature = temperature;
    }
    if (topP != null) {
      body.top_p = topP;
    }

    // Fish Audio uses the `model` HTTP header (not a body field) to select
    // the TTS model. This is intentional per their API spec — don't move it
    // into the JSON body.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        model,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      let errorDetail = "";
      try {
        const errorBody = await response.text();
        // Cap at 500 chars to avoid log pollution from large error responses
        const truncated = errorBody.length > 500 ? `${errorBody.slice(0, 500)}…` : errorBody;
        errorDetail = truncated ? `: ${truncated}` : "";
      } catch {
        // Ignore error body read failure
      }
      throw new Error(`Fish Audio API error (${response.status})${errorDetail}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error("Fish Audio TTS produced empty audio");
    }

    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

export async function listFishAudioVoices(params: {
  apiKey: string;
  baseUrl?: string;
}): Promise<Array<{ id: string; name: string }>> {
  const base = normalizeFishAudioBaseUrl(params.baseUrl);

  const PAGE_SIZE = 100;
  const headers = { Authorization: `Bearer ${params.apiKey}` };

  type RawItem = { _id?: string; title?: string };
  type ApiResponse = { total?: number; items?: RawItem[] };

  // --- 1. User's own voices (cloned/trained), paginated ---
  const ownItems: RawItem[] = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `${base}/model?type=tts&self=true&page_size=${PAGE_SIZE}&page_number=${page}`,
      { headers },
    );

    if (!res.ok) {
      throw new Error(`Fish Audio voices API error (${res.status})`);
    }

    const json = (await res.json()) as ApiResponse;

    if (!Array.isArray(json.items) || json.items.length === 0) {
      break;
    }

    ownItems.push(...json.items);

    if (
      (typeof json.total === "number" && ownItems.length >= json.total) ||
      json.items.length < PAGE_SIZE
    ) {
      break;
    }

    page++;
  }

  // --- 2. Popular public voices (single page, sorted by score) ---
  // Provides usable defaults for new users who have no cloned voices yet.
  // We fetch one page of the top-ranked community voices rather than the
  // entire corpus.
  let popularItems: RawItem[] = [];
  try {
    const res = await fetch(
      `${base}/model?type=tts&sort_by=score&page_size=${PAGE_SIZE}&page_number=1`,
      { headers },
    );

    if (res.ok) {
      const json = (await res.json()) as ApiResponse;
      popularItems = Array.isArray(json.items) ? json.items : [];
    }
  } catch {
    // Non-fatal — user's own voices are still returned.
  }

  // --- 3. Merge & deduplicate (own voices first) ---
  const seen = new Set<string>();
  const merged: Array<{ id: string; name: string }> = [];

  for (const v of [...ownItems, ...popularItems]) {
    const id = v._id?.trim() ?? "";
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    merged.push({ id, name: v.title?.trim() || id });
  }

  return merged;
}
