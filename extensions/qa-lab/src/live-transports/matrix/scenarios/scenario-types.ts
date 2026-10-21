import type { MatrixQaObservedEvent } from "../substrate/events.js";

export type MatrixQaReplyArtifact = {
  eventId: string;
  mentions?: MatrixQaObservedEvent["mentions"];
  relatesTo?: MatrixQaObservedEvent["relatesTo"];
  sender?: string;
  tokenMatched?: boolean;
};

export type MatrixQaCanaryArtifact = {
  driverEventId: string;
  reply: MatrixQaReplyArtifact;
  token: string;
};

export type MatrixQaScenarioExecution = {
  details: string;
};
