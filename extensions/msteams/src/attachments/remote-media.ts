import { getMSTeamsRuntime } from "../runtime.js";
import { inferPlaceholder } from "./shared.js";
import type { MSTeamsInboundMedia } from "./types.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function downloadAndStoreMSTeamsRemoteMedia(params: {
  url: string;
  filePathHint: string;
  maxBytes: number;
  fetchImpl?: FetchLike;
  contentTypeHint?: string;
  placeholder?: string;
  preserveFilenames?: boolean;
}): Promise<MSTeamsInboundMedia> {
  const fetched = await getMSTeamsRuntime().channel.media.fetchRemoteMedia({
    url: params.url,
    fetchImpl: params.fetchImpl,
    filePathHint: params.filePathHint,
    maxBytes: params.maxBytes,
  });
  const mime = await getMSTeamsRuntime().media.detectMime({
    buffer: fetched.buffer,
    headerMime: fetched.contentType ?? params.contentTypeHint,
    filePath: params.filePathHint,
  });
  const originalFilename = params.preserveFilenames ? params.filePathHint : undefined;
  const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
    fetched.buffer,
    mime ?? params.contentTypeHint,
    "inbound",
    params.maxBytes,
    originalFilename,
  );
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder:
      params.placeholder ??
      inferPlaceholder({ contentType: saved.contentType, fileName: params.filePathHint }),
  };
}
