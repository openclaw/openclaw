import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import type { GoogleMeetConfig, GoogleMeetMode, GoogleMeetTransport } from "./config.js";
import { normalizeMeetUrl } from "./meet-url.js";
import type {
  GoogleMeetChromeHealth,
  GoogleMeetJoinRequest,
  GoogleMeetSession,
} from "./transports/types.js";

const probes = MeetingPlatformAdapter.createRuntimeProbes<
  GoogleMeetConfig,
  GoogleMeetMode,
  GoogleMeetTransport,
  GoogleMeetChromeHealth,
  GoogleMeetSession,
  GoogleMeetJoinRequest
>({
  defaultSpeechMessage: "Say exactly: Google Meet speech test complete.",
  invalidRequest: (message) => new Error(message),
  resolveTimeoutMs: MeetingPlatformAdapter.resolveProbeTimeoutMs,
  shouldWaitForListening: (session) =>
    Boolean(
      (session.transport === "chrome" || session.transport === "chrome-node") &&
      session.chrome?.launched,
    ),
  talkBackMode: MeetingPlatformAdapter.isTalkBackMode,
  normalizeUrl: normalizeMeetUrl,
  resolveRequestMode: (mode) => (mode === "realtime" ? "agent" : mode),
  defaultTransport: (config) => config.defaultTransport,
  validateListeningTransport: (transport) => {
    if (transport === "twilio") {
      throw new Error("test_listen supports chrome or chrome-node transports");
    }
  },
  resolveSpeechTimeoutMs: (_request, config) => Math.min(config.chrome.joinTimeoutMs, 5_000),
  refreshCaptionHealth: async (context, session) => await context.refreshCaptionHealth(session),
  speechModeError:
    "test_speech requires mode: agent or bidi; use join mode: transcribe for observe-only sessions.",
  listeningModeError:
    "test_listen requires mode: transcribe; use test_speech for talk-back sessions.",
});

export type GoogleMeetRuntimeProbeContext = Parameters<typeof probes.testListening>[0];

export const testGoogleMeetListening = probes.testListening;
export const testGoogleMeetSpeech = probes.testSpeech;
