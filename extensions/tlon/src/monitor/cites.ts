import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  asNullableRecord as asRecord,
  readStringField,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { extractMessageText } from "./utils.js";

type TlonScryApi = {
  scry: (path: string) => Promise<unknown>;
};

// Citations arrive inside remote channel/DM content, so `nest` and `postId` are
// attacker-controlled components of an authenticated Urbit scry path. Keep each one a
// single unreserved path segment: no separators, no percent-encoding that could decode
// into one, and no dot segment that URL normalization would resolve away.
const CITE_PATH_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;

// Only used to normalize the composed path; no request is ever made against it.
const CITE_PATH_NORMALIZATION_BASE = "https://tlon.invalid";

function isSafeCitePathSegment(segment: string): boolean {
  if (segment === "." || segment === "..") {
    return false;
  }
  return CITE_PATH_SEGMENT_RE.test(segment);
}

/**
 * Build the channel-post scry path for a citation, or return null when the cited
 * identifiers cannot address exactly that resource. The normalization check is the
 * boundary guarantee: `scryUrbitPath` prefixes `/~/scry` and `urbitFetch` resolves the
 * result through `new URL`, so a path that changes under normalization would leave the
 * channel-post namespace while still carrying the Urbit auth cookie.
 */
function buildCitedPostScryPath(nest: string, postId: string): string | null {
  const nestSegments = nest.split("/");
  if (nestSegments.length !== 3 || !nestSegments.every(isSafeCitePathSegment)) {
    return null;
  }
  if (!isSafeCitePathSegment(postId)) {
    return null;
  }
  const scryPath = `/channels/v4/${nest}/posts/post/${postId}.json`;
  if (new URL(scryPath, CITE_PATH_NORMALIZATION_BASE).pathname !== scryPath) {
    return null;
  }
  return scryPath;
}

export async function resolveTlonCitations(
  content: unknown,
  api: TlonScryApi,
  runtime: RuntimeEnv,
): Promise<string> {
  if (!Array.isArray(content)) {
    return "";
  }
  const resolved: string[] = [];
  for (const verse of content) {
    const block = asRecord(asRecord(verse)?.block);
    const chan = asRecord(asRecord(block?.cite)?.chan);
    const nest = readStringField(chan, "nest");
    const whereMatch = readStringField(chan, "where")?.match(/\/msg\/(~[a-z-]+)\/(.+)/);
    const postId = whereMatch?.[2];
    if (!nest || !postId) {
      continue;
    }
    const scryPath = buildCitedPostScryPath(nest, postId);
    if (!scryPath) {
      runtime.log?.("[tlon] Skipping cited post: citation does not name a channel post");
      continue;
    }
    try {
      runtime.log?.(`[tlon] Fetching cited post: ${scryPath}`);
      const data = asRecord(await api.scry(scryPath));
      const essay = asRecord(data?.essay);
      const text = essay?.content ? extractMessageText(essay.content) : "";
      if (text) {
        resolved.push(`> ${whereMatch?.[1] || "unknown"} wrote: ${text}`);
      }
    } catch (err) {
      runtime.log?.(`[tlon] Failed to fetch cited post: ${String(err)}`);
    }
  }
  return resolved.length > 0 ? `${resolved.join("\n")}\n\n` : "";
}
