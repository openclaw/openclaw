// Discord test API exposes transcript-provider fixtures without deep extension imports.
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

// Native host E2E keeps core admission real and uses the plugin-owned typing fixtures.
export const loadDiscordReplyTypingFeedbackTestHarness = () =>
  import("./src/monitor/reply-typing-feedback.js");
export const loadDiscordLivePolicyTestHarness = () => import("./src/monitor/live-policy.js");
export const loadDiscordRuntimeTestHarness = () => import("./src/runtime.js");
