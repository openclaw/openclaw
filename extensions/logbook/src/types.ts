export type LogbookFrame = {
  id: number;
  capturedAtMs: number;
  day: string;
  path: string;
  screenIndex: number;
  width?: number;
  height?: number;
  byteSize: number;
  idle: boolean;
};

export type LogbookBatchStatus = "pending" | "running" | "done" | "error";

export type LogbookBatch = {
  id: number;
  day: string;
  startMs: number;
  endMs: number;
  status: LogbookBatchStatus;
  error?: string;
  frameCount: number;
  model?: string;
};

export type LogbookObservation = {
  id: number;
  batchId: number;
  day: string;
  startMs: number;
  endMs: number;
  text: string;
};

export type LogbookDistraction = Pick<LogbookObservation, "startMs" | "endMs"> & {
  title: string;
};

export type LogbookCard = Pick<LogbookObservation, "id" | "day" | "startMs" | "endMs"> & {
  title: string;
  summary: string;
  detail: string;
  category: string;
  appPrimary?: string;
  appSecondary?: string;
  distractions: LogbookDistraction[];
  keyframeId?: number;
};

export type LogbookCardDraft = Omit<LogbookCard, "id" | "keyframeId">;

export type LogbookDayStats = {
  trackedMs: number;
  distractionMs: number;
  categories: Array<{ category: string; ms: number }>;
  apps: Array<{ domain: string; ms: number }>;
};
