import { createChannelPreflightAudio } from "openclaw/plugin-sdk/media-understanding-runtime";

export function isMatrixAudioContent(params: { msgtype?: string; mimetype?: string }): boolean {
  if (params.msgtype === "m.audio") {
    return true;
  }
  if (params.msgtype === "m.file" && typeof params.mimetype === "string") {
    return params.mimetype.toLowerCase().startsWith("audio/");
  }
  return false;
}

export const matrixPreflightAudio = createChannelPreflightAudio({
  channel: "matrix",
  isAudio: isMatrixAudioContent,
});
