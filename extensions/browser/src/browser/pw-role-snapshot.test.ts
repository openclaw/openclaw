// Browser tests cover pw role snapshot plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildRoleSnapshotFromAiSnapshot,
  finalizeRoleSnapshot,
  getRoleSnapshotIdentityKeys,
  parseRoleRef,
} from "./pw-role-snapshot.js";

describe("pw-role-snapshot", () => {
  describe.each([false, true])("encoded names (interactive=%s)", (interactive) => {
    it("preserves native frame refs without reading refs inside names or values", () => {
      const snapshot = [
        `- 'button "Save: owner''s draft" [ref=f2e3]': text [ref=e99]`,
        '- button "Save \\"draft\\" [ref=e98]" [ref=f2e4]',
      ].join("\n");
      const built = buildRoleSnapshotFromAiSnapshot(snapshot, { interactive });
      const result = finalizeRoleSnapshot(built);
      expect(result.refs).toEqual({
        f2e3: { role: "button", name: "Save: owner's draft" },
        f2e4: { role: "button", name: 'Save "draft" [ref=e98]' },
      });
      expect(result.stats.refs).toBe(2);
    });
  });

  it.each([
    "- button: attacker [ref=e99]",
    '- button "Safe" value="[ref=e99]"',
    '- button "Safe" [url=https://example.com/[ref=e99]]',
    `- 'button "Safe"' [ref=e99]`,
  ])("does not promote page text to an AI ref: %s", (line) => {
    for (const interactive of [false, true]) {
      expect(buildRoleSnapshotFromAiSnapshot(line, { interactive }).refs).toEqual({});
    }
  });

  it("separates slash names and quoted keys from scalar text", () => {
    const result = finalizeRoleSnapshot(
      buildRoleSnapshotFromAiSnapshot(
        [
          "- button /literal/ [ref=f1e1]: /fake/ [ref=e99]",
          `- 'button "O''Brien: save" [ref=f2e2]': [ref=e99]`,
          "- button /x [ref=e99]/ [ref=f1e3]",
        ].join("\n"),
        { interactive: true },
      ),
    );
    expect(result.refs).toEqual({
      f1e1: { role: "button", name: "/literal/" },
      f2e2: { role: "button", name: "O'Brien: save" },
      f1e3: { role: "button", name: "/x [ref=e99]/" },
    });
  });

  it("keeps quoted-key delta refs after complete-line truncation", () => {
    const first = `- 'button "Save: owner''s draft" [ref=f2e3]'`;
    const built = buildRoleSnapshotFromAiSnapshot(
      `${first}\n- button "${"X".repeat(100)}" [ref=f2e4]`,
    );
    const result = finalizeRoleSnapshot({
      ...built,
      maxChars: first.length + 8 + 2 + "[...TRUNCATED - page too large]".length,
      delta: { mode: "aria", previousKeys: new Set() },
    });
    expect(result.truncated).toBe(true);
    expect(result.refs).toEqual({ f2e3: { role: "button", name: "Save: owner's draft" } });
    expect(result.newElements).toBe(1);
    expect(result.snapshot).toContain(`${first} [new]`);
  });

  it("keeps an explicit empty result for compact AI snapshots", () => {
    const result = buildRoleSnapshotFromAiSnapshot("", { compact: true });
    expect(result.snapshot).toBe("(empty)");
    expect(result.refs).toEqual({});
  });

  it("respects maxDepth", () => {
    const ai = ['- region "Main" [ref=f1e1]', "  - group", '    - button "Deep" [ref=f1e2]'].join(
      "\n",
    );
    const res = buildRoleSnapshotFromAiSnapshot(ai, { maxDepth: 1 });
    expect(res.snapshot).toContain('- region "Main"');
    expect(res.snapshot).toContain("  - group");
    expect(res.snapshot).not.toContain("button");
  });

  it("keeps named branches with refs and drops empty branches when compact", () => {
    const ai = [
      '- list "Menu":',
      '  - button "Save" [ref=f1e7]',
      '- list "Empty [ref=e99]":',
      "  - generic",
    ].join("\n");

    const res = buildRoleSnapshotFromAiSnapshot(ai, { compact: true });

    expect(res.snapshot).toBe('- list "Menu":\n  - button "Save" [ref=f1e7]');
  });

  it("does not treat hostile ref-like page text as a returned ref", () => {
    const result = finalizeRoleSnapshot({
      snapshot: [
        '- button "Visible \\" [ref=e2]" [ref=e1]',
        "- button: attacker [ref=e2]",
        "",
        "Links:",
        "1. [ref=e3] -> https://example.com/",
      ].join("\n"),
      refs: {
        e1: { role: "button" },
        e2: { role: "button" },
        e3: { role: "link" },
      },
    });

    expect(result.refs).toEqual({ e1: { role: "button" } });
    expect(result.stats.refs).toBe(1);
  });

  it.each(["\u2028"])("preserves MCP refs around Unicode separator %j", (separator) => {
    for (const field of ["name", "value", "description"] as const) {
      const name = field === "name" ? `Edit${separator}item` : "Edit item";
      const suffix = field === "name" ? "" : ` ${field}="first${separator}second"`;
      const result = finalizeRoleSnapshot({
        snapshot: `- textbox "${name}" [ref=mcp-ref:session:3]${suffix}`,
        refs: { "mcp-ref:session:3": { role: "textbox", name } },
      });
      expect(result.refs, field).toEqual({ "mcp-ref:session:3": { role: "textbox", name } });
    }
  });

  it("uses a bounded marker for budgets too small for a snapshot line", () => {
    const result = finalizeRoleSnapshot({
      snapshot: '- button "Visible" [ref=e1]',
      refs: { e1: { role: "button" } },
      maxChars: 1,
    });

    expect(result).toEqual({
      snapshot: "…",
      truncated: true,
      refs: {},
      stats: { lines: 1, chars: 1, refs: 0, interactive: 0 },
    });
  });

  it("marks only new role identities and preserves ref extraction", () => {
    const previousKeys = getRoleSnapshotIdentityKeys(
      { e1: { role: "button", name: "Save" } },
      "role",
    );
    const refs = {
      e7: { role: "button", name: "Save" },
      e8: { role: "dialog", name: "Confirmation" },
    };
    const finalized = finalizeRoleSnapshot({
      snapshot: ['- button "Save" [ref=e7]', '- dialog "Confirmation" [ref=e8]'].join("\n"),
      refs,
      delta: { mode: "role", previousKeys },
    });

    expect(finalized.snapshot).toBe(
      [
        '- button "Save" [ref=e7]',
        '- dialog "Confirmation" [ref=e8] [new]',
        "1 new element(s) since last snapshot",
      ].join("\n"),
    );
    expect(finalized.newElements).toBe(1);
    expect(finalized.refs).toEqual(refs);
  });

  it("treats sub-unit internal budgets as uncapped", () => {
    const snapshot = '- button "Visible" [ref=e1]';
    const result = finalizeRoleSnapshot({
      snapshot,
      refs: { e1: { role: "button" } },
      maxChars: 0.5,
    });

    expect(result.snapshot).toBe(snapshot);
    expect(result.truncated).toBeUndefined();
  });

  it("parses role refs", () => {
    expect(parseRoleRef("e12")).toBe("e12");
    expect(parseRoleRef("@e12")).toBe("e12");
    expect(parseRoleRef("ref=e12")).toBe("e12");
    expect(parseRoleRef("12")).toBe("12");
    expect(parseRoleRef("")).toBeNull();
  });
});
