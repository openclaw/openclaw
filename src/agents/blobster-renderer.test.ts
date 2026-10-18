/* @vitest-environment node */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderBlobster } from "./blobster-renderer.js";

const plain = {
  version: 1,
  id: "garden-keeper",
  name: "Garden Keeper",
  description: "A gardener",
  palette: { shell: "#87b891", claw: "#5b9471", glint: "#fff0b3" },
  layers: { back: "", left_prop: "", right_prop: "", shell_overlay: "", accessory: "" },
};

describe("Blobster renderer", () => {
  const fixtures = new URL("./blobster-fixtures/", import.meta.url);
  for (const filename of readdirSync(fixtures).filter((file) => file.endsWith(".json"))) {
    it(`renders ${filename} through the bounded SVG renderer`, () => {
      const fixture = JSON.parse(readFileSync(new URL(filename, fixtures), "utf8"));
      // The Gateway keeps one square canvas rather than accepting model-controlled bounds.
      const { bounds: _bounds, ...design } = fixture;
      const { svg } = renderBlobster({ ...design, layers: { ...plain.layers, ...design.layers } });
      expect(svg).toContain('width="256" height="256"');
      expect(svg).toContain("Copyright (c) 2026 OpenClaw Foundation");
    });
  }

  it.each([
    "<script>alert(1)</script>",
    '<image href="https://evil.invalid/a.png"/>',
    "<foreignObject><p>Hi</p></foreignObject>",
    '<use href="#body"/>',
    '<path d="M0 0" onload="alert(1)"/>',
    '<path d="M0 0" style="fill:red"/>',
    '<path d="M0 0" fill="url(https://evil.invalid)"/>',
    '<g xmlns="http://evil.invalid"/>',
    "<!--hidden-->",
    '<?xml version="1.0"?>',
    "<!DOCTYPE svg>",
    '<circle cx="1e309"/>',
    '<circle cx="999999999"/>',
    '<path d="M1e309 0"/>',
    '<g transform="translate(1e309 0)"/>',
    '<path opacity="2"/>',
    "<g>text</g>",
    '</svg><svg><path d="M0 0"/>',
    "<g>".repeat(14) + "</g>".repeat(14),
    '<circle r="2"/>'.repeat(129),
    '<circle fill="&#117;rl(evil)"/>',
  ])("rejects active or unbounded SVG: %s", (accessory) => {
    expect(() => renderBlobster({ ...plain, layers: { ...plain.layers, accessory } })).toThrow();
  });

  it("escapes metadata and retains a fixed face and square canvas", () => {
    const { svg } = renderBlobster({ ...plain, name: '<script>&"', description: "A 🦞" });
    expect(svg).toContain("&lt;script&gt;&amp;&quot;");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain('viewBox="-12 -18 144 144"');
    expect(svg).toContain('<circle cx="45" cy="32" r="5.5"');
    expect(() => renderBlobster({ ...plain, name: "\ud800" })).toThrow();
    expect(() =>
      renderBlobster({ ...plain, palette: { ...plain.palette, shell: "red" } }),
    ).toThrow();
    expect(() => renderBlobster({ ...plain, bounds: [0, 0, 1, 1] })).toThrow();
  });

  it("rejects invalid XML characters while retaining whitespace and paired Unicode", () => {
    for (const code of [0x00, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0xd800, 0xdfff, 0xfffe, 0xffff]) {
      expect(() => renderBlobster({ ...plain, name: String.fromCharCode(code) })).toThrow(
        "Invalid XML text",
      );
    }
    const name = "Whitespace\t\n\r and Unicode \ud7ff\ue000\ufffd🦞";
    expect(renderBlobster({ ...plain, name }).svg).toContain(`<title>${name}</title>`);
  });

  it("keeps the Blobster silhouette when a small model draws a full-canvas backdrop and outfit", () => {
    const { svg } = renderBlobster({
      ...plain,
      layers: {
        ...plain.layers,
        back: '<rect x="-12" y="-18" width="144" height="144" fill="#ff0000"/>',
        shell_overlay: '<rect x="16" y="8" width="88" height="96" fill="#0000ff"/>',
      },
    });
    expect(svg).not.toContain("#ff0000");
    expect(svg).toContain('<clipPath id="blobster-body-clip">');
    expect(svg).toContain(
      '<g clip-path="url(#blobster-body-clip)"><rect x="16" y="8" width="88" height="96" fill="#0000ff"></rect></g>',
    );
  });
});
