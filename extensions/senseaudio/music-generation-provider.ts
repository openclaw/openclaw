import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import type {
  GeneratedMusicAsset,
  MusicGenerationProvider,
  MusicGenerationRequest,
} from "openclaw/plugin-sdk/music-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const DEFAULT_SENSEAUDIO_BASE_URL = "https://api.senseaudio.cn";
const DEFAULT_SENSEAUDIO_MUSIC_MODEL = "senseaudio-music-1.0-260319";
// SenseAudio generation typically takes 1–5 min; cap at 30 min like the hermes agent.
const DEFAULT_TIMEOUT_MS = 1_800_000;
const POLL_INTERVAL_MS = 5_000;
const API_CALL_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

type SenseaudioLyricsCreateResponse = {
  data?: Array<{
    text?: string;
    title?: string;
  }>;
};

type SenseaudioSongCreateResponse = {
  task_id?: string;
};

type SenseaudioSongPendingItem = {
  audio_url?: string;
  cover_url?: string;
  duration?: number;
  title?: string;
  lyrics?: string;
};

type SenseaudioSongPendingResponse = {
  status?: string;
  response?: {
    data?: SenseaudioSongPendingItem[];
  };
};

function resolveSenseaudioBaseUrl(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
): string {
  const direct = normalizeOptionalString(cfg?.models?.providers?.senseaudio?.baseUrl);
  if (!direct) {
    return DEFAULT_SENSEAUDIO_BASE_URL;
  }
  try {
    return new URL(direct).origin;
  } catch {
    return DEFAULT_SENSEAUDIO_BASE_URL;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadTrack(params: {
  url: string;
  index: number;
  title?: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<GeneratedMusicAsset> {
  const response = await fetchWithTimeout(
    params.url,
    { method: "GET" },
    Math.min(DOWNLOAD_TIMEOUT_MS, params.timeoutMs),
    params.fetchFn,
  );
  await assertOkOrThrowHttpError(response, "SenseAudio audio download failed");
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "audio/mpeg";
  const ext = extensionForMime(mimeType)?.replace(/^\./u, "") || "mp3";
  const baseName = params.title
    ? params.title.replace(/[^\w.-]/gu, "-").slice(0, 60)
    : `track-${params.index + 1}`;
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType,
    fileName: `${baseName}.${ext}`,
  };
}

export function buildSenseaudioMusicGenerationProvider(): MusicGenerationProvider {
  return {
    id: "senseaudio",
    label: "SenseAudio",
    defaultModel: DEFAULT_SENSEAUDIO_MUSIC_MODEL,
    models: [DEFAULT_SENSEAUDIO_MUSIC_MODEL],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "senseaudio",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxTracks: 1,
        supportsLyrics: true,
        supportsInstrumental: true,
        // SenseAudio does not expose duration or format controls.
        supportsDuration: false,
        supportsFormat: false,
        supportedFormats: ["mp3"],
      },
      edit: {
        enabled: false,
      },
    },
    async generateMusic(req: MusicGenerationRequest) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error("SenseAudio music generation does not support image reference inputs.");
      }

      const auth = await resolveApiKeyForProvider({
        provider: "senseaudio",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("SenseAudio API key missing");
      }

      const fetchFn = fetch;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveSenseaudioBaseUrl(req.cfg),
          defaultBaseUrl: DEFAULT_SENSEAUDIO_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
        });
      const jsonHeaders = new Headers(headers);
      jsonHeaders.set("Content-Type", "application/json");

      const model = normalizeOptionalString(req.model) || DEFAULT_SENSEAUDIO_MUSIC_MODEL;
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;

      // Step 1: Generate structured lyrics from prompt when no lyrics are provided.
      // This applies to both vocal and instrumental tracks: for instrumental,
      // the lyrics structure guides musical composition (timing, energy) while
      // instrumental=true suppresses vocals. Passing a raw prompt with
      // custom_mode=true causes a 400 "无效的歌词格式" from the SenseAudio API.
      let resolvedLyrics = normalizeOptionalString(req.lyrics);
      let resolvedTitle: string | undefined;

      if (!resolvedLyrics) {
        const { response: lyricsRes, release: lyricsRelease } = await postJsonRequest({
          url: `${baseUrl}/v1/music/lyrics/create`,
          headers: jsonHeaders,
          body: { prompt: req.prompt, provider: model },
          timeoutMs: Math.min(API_CALL_TIMEOUT_MS, deadline - Date.now()),
          fetchFn,
          pinDns: false,
          allowPrivateNetwork,
          dispatcherPolicy,
        });
        try {
          await assertOkOrThrowHttpError(lyricsRes, "SenseAudio lyrics generation failed");
          const lyricsPayload = (await lyricsRes.json()) as SenseaudioLyricsCreateResponse;
          const first = lyricsPayload.data?.[0];
          const text = normalizeOptionalString(first?.text);
          if (!text) {
            throw new Error(
              `SenseAudio lyrics generation returned no text: ${JSON.stringify(lyricsPayload)}`,
            );
          }
          resolvedLyrics = text;
          resolvedTitle = normalizeOptionalString(first?.title) || undefined;
        } finally {
          await lyricsRelease();
        }
      }

      // Step 2: Submit the song creation task.
      // custom_mode=false: the API expects structured lyrics with section tags.
      // Unstructured prompts with custom_mode=true cause a 400 "无效的歌词格式";
      // resolvedLyrics is always set at this point (generated above if not user-supplied).
      const songBody: Record<string, unknown> = {
        model,
        lyrics: resolvedLyrics,
        custom_mode: false,
        instrumental: req.instrumental === true,
      };
      if (resolvedTitle) {
        songBody["title"] = resolvedTitle;
      }

      const { response: songRes, release: songRelease } = await postJsonRequest({
        url: `${baseUrl}/v1/music/song/create`,
        headers: jsonHeaders,
        body: songBody,
        timeoutMs: Math.min(API_CALL_TIMEOUT_MS, deadline - Date.now()),
        fetchFn,
        pinDns: false,
        allowPrivateNetwork,
        dispatcherPolicy,
      });
      let taskId: string;
      try {
        await assertOkOrThrowHttpError(songRes, "SenseAudio song creation failed");
        const songPayload = (await songRes.json()) as SenseaudioSongCreateResponse;
        const id = normalizeOptionalString(songPayload.task_id);
        if (!id) {
          throw new Error(
            `SenseAudio song creation returned no task_id: ${JSON.stringify(songPayload)}`,
          );
        }
        taskId = id;
      } finally {
        await songRelease();
      }

      // Step 3: Poll until the task reaches SUCCESS or FAILED.
      let pendingData: SenseaudioSongPendingResponse | null = null;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const pollRes = await fetchWithTimeout(
          `${baseUrl}/v1/music/song/pending/${taskId}`,
          { method: "GET", headers },
          Math.min(API_CALL_TIMEOUT_MS, remaining),
          fetchFn,
        );
        await assertOkOrThrowHttpError(pollRes, "SenseAudio task status check failed");
        const data = (await pollRes.json()) as SenseaudioSongPendingResponse;
        const status = normalizeOptionalString(data.status);
        if (status === "SUCCESS") {
          pendingData = data;
          break;
        }
        if (status === "FAILED") {
          throw new Error(`SenseAudio task ${taskId} failed`);
        }
        if (Date.now() + POLL_INTERVAL_MS >= deadline) {
          break;
        }
        await sleep(POLL_INTERVAL_MS);
      }

      if (!pendingData) {
        throw new Error(`SenseAudio task ${taskId} did not complete within ${timeoutMs}ms`);
      }

      // Step 4: Download the generated audio tracks.
      const items = pendingData.response?.data ?? [];
      if (items.length === 0) {
        throw new Error("SenseAudio music generation response missing audio data");
      }

      const tracks: GeneratedMusicAsset[] = [];
      const lyricsOut: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const audioUrl = normalizeOptionalString(item?.audio_url);
        if (!audioUrl) {
          continue;
        }
        tracks.push(
          await downloadTrack({
            url: audioUrl,
            index: i,
            title: normalizeOptionalString(item?.title) || undefined,
            timeoutMs: Math.max(0, deadline - Date.now()),
            fetchFn,
          }),
        );
        const lyrics = normalizeOptionalString(item?.lyrics);
        if (lyrics) {
          lyricsOut.push(lyrics);
        }
      }

      if (tracks.length === 0) {
        throw new Error("SenseAudio music generation produced no downloadable tracks");
      }

      return {
        tracks,
        ...(lyricsOut.length > 0 ? { lyrics: lyricsOut } : {}),
        model,
        metadata: {
          taskId,
          instrumental: req.instrumental === true,
          ...(resolvedLyrics ? { requestedLyrics: true } : {}),
        },
      };
    },
  };
}
