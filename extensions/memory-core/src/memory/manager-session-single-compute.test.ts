import { DatabaseSync } from "node:sqlite";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

// A two-CPU host leaves one shared compute permit for the export and index workers together.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const availableParallelism = () => 2;
  return { ...actual, availableParallelism, default: { ...actual, availableParallelism } };
});

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const fixture = createManagerIndexFixture({ getMemorySearchManager, closeAllMemorySearchManagers });

it("indexes a multi-page session export through the real producer under one compute permit", async () => {
  const capacity = (globalThis as Record<symbol, { getSnapshot(): { limit: number } }>)[
    Symbol.for("openclaw.workerComputeCapacity")
  ];
  expect(capacity?.getSnapshot().limit).toBe(1);
  // Each message exceeds half an export page, so the transcript spans several pages.
  const body = (label: string) =>
    Array.from({ length: 30_000 }, (_, index) => `${label}${index}`).join(" ");
  await fixture.seedSessionTranscript({
    sessionId: "single-permit",
    messages: [
      { role: "user", content: `HEAD_MARKER ${body("first")}`, timestamp: 1 },
      { role: "assistant", content: body("second"), timestamp: 2 },
      { role: "user", content: `${body("third")} TAIL_MARKER`, timestamp: 3 },
    ],
  });
  const cfg = fixture.createConfig({
    provider: "none",
    sources: ["sessions"],
    sessionMemory: true,
  });
  const manager = await fixture.getFreshManager(cfg, "cli");
  await manager.sync({ reason: "single-permit", force: true });
  using db = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }), {
    readOnly: true,
  });
  const texts = db
    .prepare("SELECT text FROM memory_index_chunks WHERE source = 'sessions' ORDER BY start_line")
    .all()
    .map((row) => String(row.text));
  expect(texts.some((text) => text.includes("HEAD_MARKER"))).toBe(true);
  expect(texts.some((text) => text.includes("TAIL_MARKER"))).toBe(true);
}, 60_000);
