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

  // List the authenticated user's own voices (cloned/trained).
  // Fish Audio has no stable API for fetching a curated "official" voice
  // catalogue — the public model listing returns the entire community corpus
  // (1M+ entries) and filtering by undocumented author IDs would be fragile.
  // Users can browse and select voices at https://fish.audio and configure
  // their chosen voiceId directly.
  const PAGE_SIZE = 100;
  const allItems: Array<{ _id?: string; title?: string }> = [];
  let page = 1;

  // Paginate through all results — the Fish Audio API returns `total` and
  // supports `page_number` (1-indexed) + `page_size`.
  while (true) {
    const res = await fetch(
      `${base}/model?type=tts&self=true&page_size=${PAGE_SIZE}&page_number=${page}`,
      { headers: { Authorization: `Bearer ${params.apiKey}` } },
    );

    if (!res.ok) {
      throw new Error(`Fish Audio voices API error (${res.status})`);
    }

    const json = (await res.json()) as {
      total?: number;
      items?: Array<{ _id?: string; title?: string }>;
    };

    if (!Array.isArray(json.items) || json.items.length === 0) {
      break;
    }

    allItems.push(...json.items);

    // Stop when we've collected all items or the page was not full.
    if (
      (typeof json.total === "number" && allItems.length >= json.total) ||
      json.items.length < PAGE_SIZE
    ) {
      break;
    }

    page++;
  }

  return allItems
    .map((v) => ({
      id: v._id?.trim() ?? "",
      name: v.title?.trim() || v._id?.trim() || "",
    }))
    .filter((v) => v.id.length > 0);
}
