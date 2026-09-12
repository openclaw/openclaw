import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalPathFromExistingAncestor } from "openclaw/plugin-sdk/file-access-runtime";
import {
  openSqliteWorkerStore,
  SqliteWorkerError,
  type SqliteWorkerStore,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { MAX_FRAMES_PER_CALL, sampleFrames } from "./analyze.js";
import { acquireLogbookFrameIo } from "./frame-io.js";
import type {
  LogbookBatchInput,
  LogbookFrameInput,
  LogbookObservationInput,
  LogbookOperations,
} from "./store-contract.js";
import type { LogbookBatchStatus, LogbookCardDraft } from "./types.js";

type CapturedFrame = Omit<LogbookFrameInput, "path" | "byteSize" | "contentHash" | "idle"> & {
  buffer: Buffer;
};

export class LogbookStore {
  readonly framesDir: string;
  private closing: Promise<void> | undefined;

  static async open(dataDir: string, workerModuleUrl: URL): Promise<LogbookStore> {
    if (!dataDir) {
      throw new Error("Logbook data directory is required");
    }
    const root = await canonicalPathFromExistingAncestor(path.resolve(dataDir));
    const worker = await openSqliteWorkerStore<LogbookOperations>({
      moduleUrl: workerModuleUrl,
      databasePath: path.join(dataDir, "logbook.sqlite"),
      input: { dataDir: root },
    });
    return new LogbookStore(dataDir, worker, acquireLogbookFrameIo(root));
  }

  private constructor(
    readonly dataDir: string,
    private readonly worker: SqliteWorkerStore<LogbookOperations>,
    private readonly frameIo: ReturnType<typeof acquireLogbookFrameIo>,
  ) {
    this.framesDir = path.join(dataDir, "frames");
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.frameIo.close();
      await this.worker.close();
    })();
    return this.closing;
  }

  private execute<Key extends keyof LogbookOperations>(
    type: Key,
    input: LogbookOperations[Key]["input"],
  ): Promise<LogbookOperations[Key]["output"]> {
    if (this.closing) {
      return Promise.reject(new SqliteWorkerError("Logbook store is closed", "closed"));
    }
    return this.worker.execute({ type, input });
  }

  frameFilePath(day: string, capturedAtMs: number): string {
    return path.join(this.framesDir, day, `${capturedAtMs}.jpg`);
  }

  insertFrame(params: LogbookFrameInput) {
    return this.execute("insertFrame", params);
  }

  lastFrame() {
    return this.execute("lastFrame", undefined);
  }

  unbatchedActiveFrames(limit: number) {
    return this.execute("unbatchedActiveFrames", { limit });
  }

  countUnbatchedActiveFrames() {
    return this.execute("countUnbatchedActiveFrames", undefined);
  }

  frameById(id: number) {
    return this.execute("frameById", { id });
  }

  framesInRange(startMs: number, endMs: number) {
    return this.execute("framesInRange", { startMs, endMs });
  }

  createBatch(params: LogbookBatchInput) {
    return this.execute("createBatch", params);
  }

  setBatchStatus(batchId: number, status: LogbookBatchStatus, error?: string, model?: string) {
    return this.execute("setBatchStatus", { batchId, status, error, model });
  }

  latestBatch() {
    return this.execute("latestBatch", undefined);
  }

  resetRunningBatches() {
    return this.execute("resetRunningBatches", undefined);
  }

  resetErrorBatches() {
    return this.execute("resetErrorBatches", undefined);
  }

  nextPendingBatch() {
    return this.execute("nextPendingBatch", undefined);
  }

  batchFrames(batchId: number) {
    return this.execute("batchFrames", { batchId });
  }

  replaceObservations(batchId: number, day: string, segments: LogbookObservationInput[]) {
    return this.execute("replaceObservations", { batchId, day, segments });
  }

  observationsInRange(day: string, startMs: number, endMs: number, tailLimit?: number) {
    return this.execute("observationsInRange", { day, startMs, endMs, tailLimit });
  }

  cardsForDay(day: string, window?: { startMs: number; endMs: number }) {
    return this.execute("cardsForDay", { day, window });
  }

  countCardsForDay(day: string) {
    return this.execute("countCardsForDay", { day });
  }

  replaceCardsInWindow(
    day: string,
    startMs: number,
    endMs: number,
    drafts: LogbookCardDraft[],
    options?: { selectKeyframes: boolean },
  ) {
    return this.execute("replaceCardsInWindow", {
      day,
      startMs,
      endMs,
      drafts,
      selectKeyframes: options?.selectKeyframes,
    });
  }

  listDays() {
    return this.execute("listDays", undefined);
  }

  timelineForDay(day: string) {
    return this.execute("timelineForDay", { day });
  }

  getStandup(day: string) {
    return this.execute("getStandup", { day });
  }

  saveStandup(day: string, text: string) {
    return this.execute("saveStandup", { day, text });
  }

  captureFrame(params: CapturedFrame): Promise<number> {
    // Snapshot before admission so a queued caller cannot mutate the capture bytes.
    const buffer = Buffer.from(params.buffer);
    const input = { ...params, buffer };
    return this.frameIo.run(async () => {
      const contentHash = createHash("sha256").update(buffer).digest("hex");
      const previous = await this.worker.execute({ type: "lastFrame", input: undefined });
      const filePath = this.frameFilePath(input.day, input.capturedAtMs);
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await writeFile(filePath, buffer, { mode: 0o600 });
      return await this.worker.execute({
        type: "insertFrame",
        input: {
          capturedAtMs: input.capturedAtMs,
          day: input.day,
          path: filePath,
          screenIndex: input.screenIndex,
          width: input.width,
          height: input.height,
          byteSize: buffer.byteLength,
          contentHash,
          idle: previous?.contentHash === contentHash,
        },
      });
    });
  }

  framePayload(id: number) {
    return this.frameIo.run(async () => {
      const frame = await this.worker.execute({ type: "frameById", input: { id } });
      if (!frame) {
        return null;
      }
      return {
        frameId: frame.id,
        capturedAtMs: frame.capturedAtMs,
        width: frame.width,
        height: frame.height,
        format: "jpeg" as const,
        base64: (await readFile(frame.path)).toString("base64"),
      };
    });
  }

  batchImages(batchId: number) {
    return this.frameIo.run(async () => {
      const frames = await this.worker.execute({ type: "batchFrames", input: { batchId } });
      const images = [];
      for (const frame of sampleFrames(frames, MAX_FRAMES_PER_CALL)) {
        images.push({ frame, buffer: await readFile(frame.path) });
      }
      return images;
    });
  }

  pruneFrames(olderThanMs: number) {
    return this.frameIo.run(() =>
      this.worker.execute({ type: "pruneFrames", input: { olderThanMs } }),
    );
  }
}
