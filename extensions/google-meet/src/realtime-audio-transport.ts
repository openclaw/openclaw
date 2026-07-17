import type { GoogleMeetChromeHealth } from "./transports/types.js";

export interface MeetRealtimeAudioTransport {
  /** Delivers a prior failure immediately so provider setup cannot outrun transport teardown. */
  onFatal(handler: () => void): void;
  startInput(onAudio: (audio: Buffer) => void): void;
  stop(): Promise<void>;
  writeOutput(audio: Buffer): Promise<void>;
  clearOutput(): Promise<void>;
  dispose(): Promise<void>;
  getHealth?(): Pick<GoogleMeetChromeHealth, "consecutiveInputErrors" | "lastInputError">;
  startBargeInMonitor?(onBargeIn: (audio: Buffer) => boolean): void;
}
