import { describe, expect, it } from "vitest";
import {
  buildRoleSnapshotFromAiSnapshot as build,
  finalizeRoleSnapshot as finalize,
  getRoleSnapshotIdentityKeys as identityKeys,
  parseRoleRef,
} from "./pw-role-snapshot.js";

const visible = { snapshot: '- button "Visible" [ref=e1]', refs: { e1: { role: "button" } } };

describe("pw-role-snapshot", () => {
  it.each([false, true])("preserves encoded names and frame refs (%s)", (interactive) => {
    const snapshot = `- 'button "Save: owner''s draft" [ref=f2e3]': text [ref=e99]\n- button "Save \\"draft\\" [ref=e98]" [ref=f2e4]`;
    const { refs } = finalize(build(snapshot, { interactive }));
    expect(refs).toEqual({
      f2e3: { role: "button", name: "Save: owner's draft" },
      f2e4: { role: "button", name: 'Save "draft" [ref=e98]' },
    });
  });

  it.each([
    "- button: attacker [ref=e99]",
    '- button "Safe" value="[ref=e99]"',
    '- button "Safe" [url=https://example.com/[ref=e99]]',
    `- 'button "Safe"' [ref=e99]`,
  ])("does not promote page text to an AI ref: %s", (line) => {
    for (const interactive of [false, true]) {
      expect(build(line, { interactive }).refs).toEqual({});
    }
  });

  it("separates slash names and quoted keys from scalar text", () => {
    const snapshot = `- button /literal/ [ref=f1e1]: /fake/ [ref=e99]\n- 'button "O''Brien: save" [ref=f2e2]': [ref=e99]\n- button /x [ref=e99]/ [ref=f1e3]`;
    expect(finalize(build(snapshot, { interactive: true })).refs).toEqual({
      f1e1: { role: "button", name: "/literal/" },
      f2e2: { role: "button", name: "O'Brien: save" },
      f1e3: { role: "button", name: "/x [ref=e99]/" },
    });
  });

  it("keeps quoted-key delta refs after complete-line truncation", () => {
    const first = `- 'button "Save: owner''s draft" [ref=f2e3]'`;
    const result = finalize({
      ...build(`${first}\n- button "${"X".repeat(100)}" [ref=f2e4]`),
      maxChars: first.length + 8 + 2 + "[...TRUNCATED - page too large]".length,
      delta: { mode: "aria", previousKeys: new Set() },
    });
    expect(result).toMatchObject({ truncated: true, newElements: 1 });
    expect(result.refs).toEqual({ f2e3: { role: "button", name: "Save: owner's draft" } });
    expect(result.snapshot).toContain(`${first} [new]`);
  });

  it("keeps an explicit empty result for compact AI snapshots", () => {
    expect(build("", { compact: true })).toEqual({ snapshot: "(empty)", refs: {} });
  });

  it("respects maxDepth", () => {
    const res = build('- region "Main" [ref=f1e1]\n  - group\n    - button "Deep" [ref=f1e2]', {
      maxDepth: 1,
    });
    expect(res.snapshot).toBe('- region "Main" [ref=f1e1]\n  - group');
  });

  it("keeps named branches with refs and drops empty branches when compact", () => {
    const res = build(
      '- list "Menu":\n  - button "Save" [ref=f1e7]\n- list "Empty [ref=e99]":\n  - generic',
      { compact: true },
    );
    expect(res.snapshot).toBe('- list "Menu":\n  - button "Save" [ref=f1e7]');
  });

  it("does not treat hostile ref-like page text as a returned ref", () => {
    const result = finalize({
      snapshot:
        '- button "Visible \\" [ref=e2]" [ref=e1]\n- button: attacker [ref=e2]\n\nLinks:\n1. [ref=e3] -> https://example.com/',
      refs: { ...visible.refs, e2: { role: "button" }, e3: { role: "link" } },
    });

    expect(result.refs).toEqual({ e1: { role: "button" } });
  });

  it("preserves MCP refs around Unicode separators", () => {
    const separator = "\u2028";
    for (const field of ["name", "value", "description"] as const) {
      const name = field === "name" ? `Edit${separator}item` : "Edit item";
      const suffix = field === "name" ? "" : ` ${field}="first${separator}second"`;
      const result = finalize({
        snapshot: `- textbox "${name}" [ref=mcp-ref:session:3]${suffix}`,
        refs: { "mcp-ref:session:3": { role: "textbox", name } },
      });
      expect(result.refs, field).toEqual({ "mcp-ref:session:3": { role: "textbox", name } });
    }
  });

  it("bounds budgets smaller than a snapshot line", () => {
    expect(finalize({ ...visible, maxChars: 1 })).toEqual({
      snapshot: "…",
      truncated: true,
      refs: {},
      stats: { lines: 1, chars: 1, refs: 0, interactive: 0 },
    });
  });

  it("treats sub-unit internal budgets as uncapped", () => {
    const result = finalize({ ...visible, maxChars: 0.5 });
    expect(result.snapshot).toBe(visible.snapshot);
    expect(result.truncated).toBeUndefined();
  });

  it("does not mark remembered role identities when refs change", () => {
    const button = { role: "button", name: "Save" };
    const snapshot = '- button "Save" [ref=e7]';
    expect(
      finalize({
        snapshot,
        refs: { e7: button },
        delta: { mode: "role", previousKeys: identityKeys({ e1: button }, "role") },
      }).snapshot,
    ).toBe(snapshot);
  });

  it("parses role refs", () => {
    expect(parseRoleRef("e12")).toBe("e12");
    expect(parseRoleRef("@e12")).toBe("e12");
    expect(parseRoleRef("ref=e12")).toBe("e12");
    expect(parseRoleRef("12")).toBe("12");
    expect(parseRoleRef("")).toBeNull();
  });
});
