const DEFAULT_FISH_AUDIO_BASE_URL = "https://api.fish.audio";

function normalizeFishAudioBaseUrl(baseUrl?: string): string {
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
        const truncated =
          errorBody.length > 500 ? `${errorBody.slice(0, 500)}…` : errorBody;
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

  // Two parallel calls: official voices + user's own voices
  const [officialRes, selfRes] = await Promise.allSettled([
    fetch(`${base}/model?type=tts&author_id=d8b0991f96b44e489422ca2ddf0bd31d&page_size=100`, {
      headers: { Authorization: `Bearer ${params.apiKey}` },
    }),
    fetch(`${base}/model?type=tts&self=true&page_size=100`, {
      headers: { Authorization: `Bearer ${params.apiKey}` },
    }),
  ]);

  const voices = new Map<string, string>();

  // Process official voices first
  if (officialRes.status === "fulfilled" && officialRes.value.ok) {
    const json = (await officialRes.value.json()) as {
      items?: Array<{ _id?: string; title?: string }>;
    };
    if (Array.isArray(json.items)) {
      for (const v of json.items) {
        const id = v._id?.trim();
        const name = v.title?.trim();
        if (id) {
          voices.set(id, name || id);
        }
      }
    }
  }

  // User's own voices take precedence on conflict
  if (selfRes.status === "fulfilled" && selfRes.value.ok) {
    const json = (await selfRes.value.json()) as {
      items?: Array<{ _id?: string; title?: string }>;
    };
    if (Array.isArray(json.items)) {
      for (const v of json.items) {
        const id = v._id?.trim();
        const name = v.title?.trim();
        if (id) {
          voices.set(id, name ? `${name} (mine)` : id);
        }
      }
    }
  }

  // If both calls failed, throw
  if (voices.size === 0) {
    const errors: string[] = [];
    if (officialRes.status === "rejected") {
      errors.push(`official: ${officialRes.reason}`);
    } else if (!officialRes.value.ok) {
      errors.push(`official: HTTP ${officialRes.value.status}`);
    }
    if (selfRes.status === "rejected") {
      errors.push(`self: ${selfRes.reason}`);
    } else if (!selfRes.value.ok) {
      errors.push(`self: HTTP ${selfRes.value.status}`);
    }
    if (errors.length > 0) {
      throw new Error(`Fish Audio voices API error: ${errors.join("; ")}`);
    }
  }

  return Array.from(voices.entries()).map(([id, name]) => ({ id, name }));
}
