import { getMSTeamsRuntime } from "../runtime.js";
import { inferPlaceholder } from "./shared.js";
async function downloadAndStoreMSTeamsRemoteMedia(params) {
  const fetched = await getMSTeamsRuntime().channel.media.fetchRemoteMedia({
    url: params.url,
    fetchImpl: params.fetchImpl,
    filePathHint: params.filePathHint,
    maxBytes: params.maxBytes,
    ssrfPolicy: params.ssrfPolicy
  });
  const mime = await getMSTeamsRuntime().media.detectMime({
    buffer: fetched.buffer,
    headerMime: fetched.contentType ?? params.contentTypeHint,
    filePath: params.filePathHint
  });
  const originalFilename = params.preserveFilenames ? params.filePathHint : void 0;
  const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
    fetched.buffer,
    mime ?? params.contentTypeHint,
    "inbound",
    params.maxBytes,
    originalFilename
  );
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder: params.placeholder ?? inferPlaceholder({ contentType: saved.contentType, fileName: params.filePathHint })
  };
}
export {
  downloadAndStoreMSTeamsRemoteMedia
};
