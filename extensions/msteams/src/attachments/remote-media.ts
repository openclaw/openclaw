import { saveResponseMedia } from "openclaw/plugin-sdk/media-runtime";
import { resolveMSTeamsMediaKind } from "./shared.js";
import type { MSTeamsInboundMedia } from "./types.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Direct save path used when the caller supplies the already-guarded fetch
 * implementation. This lets Teams-specific auth fallback own the request
 * sequence while keeping redirect and DNS pinning inside `safeFetchWithPolicy`.
 */
export async function downloadAndStoreMSTeamsRemoteMedia(params: {
  url: string;
  filePathHint: string;
  fetchImpl: FetchLike;
  maxBytes: number;
  contentTypeHint?: string;
  kind?: MSTeamsInboundMedia["kind"];
  preserveFilenames?: boolean;
}): Promise<MSTeamsInboundMedia> {
  const response = await params.fetchImpl(params.url, { redirect: "follow" });
  try {
    const saved = await saveResponseMedia(response, {
      sourceUrl: params.url,
      filePathHint: params.filePathHint,
      maxBytes: params.maxBytes,
      fallbackContentType: params.contentTypeHint,
      originalFilename: params.preserveFilenames ? params.filePathHint : undefined,
    });
    return {
      path: saved.path,
      contentType: saved.contentType,
      kind:
        params.kind ??
        resolveMSTeamsMediaKind({
          contentType: saved.contentType,
          fileName: params.filePathHint,
        }),
    };
  } finally {
    // Guarded responses release their pinned dispatcher on EOF or cancel. A
    // storage failure can happen before the body is read, so always cancel it.
    await response.body?.cancel().catch(() => undefined);
  }
}
