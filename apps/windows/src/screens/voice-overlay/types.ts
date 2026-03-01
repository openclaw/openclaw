export interface VoiceWakeActivePayload {
  token?: string;
  transcript?: string;
  rawTranscript?: string;
  triggerChime?: string;
}

export interface VoiceWakeTriggeredPayload {
  token?: string;
  sendChime?: string;
}

export interface VoiceAudioLevelPayload {
  level?: number;
}

export interface VoicePttStatePayload {
  token?: string;
  active?: boolean;
  error?: string;
  keepVisible?: boolean;
}

export interface VoiceOverlayDismissPayload {
  token?: string;
}
