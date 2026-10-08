export type QaMockOpenAiServerOptions = {
  host?: string;
  port?: number;
  finalOnlyMarkerPauseMs?: number;
  telegramChannelStreamingPause?: () => Promise<void>;
  modelRefs?: readonly string[];
  repeatedRequestResponsePauseMs?: number;
  repeatedRequestStalledResponsePauseMs?: number;
};
