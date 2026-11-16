import { expect, it } from "vitest";
import { SessionManagerCore } from "./session-manager-core.js";
import { SessionManagerNavigation } from "./session-manager-navigation.js";
import type { SessionEntry } from "./session-manager-types.js";
import {
  sessionManagerReadTranscriptBranch,
  type SessionManagerBoundedContext,
} from "./session-manager-view-types.js";

it.each(["compaction", "reset"] as const)(
  "reads the bounded %s branch without adopting a later physical leaf",
  (type) => {
    const timestamp = "2026-11-16T00:00:00.000Z";
    const message = (id: string, parentId: string | null): SessionEntry => ({
      type: "message",
      id,
      parentId,
      timestamp,
      message: { role: "user", content: id, timestamp: 0 },
    });
    const common = { id: "boundary", parentId: "opaque", timestamp, firstKeptEntryId: "omitted" };
    const boundary: SessionEntry =
      type === "compaction"
        ? { ...common, type, summary: "earlier context", tokensBefore: 10 }
        : { ...common, type, reason: "reset" };
    const events = [
      { type: "session", version: 4, id: "bounded", cwd: "/synthetic", timestamp },
      message("retained", null),
      { type: "future", id: "opaque", parentId: "retained" },
      boundary,
      message("selected", "boundary"),
      message("other-branch", null),
    ];
    const bounded: SessionManagerBoundedContext = {
      activeLeafEntryId: "selected",
      version: { generation: "bounded", rawSeq: 5, updatedAt: 1 },
      parents: [
        ["retained", null],
        ["boundary", "opaque"],
        ["selected", "boundary"],
      ],
      opaqueParents: [["opaque", "retained"]],
      firstKeptRanges: [["boundary", { startIndex: 1, endIndex: 3 }]],
      boundaryCount: 1,
      persistedSuffixStartSeq: 1,
      transcriptMutationAt: 1,
      limits: { compaction: true },
    };
    const branch = new SessionManagerNavigation({ events, bounded }).getBranch();
    expect(branch.map((entry) => entry.id)).toEqual(["retained", "boundary", "selected"]);
    expect(branch[1]).toMatchObject({ parentId: "retained", firstKeptEntryId: "retained" });
    const manager = new SessionManagerCore("/synthetic", undefined, events, bounded);
    expect(branch).toEqual(manager[sessionManagerReadTranscriptBranch]());
  },
);
