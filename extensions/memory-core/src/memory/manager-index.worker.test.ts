import { expect, it, vi } from "vitest";
import type { MemoryIndexTask } from "./manager-cpu-worker-runtime.js";

const { serve, unavailable } = vi.hoisted(() => ({
  serve: vi.fn<(handler: (input: unknown) => unknown) => void>(),
  unavailable: new Error("Session storage is unavailable"),
}));
// mock-isolation: Capture the worker handler without opening a real worker message port.
vi.mock("openclaw/plugin-sdk/worker-task-server", () => ({ serveWorkerTasks: serve }));
// mock-isolation: Throw on storage import so this test detects eager session-storage loading.
vi.mock("openclaw/plugin-sdk/memory-core-host-engine-sessions", () => {
  throw unavailable;
});

it("prepares chunks without loading session storage, which only transcript stats need", async () => {
  await import("./manager-index.worker.js");
  const handle = serve.mock.calls[0]?.[0];
  if (!handle) {
    throw new Error("Memory indexing worker did not register its task handler");
  }
  const task: MemoryIndexTask = {
    kind: "prepare",
    input: {
      entry: { path: "memory/notes.md", mtimeMs: 1 },
      source: "memory",
      content: "The irrigation starts at dawn.",
      pathClassification: { curatedRoot: false, originClass: "owner" },
      chunking: { tokens: 400, overlap: 80 },
      hardMaxInputTokens: 8192,
    },
  };
  await expect(handle(task)).resolves.toMatchObject({
    kind: "prepared",
    value: {
      chunks: [{ text: task.input.content, provenance: { originClass: "owner" } }],
    },
  });
  await expect(
    handle({ kind: "transcript-stats", scopes: [], env: { OPENCLAW_STATE_DIR: "/unused" } }),
  ).rejects.toThrow();
});
