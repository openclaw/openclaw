import { describe, expect, it } from "vitest";
import {
  deviceApprover,
  formatAgo,
  memberDeviceRemovalCount,
  memberPresence,
  memberRunning,
  removalNote,
  roleName,
} from "./people-format.js";

const NOW = 1_800_000_000_000;
const device = (connections: number, lastSeenAt: number | null, runs = 0) => ({
  peerKey: "iroh:x",
  deviceFp: null,
  label: "Browser",
  approvedBy: null,
  lastSeen: null,
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

  it("uses persisted seconds after restart and the latest live activity when present", () => {
    const persisted = { ...device(0, null), lastSeen: (NOW - 300_000) / 1000 };
    expect(memberPresence([persisted], NOW)).toBe("last seen 5 min ago");
    expect(memberPresence([{ ...persisted, lastSeenAt: NOW - 60_000 }], NOW)).toBe(
      "last seen 1 min ago",
    );
  });

  it("identifies owner approvers and counts an unrecorded device alone", () => {
    const unrecorded = device(0, null);
    expect(deviceApprover(unrecorded, [unrecorded], [])).toBe("Approver unavailable");
    expect(memberDeviceRemovalCount([unrecorded], unrecorded)).toBe(1);
    const approved = {
      ...unrecorded,
      approvedBy: { kind: "owner" as const, by: "fp:owner" as const },
    };
    expect(
      deviceApprover(
        approved,
        [approved],
        [
          {
            deviceFp: "fp:owner",
            devicePub: "ed25519:owner",
            label: "Owner laptop",
            peerKeys: [],
            cert: {},
          },
        ],
      ),
    ).toBe("Approved by owner device Owner laptop");
    expect(deviceApprover(approved, [approved], [])).toBe("Approved by owner device fp:owner");
  });

  it("counts each device once when an expired approver is admitted again by its descendant", () => {
    const first = {
      ...device(0, null),
      peerKey: "iroh:first",
      deviceFp: "fp:first" as const,
      approvedBy: { kind: "member_device" as const, device_fp: "fp:second" as const },
    };
    const second = {
      ...device(0, null),
      peerKey: "iroh:second",
      deviceFp: "fp:second" as const,
      approvedBy: { kind: "member_device" as const, device_fp: "fp:first" as const },
    };
    const independent = { ...device(0, null), peerKey: "iroh:independent" };
    expect(memberDeviceRemovalCount([first, second, independent], first)).toBe(2);
    expect(memberDeviceRemovalCount([first, second, independent], second)).toBe(2);
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
