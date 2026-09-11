import type {
  LogbookBatch,
  LogbookBatchStatus,
  LogbookCard,
  LogbookCardDraft,
  LogbookDayStats,
  LogbookFrame,
  LogbookObservation,
} from "./types.js";

export type LogbookFrameInput = Omit<LogbookFrame, "id"> & { contentHash: string };
export type LogbookBatchInput = {
  day: string;
  startMs: number;
  endMs: number;
  frameIds: number[];
};
export type LogbookObservationInput = Pick<LogbookObservation, "startMs" | "endMs" | "text">;
export type LogbookTimeline = { day: string; cards: LogbookCard[]; stats: LogbookDayStats };
export type LogbookStandup = { day: string; text: string; updatedMs: number };
export type LogbookDay = { day: string; cards: number; firstMs: number; lastMs: number };

type Operation<Input, Output> = { input: Input; output: Output };

export type LogbookOperations = {
  insertFrame: Operation<LogbookFrameInput, number>;
  lastFrame: Operation<undefined, { capturedAtMs: number; contentHash: string } | null>;
  unbatchedActiveFrames: Operation<{ limit: number }, LogbookFrame[]>;
  countUnbatchedActiveFrames: Operation<undefined, number>;
  frameById: Operation<{ id: number }, LogbookFrame | null>;
  framesInRange: Operation<{ startMs: number; endMs: number }, LogbookFrame[]>;
  createBatch: Operation<LogbookBatchInput, number>;
  setBatchStatus: Operation<
    { batchId: number; status: LogbookBatchStatus; error?: string; model?: string },
    void
  >;
  latestBatch: Operation<undefined, LogbookBatch | null>;
  resetRunningBatches: Operation<undefined, void>;
  resetErrorBatches: Operation<undefined, number>;
  nextPendingBatch: Operation<undefined, LogbookBatch | null>;
  batchFrames: Operation<{ batchId: number }, LogbookFrame[]>;
  replaceObservations: Operation<
    { batchId: number; day: string; segments: LogbookObservationInput[] },
    void
  >;
  observationsInRange: Operation<
    { day: string; startMs: number; endMs: number; tailLimit?: number },
    LogbookObservation[]
  >;
  cardsForDay: Operation<
    { day: string; window?: { startMs: number; endMs: number } },
    LogbookCard[]
  >;
  countCardsForDay: Operation<{ day: string }, number>;
  replaceCardsInWindow: Operation<
    {
      day: string;
      startMs: number;
      endMs: number;
      drafts: LogbookCardDraft[];
      selectKeyframes?: boolean;
    },
    void
  >;
  listDays: Operation<undefined, LogbookDay[]>;
  timelineForDay: Operation<{ day: string }, LogbookTimeline>;
  getStandup: Operation<{ day: string }, LogbookStandup | null>;
  saveStandup: Operation<{ day: string; text: string }, void>;
  pruneFrames: Operation<{ olderThanMs: number }, number>;
};
