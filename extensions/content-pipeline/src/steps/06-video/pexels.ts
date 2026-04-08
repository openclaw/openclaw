/**
 * Pexels Video API client (free, 20k req/month, 1080p+ downloads).
 *
 * Pure helpers + a thin fetch wrapper. Zero external deps beyond Node's
 * built-in `fetch`. Used by `./broll.ts` to grab real B-roll footage matching
 * the concept keywords from Step 2.
 *
 * Free API key from https://www.pexels.com/api/ (no card). Set as
 * `PEXELS_API_KEY` in `.env`.
 *
 * Docs: https://www.pexels.com/api/documentation/
 */

const PEXELS_BASE = "https://api.pexels.com/videos";

export interface PexelsVideoFile {
  id: number;
  quality: "hd" | "sd" | string;
  file_type: string; // "video/mp4"
  width: number;
  height: number;
  link: string; // direct download URL
}

export interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number; // seconds
  url: string; // pexels.com page URL
  user: { name: string; url: string };
  video_files: PexelsVideoFile[];
}

export interface PexelsSearchResponse {
  page: number;
  per_page: number;
  videos: PexelsVideo[];
  total_results: number;
  next_page?: string;
}

export interface PexelsSearchOpts {
  /** Pexels API key (defaults to env PEXELS_API_KEY) */
  apiKey?: string;
  /** Max results per call (1-80, default 15) */
  perPage?: number;
  /** Filter by clip orientation */
  orientation?: "landscape" | "portrait" | "square";
  /** Min size hint */
  size?: "small" | "medium" | "large";
}

/** Build a search URL for the Pexels videos endpoint. Pure, used in tests. */
export function buildSearchUrl(query: string, opts: PexelsSearchOpts = {}): string {
  const params = new URLSearchParams({
    query: query.trim(),
    per_page: String(opts.perPage ?? 15),
  });
  if (opts.orientation) params.set("orientation", opts.orientation);
  if (opts.size) params.set("size", opts.size);
  return `${PEXELS_BASE}/search?${params.toString()}`;
}

/**
 * Pick the best video file from a Pexels result.
 *
 * Strategy: prefer 1920×1080 landscape, then any HD, then largest by area.
 * Falls back to the first file if nothing better is found. Returns `undefined`
 * for empty input so callers can guard.
 */
export function pickBestFile(
  files: PexelsVideoFile[],
  targetWidth = 1920,
  targetHeight = 1080,
): PexelsVideoFile | undefined {
  if (!files.length) return undefined;

  // Prefer exact match
  const exact = files.find(
    (f) => f.width === targetWidth && f.height === targetHeight && f.file_type === "video/mp4",
  );
  if (exact) return exact;

  // Prefer HD MP4 with closest area to target
  const targetArea = targetWidth * targetHeight;
  const hdMp4 = files
    .filter((f) => f.quality === "hd" && f.file_type === "video/mp4")
    .sort(
      (a, b) =>
        Math.abs(a.width * a.height - targetArea) - Math.abs(b.width * b.height - targetArea),
    );
  if (hdMp4[0]) return hdMp4[0];

  // Fallback: first MP4
  const anyMp4 = files.find((f) => f.file_type === "video/mp4");
  return anyMp4 ?? files[0];
}

/**
 * Search Pexels for videos matching `query`. Throws if the API key is missing
 * or the request fails — callers (engine) can catch and fall back.
 */
export async function searchPexels(
  query: string,
  opts: PexelsSearchOpts = {},
): Promise<PexelsVideo[]> {
  const apiKey = opts.apiKey ?? process.env.PEXELS_API_KEY;
  if (!apiKey) {
    throw new Error("PEXELS_API_KEY not set. Get a free key at https://www.pexels.com/api/");
  }

  const url = buildSearchUrl(query, opts);
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { Authorization: apiKey },
  });

  if (!resp.ok) {
    throw new Error(`Pexels search failed (${resp.status}): ${await resp.text()}`);
  }

  const data = (await resp.json()) as PexelsSearchResponse;
  return data.videos ?? [];
}

/**
 * Download a Pexels video file to disk via fetch + write stream.
 * Throws on failure (caller decides whether to fall back).
 */
export async function downloadVideo(url: string, outputPath: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    throw new Error(`Pexels download failed (${resp.status}): ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(outputPath, buf);
}
