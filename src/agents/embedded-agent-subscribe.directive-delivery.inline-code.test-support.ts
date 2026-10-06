const voiceLiteral = "Use `[[audio_as_voice]]` literally.";
const voiceChunks = ["Use `[[audio_as_voice]]", "` literally.\n\n"] as const;

export const inlineDirectiveCases = [
  {
    name: "unconsumed genuine voice intent before a provisional literal",
    chunks: ["[[audio_as_voice]]" + voiceChunks[0], voiceChunks[1]],
    marker: "[[audio_as_voice]]",
    literal: true,
    literalText: voiceLiteral,
    audioAsVoice: true,
    voiceEdges: 1,
  },
] as const;
