import { describe, expect, it } from "vitest";
import {
  formatAgo,
  memberPresence,
  memberRunning,
  removalNote,
  roleName,
} from "./people-format.js";

const NOW = 1_800_000_000_000;
const device = (connections: number, lastSeenAt: number | null, runs = 0) => ({
  peerKey: "iroh:x",
  connections,
  lastSeenAt,
  runs: Array.from({ length: runs }, (_, i) => ({ runId: `r${i}`, sessionKey: `s${i}` })),
});

describe("People page wording", () => {
  it("labels built-ins and preserves opaque role names exactly", () => {
    expect(roleName("operator")).toBe("Operator");
    expect(roleName("viewer")).toBe("Viewer");
    expect(roleName("guest")).toBe("guest");
    expect(roleName("support_team-2")).toBe("support_team-2");
  });

  it("says active now, last seen, or not seen yet", () => {
    expect(memberPresence([device(1, NOW)], NOW)).toBe("active now");
    expect(memberPresence([device(0, NOW - 5 * 60_000)], NOW)).toBe("last seen 5 min ago");
    expect(memberPresence([device(0, null)], NOW)).toBe("not seen yet");
    expect(formatAgo(NOW - 2 * 86_400_000, NOW)).toBe("2 days ago");
  });

  it("names a single run by its session title and counts several", () => {
    const title = (key: string) => (key === "s0" ? "Summarize Q3 notes" : undefined);
    expect(memberRunning([device(1, NOW, 1)], title)).toBe("running “Summarize Q3 notes”");
    expect(memberRunning([device(1, NOW, 2)], title)).toBe("running 2 tasks");
    expect(memberRunning([device(1, NOW, 0)], title)).toBeUndefined();
  });

  it("states what a removal cut", () => {
    expect(removalNote("Bob", { devices: 1, connectionsClosed: 2, runsCancelled: 0 })).toBe(
      "Bob removed · 2 connections closed · 0 tasks stopped",
    );
    expect(removalNote("Bob", null)).toBe("Bob removed");
  });
});
