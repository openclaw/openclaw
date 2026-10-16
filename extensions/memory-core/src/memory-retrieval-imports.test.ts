import { expect, it, vi } from "vitest";

// mock-isolation: Pure memory selectors must load without initializing session storage.
vi.mock("openclaw/plugin-sdk/memory-core-host-engine-sessions", () => {
  throw new Error("Memory retrieval selectors loaded the session-store runtime");
});

it("loads retrieval query and identity selectors without session storage", async () => {
  const [{ referencesSession }, { isMemorySessionIndexable }, { planKeywordSearch }] =
    await Promise.all([
      import("./memory-forget-content.js"),
      import("./memory/manager-session-sync-state.js"),
      import("./memory/keyword-query.js"),
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
