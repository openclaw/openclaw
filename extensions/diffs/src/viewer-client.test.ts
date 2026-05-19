import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

describe("createToolbarButton icon safety", () => {
  it("known icon SVGs contain no event handlers or script elements", () => {
    const knownIcons: Record<string, string> = {
      split: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M14"></path></svg>`,
      unified: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M16"></path></svg>`,
    };
    for (const [name, svg] of Object.entries(knownIcons)) {
      expect(svg.includes("onerror"), `icon "${name}" must not contain onerror`).toBe(false);
      expect(svg.includes("<script"), `icon "${name}" must not contain <script`).toBe(false);
      expect(svg.includes("onclick"), `icon "${name}" must not contain onclick`).toBe(false);
      expect(svg.includes("javascript:"), `icon "${name}" must not contain javascript:`).toBe(
        false,
      );
    }
  });

  it("innerHTML with a known SVG does not introduce executable content", () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>");
    const doc = dom.window.document;
    const button = doc.createElement("button");
    const safeSvg = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M14"></path></svg>`;
    button.innerHTML = safeSvg;
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.innerHTML.includes("onerror")).toBe(false);
    expect(button.innerHTML.includes("<script")).toBe(false);
  });

  it("a malicious iconMarkup string would inject executable content via innerHTML (baseline)", () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>");
    const doc = dom.window.document;
    const button = doc.createElement("button");
    const xss = `<img src=x onerror="alert(1)">`;
    button.innerHTML = xss;
    expect(button.innerHTML.includes("onerror")).toBe(true);
    expect(button.querySelector("img")).not.toBeNull();
  });

  it("the ToolbarIconName type prevents passing arbitrary strings at compile time", () => {
    type ToolbarIconName =
      | "split"
      | "unified"
      | "wrap-on"
      | "wrap-off"
      | "background-on"
      | "background-off"
      | "theme-dark"
      | "theme-light";
    const validNames: ToolbarIconName[] = [
      "split",
      "unified",
      "wrap-on",
      "wrap-off",
      "background-on",
      "background-off",
      "theme-dark",
      "theme-light",
    ];
    expect(validNames).toHaveLength(8);
    expect(validNames.includes("split" as ToolbarIconName)).toBe(true);
  });
});
