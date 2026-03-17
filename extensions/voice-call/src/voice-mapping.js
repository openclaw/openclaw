function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
const OPENAI_TO_POLLY_MAP = {
  alloy: "Polly.Joanna",
  // neutral, warm
  echo: "Polly.Matthew",
  // male, warm
  fable: "Polly.Amy",
  // British, expressive
  onyx: "Polly.Brian",
  // deep male
  nova: "Polly.Salli",
  // female, friendly
  shimmer: "Polly.Kimberly"
  // female, clear
};
const DEFAULT_POLLY_VOICE = "Polly.Joanna";
function mapVoiceToPolly(voice) {
  if (!voice) {
    return DEFAULT_POLLY_VOICE;
  }
  if (voice.startsWith("Polly.") || voice.startsWith("Google.")) {
    return voice;
  }
  return OPENAI_TO_POLLY_MAP[voice.toLowerCase()] || DEFAULT_POLLY_VOICE;
}
function isOpenAiVoice(voice) {
  return voice.toLowerCase() in OPENAI_TO_POLLY_MAP;
}
function getOpenAiVoiceNames() {
  return Object.keys(OPENAI_TO_POLLY_MAP);
}
export {
  DEFAULT_POLLY_VOICE,
  escapeXml,
  getOpenAiVoiceNames,
  isOpenAiVoice,
  mapVoiceToPolly
};
