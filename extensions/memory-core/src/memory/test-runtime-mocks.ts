// Memory Core plugin module implements test runtime mocks behavior.
import { vi } from "vitest";

// Unit tests: avoid importing the real watcher implementation (native fsevents, etc.).
vi.mock("chokidar", () => ({
  default: {
    watch: () => ({ on: () => {}, close: async () => {}, whenReady: async () => {} }),
  },
  watch: () => ({ on: () => {}, close: async () => {}, whenReady: async () => {} }),
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));
