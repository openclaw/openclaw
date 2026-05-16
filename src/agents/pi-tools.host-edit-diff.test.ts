import { describe, expect, it } from "vitest";
import { buildEditDiff } from "./pi-tools.host-edit-diff.js";

// ---------------------------------------------------------------------------
// buildEditDiff unit tests — regression coverage for the recovery-branch
// diff renderer added in #82015.  The pinned upstream `createEditTool`
// already populates `details.diff` on the normal-success path; this helper
// only runs on the `wrapEditToolWithRecovery` recovery branch (base tool
// threw but the file actually changed) so the recovered success result can
// drive the same HTML rendering as a normal success.
// ---------------------------------------------------------------------------

describe("buildEditDiff (#82015)", () => {
  it("returns empty string when content is byte-identical", () => {
    expect(buildEditDiff("alpha\nbeta\n", "alpha\nbeta\n", "x.txt")).toBe("");
  });

  it("renders a unified-diff header + single hunk for a one-line change", () => {
    const before = "line1\nline2\nline3\n";
    const after = "line1\nLINE2\nline3\n";
    const diff = buildEditDiff(before, after, "src/foo.ts");

    expect(diff).toContain("--- a/src/foo.ts");
    expect(diff).toContain("+++ b/src/foo.ts");
    expect(diff).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
    expect(diff).toContain("-line2");
    expect(diff).toContain("+LINE2");
    expect(diff).toContain(" line1");
    expect(diff).toContain(" line3");
  });

  it("normalises CRLF input so a Windows-encoded file produces the same diff", () => {
    const before = "alpha\r\nbeta\r\ngamma\r\n";
    const after = "alpha\r\nBETA\r\ngamma\r\n";
    const diff = buildEditDiff(before, after, "x.txt");
    expect(diff).toContain("-beta");
    expect(diff).toContain("+BETA");
    // No raw \r in the output — the renderer normalises to LF before splitting.
    expect(diff).not.toMatch(/\r/);
  });

  it("renders an all-added hunk for an empty → populated edit", () => {
    const diff = buildEditDiff("", "new line\nanother\n", "fresh.md");
    expect(diff).toContain("+new line");
    expect(diff).toContain("+another");
    expect(diff).toContain("--- a/fresh.md");
    expect(diff).toContain("+++ b/fresh.md");
  });

  it("groups multiple non-adjacent changes into separate hunks", () => {
    const before = [
      "context-a-1",
      "context-a-2",
      "context-a-3",
      "oldA",
      "context-a-4",
      "context-a-5",
      "context-a-6",
      "context-mid-1",
      "context-mid-2",
      "context-mid-3",
      "context-mid-4",
      "context-mid-5",
      "context-mid-6",
      "context-b-1",
      "context-b-2",
      "context-b-3",
      "oldB",
      "context-b-4",
      "context-b-5",
      "context-b-6",
    ].join("\n");
    const after = before.replace("oldA", "newA").replace("oldB", "newB");
    const diff = buildEditDiff(before, after, "split.txt");
    const hunks = (diff.match(/^@@ /gm) || []).length;
    expect(hunks).toBe(2);
    expect(diff).toContain("-oldA");
    expect(diff).toContain("+newA");
    expect(diff).toContain("-oldB");
    expect(diff).toContain("+newB");
  });

  it("caps rendered output at the safety limit with a truncation marker", () => {
    // Stay under the DIFF_MAX_INPUT_LINES (2000) guard so the LCS still runs,
    // but change every line so the rendered output exceeds DIFF_MAX_OUTPUT_LINES.
    const beforeLines = Array.from({ length: 600 }, (_, i) => `old-line-${i}`);
    const afterLines = Array.from({ length: 600 }, (_, i) => `new-line-${i}`);
    const diff = buildEditDiff(beforeLines.join("\n"), afterLines.join("\n"), "huge.txt");
    expect(diff).toContain("... (");
    expect(diff).toContain("more lines)");
    expect(diff.split("\n").length).toBeLessThanOrEqual(401); // 400 cap + marker
  });

  it("skips LCS allocation entirely when input exceeds DIFF_MAX_INPUT_LINES", () => {
    // Per reviewer feedback (#82618): the LCS matrix is O(n*m).  A 5000-line
    // file edit should NOT allocate a 5001*5001 matrix.  The helper must
    // pre-check and bail out with "" before doing the quadratic work.
    const huge = Array.from({ length: 5000 }, (_, i) => `line-${i}`).join("\n");
    const hugeChanged = huge.replace("line-0", "LINE-0");
    const started = Date.now();
    const diff = buildEditDiff(huge, hugeChanged, "huge.txt");
    const elapsed = Date.now() - started;
    expect(diff).toBe("");
    // Pre-guard should be O(1) in line count — well under a second even on
    // a slow CI box.  An LCS of 5000*5000 would take many seconds.
    expect(elapsed).toBeLessThan(500);
  });

  it("returns empty when only difference is the file path argument", () => {
    // The file-path argument only affects rendered header text — it must NOT
    // make identical content show as a diff.
    expect(buildEditDiff("same", "same", "a.txt")).toBe("");
    expect(buildEditDiff("same", "same", "b.txt")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// wrapEditToolWithRecovery — diff attached on the recovery branch only.
//
// We do NOT cover the happy path here because the pinned upstream
// `createEditTool` (from `@earendil-works/pi-coding-agent`) already
// populates `details.diff` on normal success; the wrapper's recovery
// branch is the only place this PR changes behaviour.
// ---------------------------------------------------------------------------

import { wrapEditToolWithRecovery } from "./pi-tools.host-edit.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

describe("wrapEditToolWithRecovery — recovery diff attachment (#82015)", () => {
  function makeBaseTool(
    behavior: (params: unknown) => Promise<{
      isError: boolean;
      content: { type: "text"; text: string }[];
      details?: Record<string, unknown>;
    }>,
  ): AnyAgentTool {
    return {
      name: "edit",
      description: "test",
      parameters: { type: "object" },
      execute: async (_id: string, params: unknown) => (await behavior(params)) as never,
    } as unknown as AnyAgentTool;
  }

  it("attaches a unified diff when base throws AFTER write but edit landed", async () => {
    const files = new Map<string, string>();
    files.set("/root/bar.ts", "alpha\nbeta\ngamma\n");

    const base = makeBaseTool(async (params) => {
      const p = params as { path: string; edits: { oldText: string; newText: string }[] };
      let content = files.get(`/root/${p.path}`) ?? "";
      for (const e of p.edits) {
        content = content.replace(e.oldText, e.newText);
      }
      files.set(`/root/${p.path}`, content);
      // Real-world failure mode: base tool writes successfully, then throws
      // on a downstream step (e.g. generateDiffString upstream).  Wrapper
      // detects the write succeeded and recovers — and now also computes
      // its own diff so the recovered success result still renders cleanly
      // in the HTML export.
      throw new Error("post-write spurious error");
    });

    const wrapped = wrapEditToolWithRecovery(base, {
      root: "/root",
      readFile: async (abs) =>
        files.get(abs) ??
        (() => {
          throw new Error("ENOENT");
        })(),
    });

    const result = (await wrapped.execute(
      "call-1",
      { path: "bar.ts", edits: [{ oldText: "beta", newText: "BETA" }] },
      undefined,
    )) as { isError?: boolean; details?: { diff?: string } };

    expect(result.isError).toBe(false);
    expect(result.details?.diff).toBeDefined();
    expect(result.details!.diff).toContain("-beta");
    expect(result.details!.diff).toContain("+BETA");
    expect(result.details!.diff).toContain("--- a/bar.ts");
  });

  it("recovery result still ships when buildEditDiff returns '' (no snapshot)", async () => {
    // If originalContent capture failed (e.g. file did not exist before the
    // edit), the recovery branch must still emit today's empty-diff success
    // result rather than crashing.
    const files = new Map<string, string>();

    const base = makeBaseTool(async (params) => {
      const p = params as { path: string; edits: { oldText: string; newText: string }[] };
      files.set(`/root/${p.path}`, "newly-created content\n");
      throw new Error("post-write spurious error");
    });

    const wrapped = wrapEditToolWithRecovery(base, {
      root: "/root",
      readFile: async (abs) =>
        files.get(abs) ??
        (() => {
          throw new Error("ENOENT");
        })(),
    });

    // No prior content for "/root/new.ts" → originalContent capture throws
    // ENOENT inside the wrapper and is swallowed.  Recovery still succeeds.
    const result = (await wrapped.execute(
      "call-2",
      { path: "new.ts", edits: [{ oldText: "missing", newText: "newly-created" }] },
      undefined,
    )) as { isError?: boolean; details?: { diff?: string } };

    // Whether this case lands in the "no-snapshot" branch or somewhere else
    // depends on how didEditLikelyApply scores the result, but in any path
    // the wrapper must NOT throw uncaught.
    expect(result).toBeDefined();
    // If recovery did fire, the diff is "" (no snapshot to compare against)
    if (result.isError === false && result.details) {
      expect(typeof result.details.diff).toBe("string");
    }
  });
});
