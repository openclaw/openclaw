import { describe, expect, it } from "vitest";
import { orderManagedTabEvictionCandidates } from "./server-context.tab-ops.js";
import type { BrowserTab } from "./server-context.types.js";

const tab = (targetId: string): BrowserTab => ({
  targetId,
  title: `tab ${targetId}`,
  url: `https://example.test/${targetId}`,
  wsUrl: "",
  type: "page",
});

// Chrome reports CDP targets most-recently-activated first, so fixture order
// mirrors a real /json/list payload: freshest tab at the front.
const CDP_ORDER = ["t2", "t3", "t1", "idle-1", "idle-2", "idle-3", "idle-4", "idle-5"].map(tab);

describe("orderManagedTabEvictionCandidates", () => {
  it("evicts the least recently tracked tab first, not the freshest CDP entry", () => {
    const lastUsed = new Map<string, number>([
      ["idle-1", 1_000],
      ["idle-2", 2_000],
      ["idle-3", 3_000],
      ["idle-4", 4_000],
      ["idle-5", 5_000],
      ["t1", 900_000],
      ["t3", 950_000],
      ["t2", 999_000],
    ]);
    const ordered = orderManagedTabEvictionCandidates(CDP_ORDER, lastUsed);
    expect(ordered[0]?.targetId).toBe("idle-1");
    expect(ordered.at(-1)?.targetId).toBe("t2");
  });

  it("sends untracked tabs out first in reverse CDP order, ahead of tracked ones", () => {
    const lastUsed = new Map<string, number>([
      ["idle-1", 1_000],
      ["idle-2", 2_000],
      ["idle-3", 3_000],
      ["idle-4", 4_000],
      ["idle-5", 5_000],
    ]);
    const ordered = orderManagedTabEvictionCandidates(CDP_ORDER, lastUsed);
    expect(ordered.map((entry) => entry.targetId)).toEqual([
      "t1",
      "t3",
      "t2",
      "idle-1",
      "idle-2",
      "idle-3",
      "idle-4",
      "idle-5",
    ]);
  });

  it("keeps reverse CDP order as a stable fallback when nothing is tracked", () => {
    const ordered = orderManagedTabEvictionCandidates(CDP_ORDER, new Map());
    expect(ordered.map((entry) => entry.targetId)).toEqual([
      "idle-5",
      "idle-4",
      "idle-3",
      "idle-2",
      "idle-1",
      "t1",
      "t3",
      "t2",
    ]);
  });
});
