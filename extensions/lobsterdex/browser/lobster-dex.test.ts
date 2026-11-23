/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dex from "./lobster-dex.ts";

beforeEach(() => {
  // Vitest storage must be an own value property for getSafeLocalStorage.
  vi.stubGlobal("localStorage", window.localStorage);
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

function repeat(count: number, action: () => void) {
  for (let i = 0; i < count; i++) {
    action();
  }
}

describe("lobsterdex", () => {
  it("records palettes once and round-trips through storage", () => {
    expect(dex.getLobsterdex().size).toBe(0);
    dex.recordLobsterVisit("crimson");
    dex.recordLobsterVisit("gold");
    dex.recordLobsterVisit("crimson");
    expect([...dex.getLobsterdex()].toSorted()).toEqual(["crimson", "gold"]);
  });

  it("migrates v1 array entries and backfills memories on the next visit", () => {
    localStorage.setItem("openclaw.control.lobsterdex.v1", JSON.stringify(["crimson"]));
    const migrated = dex.getLobsterdexEntries().get("crimson");
    expect(migrated).toEqual({ firstSeenAt: null, name: null, shinySeenAt: null });
    expect(dex.getLobsterdex().has("crimson")).toBe(true);
    dex.recordLobsterVisit("crimson", { name: "Pinchy" });
    const backfilled = dex.getLobsterdexEntries().get("crimson");
    expect(backfilled?.name).toBe("Pinchy");
    expect(backfilled?.firstSeenAt).not.toBeNull();
  });

  it("logs the first shiny sighting once, even on settled entries", () => {
    dex.recordLobsterVisit("gold", { name: "Goldie" });
    expect(dex.getLobsterdexEntries().get("gold")?.shinySeenAt).toBeNull();
    const before = Date.now();
    dex.recordLobsterVisit("gold", { name: "Impostor", shiny: true });
    const shinySeenAt = dex.getLobsterdexEntries().get("gold")?.shinySeenAt;
    expect(shinySeenAt).toBeGreaterThanOrEqual(before);
    expect(dex.getLobsterdexEntries().get("gold")?.name).toBe("Goldie");
    dex.recordLobsterVisit("gold", { shiny: true });
    expect(dex.getLobsterdexEntries().get("gold")?.shinySeenAt).toBe(shinySeenAt);
  });

  it("tolerates corrupt storage", () => {
    localStorage.setItem("openclaw.control.lobsterdex.v1", "{not json");
    expect(dex.getLobsterdex().size).toBe(0);
    dex.recordLobsterVisit("blue");
    expect(dex.getLobsterdex().has("blue")).toBe(true);
  });
  it("tiers by visit count and grows wary of frequent shooing", () => {
    expect(dex.getLobsterFamiliarity()).toMatchObject({ tier: "shy", wary: false });
    repeat(3, dex.recordLobsterArrivalStats);
    expect(dex.getLobsterFamiliarity().tier).toBe("regular");
    repeat(12, dex.recordLobsterArrivalStats);
    expect(dex.getLobsterFamiliarity().tier).toBe("friend");
    repeat(3, dex.recordLobsterShoo);
    expect(dex.getLobsterFamiliarity().wary).toBe(false);
    repeat(3, dex.recordLobsterShoo);
    expect(dex.getLobsterFamiliarity().wary).toBe(true);
  });
  it("awards honorifics at visit milestones", () => {
    const titles = [null, null, "Sir", "Sir", "Captain", "Elder", "Elder"];
    expect([0, 49, 50, 99, 100, 250, 9001].map(dex.lobsterHonorific)).toEqual(titles);
  });

  it("recognizes first-visit anniversaries by month and day", () => {
    const first = new Date("2025-07-09T15:30:00").getTime();
    const anniversary = (date: string, start: number | null = first) =>
      dex.isLobsterFirstVisitAnniversary(start, new Date(date));
    expect(anniversary("2026-07-09T09:00:00")).toBe(true);
    expect(anniversary("2027-07-09T21:00:00")).toBe(true);
    expect(anniversary("2026-07-10T09:00:00")).toBe(false);
    expect(anniversary("2026-06-09T09:00:00")).toBe(false);
    expect(anniversary("2026-07-09T09:00:00", null)).toBe(false);
  });
});
