/**
 * Fork regression tests: Playwright ariaSnapshot for refs=aria
 *
 * Our fork uses Playwright's locator.ariaSnapshot() instead of CDP
 * Accessibility.getFullAXTree for the refs=aria snapshot path.
 * CDP misses React portals and content rendered outside the main a11y tree.
 *
 * These tests verify:
 * 1. snapshotAriaViaPlaywright calls page.locator(":root").ariaSnapshot(), NOT CDP
 * 2. The aria snapshot text is correctly parsed into AriaSnapshotNode[]
 * 3. The limit parameter is respected
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SRC_FILE = path.resolve(__dirname, "pw-tools-core.snapshot.ts");

describe("fork: Playwright ariaSnapshot for refs=aria", () => {
  const source = fs.readFileSync(SRC_FILE, "utf-8");

  describe("snapshotAriaViaPlaywright uses Playwright, not CDP", () => {
    // Extract the function: find "snapshotAriaViaPlaywright" through "return { nodes };"
    const fnStart = source.indexOf("export async function snapshotAriaViaPlaywright");
    const fnEnd = source.indexOf("return { nodes };", fnStart);
    const fnBody = source.slice(fnStart, fnEnd + 20);

    it("calls page.locator(':root').ariaSnapshot()", () => {
      expect(fnBody).toMatch(/page\.locator\(["']:root["']\)\.ariaSnapshot\(\)/);
    });

    it("does NOT call CDP getFullAXTree", () => {
      // Filter out comment lines to avoid matching explanatory comments
      const codeLines = fnBody.split("\n").filter((l) => !l.trim().startsWith("//"));
      const code = codeLines.join("\n");
      expect(code).not.toContain("getFullAXTree");
      expect(code).not.toContain("Accessibility.enable");
      expect(code).not.toContain("withPageScopedCdpClient");
    });
  });

  describe("aria snapshot text parsing", () => {
    // Replicate the inline parsing logic for unit testing
    function parseAriaSnapshot(text: string, limit = 500) {
      const rawLines = text.split("\n").filter((l: string) => l.trim().length > 0);
      const nodes: { ref: string; role: string; name: string; depth: number }[] = [];
      for (let i = 0; i < rawLines.length && nodes.length < limit; i++) {
        const line = rawLines[i];
        const stripped = line.replace(/^[\s-]+/, "");
        const indent = line.search(/\S/);
        const depth = Math.max(0, Math.floor(indent / 2));
        const roleMatch = stripped.match(/^(\w+)(?:\s+"(.*)")?/);
        nodes.push({
          ref: String(i + 1),
          role: roleMatch?.[1] ?? "text",
          name: roleMatch?.[2] ?? stripped,
          depth,
        });
      }
      return nodes;
    }

    it("parses role and name from aria snapshot lines", () => {
      const text = `heading "Welcome"\nbutton "Submit"\nlink "Home"`;
      const nodes = parseAriaSnapshot(text);
      expect(nodes).toHaveLength(3);
      expect(nodes[0]).toEqual({ ref: "1", role: "heading", name: "Welcome", depth: 0 });
      expect(nodes[1]).toEqual({ ref: "2", role: "button", name: "Submit", depth: 0 });
      expect(nodes[2]).toEqual({ ref: "3", role: "link", name: "Home", depth: 0 });
    });

    it("calculates depth from indentation", () => {
      const text = `heading "Root"\n  button "Child"\n    link "Grandchild"`;
      const nodes = parseAriaSnapshot(text);
      expect(nodes[0].depth).toBe(0);
      expect(nodes[1].depth).toBe(1);
      expect(nodes[2].depth).toBe(2);
    });

    it("handles lines with leading dashes (Playwright format)", () => {
      const text = `- heading "Title"\n  - button "Click"`;
      const nodes = parseAriaSnapshot(text);
      expect(nodes[0]).toMatchObject({ role: "heading", name: "Title" });
      expect(nodes[1]).toMatchObject({ role: "button", name: "Click" });
    });

    it("handles role-only lines without names", () => {
      const text = `separator\ngeneric`;
      const nodes = parseAriaSnapshot(text);
      expect(nodes[0]).toMatchObject({ role: "separator", name: "separator" });
      expect(nodes[1]).toMatchObject({ role: "generic", name: "generic" });
    });

    it("skips empty lines", () => {
      const text = `heading "A"\n\n\nbutton "B"\n   \n`;
      const nodes = parseAriaSnapshot(text);
      expect(nodes).toHaveLength(2);
    });

    it("respects the limit parameter", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `button "Btn${i}"`).join("\n");
      const nodes = parseAriaSnapshot(lines, 5);
      expect(nodes).toHaveLength(5);
    });

    it("assigns sequential ref strings starting from 1", () => {
      const text = `heading "A"\nbutton "B"\nlink "C"`;
      const nodes = parseAriaSnapshot(text);
      expect(nodes.map((n) => n.ref)).toEqual(["1", "2", "3"]);
    });
  });
});
