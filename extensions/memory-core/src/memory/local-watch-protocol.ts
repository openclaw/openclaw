import type { MemoryWorkspaceWatchRequest } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { MemoryWatchFacts } from "./file-watcher.js";

export type { MemoryWatchFacts } from "./file-watcher.js";

export type LocalWatchCommand =
  | { type: "open"; id: number; workspaceDir: string; request: MemoryWorkspaceWatchRequest }
  | { type: "close"; id: number }
  | { type: "shutdown" };

export type LocalWatchEvent =
  | ({ id: number } & (
      | { type: "started" | "state"; facts: MemoryWatchFacts }
      | { type: "dirty" | "change" | "unavailable" }
      | { type: "closed"; error?: string }
    ))
  | { type: "shutdown"; error?: string };
