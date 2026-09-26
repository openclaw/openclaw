const voiceLiteral = "Use `[[audio_as_voice]]` literally.";
const replyLiteral = "Use `[[reply_to:example-id]]` literally.";
const voiceChunks = ["Use `[[audio_as_voice]]", "` literally.\n\n"] as const;
const replyChunks = ["Use `[[reply_to:example-id]]", "` literally.\n\n"] as const;

export const inlineDirectiveCases = [
  {
    name: "voice marker split from its inline opener",
    chunks: ["Use `", "[[audio_as_voice]]` literally.\n\n"],
    marker: "[[audio_as_voice]]",
    literal: true,
    audioAsVoice: false,
  },
  {
    name: "voice marker in physically split inline code",
    chunks: ["Use `" + "x".repeat(60), "[[audio_as_voice]]` literally.\n\n"],
    marker: "[[audio_as_voice]]",
    literal: true,
    audioAsVoice: false,
  },
  {
    name: "a complete voice marker before its inline closer",
    chunks: voiceChunks,
    marker: "[[audio_as_voice]]",
    literal: true,
    literalText: voiceLiteral,
    audioAsVoice: false,
  },
  {
    name: "a complete reply marker before its inline closer",
    chunks: replyChunks,
    marker: "[[reply_to:example-id]]",
    literal: true,
    literalText: replyLiteral,
    textOnly: true,
  },
  {
    name: "unconsumed genuine voice intent before a provisional literal",
    chunks: ["[[audio_as_voice]]" + voiceChunks[0], voiceChunks[1]],
    marker: "[[audio_as_voice]]",
    literal: true,
    literalText: voiceLiteral,
    audioAsVoice: true,
    voiceEdges: 1,
  },
  {
    name: "consumed genuine voice intent before a provisional literal",
    chunks: ["[[audio_as_voice]]First voice reply.\n\n", ...voiceChunks],
    marker: "[[audio_as_voice]]",
    literal: true,
    literalText: voiceLiteral,
    audioAsVoice: true,
    voiceEdges: 1,
  },
  {
    name: "genuine voice intent after a retracted provisional literal",
    chunks: [...voiceChunks, "[[audio_as_voice]]Actual voice reply.\n\n"],
    marker: "[[audio_as_voice]]",
    literal: true,
    literalText: voiceLiteral,
    audioAsVoice: true,
    voiceEdges: 1,
  },
  {
    name: "unconsumed genuine reply intent before a provisional literal",
    chunks: ["[[reply_to:real-id]]" + replyChunks[0], replyChunks[1]],
    marker: "[[reply_to:example-id]]",
    literal: true,
    literalText: replyLiteral,
    replyToId: "real-id",
    textOnly: true,
  },
] as const;
