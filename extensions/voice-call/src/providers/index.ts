export type { VoiceCallProvider } from "./base.js";
export { MockProvider } from "./mock.js";
export { TelnyxProvider } from "./telnyx.js";
export { TwilioProvider } from "./twilio.js";
export { PlivoProvider } from "./plivo.js";

// New feature: Recording Metadata Manager
export {
  RecordingMetadataManager,
  formatRecordingAnalytics,
  type CallRecordingMetadata,
  type RecordingAnalytics,
  type RecordingSearchFilters,
} from "../recording-metadata.js";
