import { expect, it, vi } from "vitest";

// mock-isolation: Pure memory selectors must load without initializing session storage.
vi.mock("openclaw/plugin-sdk/memory-core-host-engine-sessions", () => {
  throw new Error("Memory retrieval selectors loaded the session-store runtime");
});
// mock-isolation: Read kernels must not initialize provider discovery or writable store owners.
vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", () => {
  throw new Error("Memory retrieval loaded the embedding-provider runtime");
});
// mock-isolation: Read kernels must not initialize the host database runtime.
vi.mock("openclaw/plugin-sdk/sqlite-runtime", () => {
  throw new Error("Memory retrieval loaded the host database runtime");
});

it("loads retrieval queries and read kernels without host storage or provider runtimes", async () => {
  const [{ referencesSession }, { isMemorySessionIndexable }, { planKeywordSearch }] =
    await Promise.all([
      import("./memory-forget-content.js"),
      import("./memory/manager-session-sync-state.js"),
      import("./memory/keyword-query.js"),
      import("./memory/manager-index-read.js"),
      import("./memory/manager-reindex-state.js"),
      import("./memory-entry-origin-reads.js"),
      import("./memory-forget-index-read.js"),
    ]);
  expect(planKeywordSearch({ query: "API deployment", matchAny: true }).tokens).toEqual([
    "API",
    "deployment",
  ]);
  const entry = {
    generatedByDreamingNarrative: false,
    generatedByCronRun: false,
    sessionKind: "interactive" as const,
  };
  expect(isMemorySessionIndexable(entry, "agent:main:chat:ordinary")).toBe(true);
  expect(isMemorySessionIndexable(entry, "agent:main:dreaming-narrative-fixture")).toBe(false);
  expect(isMemorySessionIndexable(entry, "agent:main:cron:job:run:fixture")).toBe(false);
  expect(
    referencesSession(
      "sessions/main/fixture.jsonl.deleted.2026-10-13T12-00-00.000Z.zst",
      "main",
      new Set(["fixture"]),
    ),
  ).toBe(true);
});
