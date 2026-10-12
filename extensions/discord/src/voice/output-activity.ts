export function resolveDiscordOutputAudioDelta(
  previous: { sourceAudioBytes: number; sinkAudioBytes: number },
  sourceAudioBytes: number,
) {
  const sinkAudioBytes =
    Math.floor((previous.sourceAudioBytes + sourceAudioBytes) / 2) * 8 - previous.sinkAudioBytes;
  return { audioMs: sinkAudioBytes / 192, sourceAudioBytes, sinkAudioBytes };
}
