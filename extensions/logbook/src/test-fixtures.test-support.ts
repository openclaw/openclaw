import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, vi } from "vitest";
import { resolveLogbookConfig } from "./config.js";
import { LogbookService } from "./service.js";
import { logbookSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import type { LogbookFrameInput } from "./store-contract.js";
import { LogbookStore } from "./store.js";
import type { LogbookCardDraft } from "./types.js";

export const workerModuleUrl = resolveRuntimeWorkerUrl(logbookSqliteBackendEntrypoint);
export const DAY = "2026-07-03";
export const BASE = new Date(`${DAY}T10:00:00`).getTime();
export const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
export const batchInput = (frameIds: number[], startMs = 1, endMs = 2, day = DAY) => ({
  day,
  startMs,
  endMs,
  frameIds,
});

export function useLogbookFixture(prefix: string) {
  const closers: Array<() => unknown> = [];
  const defer = (close: () => unknown) => void closers.push(close);
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      try {
        await Promise.all(closers.splice(0).map((close) => close()));
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
        cleanup();
      }
    }),
  );
  const makeDir = () => realpathSync(dirs.make(prefix));
  const open = async (dir: string) => {
    const store = await LogbookStore.open(dir, workerModuleUrl);
    defer(() => store.close());
    return store;
  };
  const startService = async (
    config: Parameters<typeof resolveLogbookConfig>[0],
    deps: Omit<ConstructorParameters<typeof LogbookService>[1], "scheduler" | "workerModuleUrl">,
  ) => {
    const service = new LogbookService(resolveLogbookConfig(config), {
      ...deps,
      workerModuleUrl,
      scheduler: createTestPluginServiceScheduler(),
    });
    defer(() => service.stop());
    await service.start();
    return service;
  };
  return { makeDir, open, defer, startService };
}

export function frameInput(
  input: Pick<LogbookFrameInput, "path"> & Partial<LogbookFrameInput>,
): LogbookFrameInput {
  return {
    day: DAY,
    capturedAtMs: 0,
    screenIndex: 0,
    byteSize: 0,
    contentHash: "synthetic",
    idle: false,
    ...input,
  };
}

export function cardDraft(overrides: Partial<LogbookCardDraft> = {}): LogbookCardDraft {
  return {
    day: DAY,
    startMs: BASE,
    endMs: BASE + 30 * 60_000,
    title: "Card",
    summary: "Summary",
    detail: "",
    category: "coding",
    distractions: [],
    ...overrides,
  };
}

export function withDatabase<T>(file: string, run: (db: DatabaseSync) => T, readOnly = false): T {
  const db = new DatabaseSync(file, { readOnly });
  try {
    return run(db);
  } finally {
    db.close();
  }
}
export const readRows = (file: string, sql: string) =>
  withDatabase(file, (db) => db.prepare(sql).all(), true);
export const execSql = (file: string, sql: string) => withDatabase(file, (db) => db.exec(sql));
