// Path helpers for the file-backed task store. The orchestrator's tasks
// live under `<openclawHome>/tasks/orchestrator/` with kind-specific
// subdirs to keep synthetic and shadow runs out of the live namespace.

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { TaskKind } from "./types/schema.js";

export interface StorePathsOptions {
  /** Override the openclaw home dir (defaults to `~/.openclaw`). */
  openclawHome?: string;
}

export function defaultOpenclawHome(): string {
  return resolve(homedir(), ".openclaw");
}

export function tasksRoot(options: StorePathsOptions = {}): string {
  return resolve(options.openclawHome ?? defaultOpenclawHome(), "tasks", "orchestrator");
}

export function liveDir(options: StorePathsOptions = {}): string {
  return tasksRoot(options);
}

export function syntheticDir(options: StorePathsOptions = {}): string {
  return resolve(tasksRoot(options), "synthetic");
}

export function shadowDir(options: StorePathsOptions = {}): string {
  return resolve(tasksRoot(options), "shadow");
}

export function archiveDir(options: StorePathsOptions = {}): string {
  return resolve(tasksRoot(options), "archive");
}

export function dirForKind(kind: TaskKind, options: StorePathsOptions = {}): string {
  switch (kind) {
    case "live":
      return liveDir(options);
    case "synthetic":
      return syntheticDir(options);
    case "shadow":
      return shadowDir(options);
  }
}

export function taskPath(id: string, kind: TaskKind, options: StorePathsOptions = {}): string {
  return resolve(dirForKind(kind, options), `${id}.json`);
}

export function lockPath(id: string, kind: TaskKind, options: StorePathsOptions = {}): string {
  return resolve(dirForKind(kind, options), `${id}.lock`);
}

export function tempPath(id: string, kind: TaskKind, options: StorePathsOptions = {}): string {
  return resolve(dirForKind(kind, options), `${id}.json.tmp`);
}
