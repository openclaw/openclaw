export type QaMockOpenAiServerOptions = {
  host?: string;
  port?: number;
  finalOnlyMarkerPauseMs?: number;
  modelRefs?: readonly string[];
  repeatedRequestResponsePauseMs?: number;
  repeatedRequestStalledResponsePauseMs?: number;
};
