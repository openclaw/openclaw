// Discord test API exposes integration fixtures without deep extension imports.
export { discordPlugin } from "./src/channel.js";
export { sendMessageDiscord } from "./src/send.outbound.js";
export { createDiscordLoopbackRest } from "./src/send.test-harness.js";
export const loadDiscordDraftPreview = () =>
  import("./src/monitor/message-handler.draft-preview.js");
export { RequestClient } from "./src/internal/discord.js";
export {
  discordVoiceTranscriptsSourceProvider,
  setDiscordTranscriptsVoiceManager,
} from "./src/voice/transcripts-source.js";

// Voice harness mocks must remain opt-in for provider-only integration tests.
export const loadDiscordVoiceTestHarness = () =>
  import("./src/voice/voice-test-harness.test-support.js");

// Gateway capture proof keeps routing/admission real; only transport edges are substituted.
export const loadDiscordGatewayCaptureFixture = () =>
  import("./src/voice/voice-gateway-capture.test-support.js");
