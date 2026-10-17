import { html, parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";

// Geometry from blobster-creator-v2 / OpenClaw, MIT © 2026 OpenClaw Foundation.
// The complete upstream notice is retained with the reference fixtures.
const LICENSE = `MIT License

Copyright (c) 2026 OpenClaw Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const BODY =
  "M60 8 C32 8 16 32 16 52 C16 72 30 90 44 95 L44 104 L54 104 L54 96 C58 97.5 62 97.5 66 96 L66 104 L76 104 L76 95 C90 90 104 72 104 52 C104 32 88 8 60 8 Z";
const LEFT = "M20 42 C5 37 0 47 5 57 C10 67 20 62 25 52 C28 45 25 42 20 42 Z";
const RIGHT = "M100 42 C115 37 120 47 115 57 C110 67 100 62 95 52 C92 45 95 42 100 42 Z";
const LAYERS = ["back", "left_prop", "right_prop", "shell_overlay", "accessory"] as const;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const color = z.string().regex(COLOR);
const fragment = z.string().max(12_000);

export const blobsterDesignSchema = z.strictObject({
  version: z.literal(1),
  id: z
    .string()
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(1_000),
  palette: z.strictObject({ shell: color, claw: color, glint: color }),
  layers: z.strictObject({
    back: fragment,
    left_prop: fragment,
    right_prop: fragment,
    shell_overlay: fragment,
    accessory: fragment,
  }),
});

const TAGS = new Set(["g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
const NUMBER = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g;
const NUMBER_VALUE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const NUMERIC_ATTRIBUTES = new Set([
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "stroke-width",
  "stroke-miterlimit",
  "stroke-dashoffset",
]);
const ENUM_ATTRIBUTES: Record<string, readonly string[]> = {
  "stroke-linecap": ["butt", "round", "square"],
  "stroke-linejoin": ["miter", "round", "bevel"],
  "fill-rule": ["nonzero", "evenodd"],
  "clip-rule": ["nonzero", "evenodd"],
};

function escapeXml(value: string) {
  // Iteration keeps surrogate pairs together; single-unit surrogates are invalid XML.
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (character.length === 1 && code >= 0xd800 && code <= 0xdfff) ||
      code === 0xfffe ||
      code === 0xffff
    ) {
      throw new Error("Invalid XML text");
    }
  }
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function validAttribute(name: string, value: string) {
  if (name === "fill" || name === "stroke") {
    return value === "none" || COLOR.test(value);
  }
  if (name === "class") {
    return /^[A-Za-z0-9_ -]+$/.test(value);
  }
  if (Object.hasOwn(ENUM_ATTRIBUTES, name)) {
    return ENUM_ATTRIBUTES[name]?.includes(value) === true;
  }
  // Bound all numeric operands, including those inside paths and transforms.
  const numbers = value.match(NUMBER) ?? [];
  if (
    numbers.some((number) => !Number.isFinite(Number(number)) || Math.abs(Number(number)) > 2_000)
  ) {
    return false;
  }
  if (NUMERIC_ATTRIBUTES.has(name)) {
    return NUMBER_VALUE.test(value);
  }
  if (["opacity", "fill-opacity", "stroke-opacity"].includes(name)) {
    return NUMBER_VALUE.test(value) && Number(value) >= 0 && Number(value) <= 1;
  }
  if (name === "d") {
    return numbers.length > 0 && /^[MmZzLlHhVvCcSsQqTtAa\s,]*$/.test(value.replace(NUMBER, ""));
  }
  if (name === "points" || name === "stroke-dasharray") {
    return value === "none" || (numbers.length > 0 && /^[\s,]*$/.test(value.replace(NUMBER, "")));
  }
  if (name === "transform") {
    return /^(?:(?:translate|scale|rotate)\([\s,0-9eE.+-]+\)\s*)+$/.test(value);
  }
  return false;
}

function renderFragment(source: string): string {
  if (source.includes("<!") || source.includes("<?")) {
    throw new Error("SVG declarations are not allowed");
  }
  const parsed = parseFragment(`<svg xmlns="http://www.w3.org/2000/svg">${source}</svg>`, {
    onParseError: () => {
      throw new Error("Invalid SVG fragment");
    },
  });
  const root = parsed.childNodes[0];
  if (parsed.childNodes.length !== 1 || !root || !("tagName" in root) || root.tagName !== "svg") {
    throw new Error("Invalid SVG fragment");
  }
  let count = 0;
  const render = (node: DefaultTreeAdapterMap["childNode"], depth: number): string => {
    if (node.nodeName === "#text" && "value" in node && !node.value.trim()) {
      return "";
    }
    if (!("tagName" in node) || node.namespaceURI !== html.NS.SVG || !TAGS.has(node.tagName)) {
      throw new Error("Unsupported SVG element");
    }
    if (++count > 128 || depth > 12) {
      throw new Error("SVG fragment is too complex");
    }
    const attrs = node.attrs
      .map(({ name, value, namespace, prefix }) => {
        if (namespace || prefix || !validAttribute(name, value)) {
          throw new Error(`Unsupported SVG attribute: ${name}`);
        }
        return ` ${name}="${escapeXml(value)}"`;
      })
      .join("");
    // Never return model markup directly: reconstruct only validated shapes.
    return `<${node.tagName}${attrs}>${node.childNodes.map((child) => render(child, depth + 1)).join("")}</${node.tagName}>`;
  };
  return root.childNodes.map((node) => render(node, 0)).join("");
}

export function renderBlobster(input: unknown): { name: string; description: string; svg: string } {
  const design = blobsterDesignSchema.parse(input);
  const layers = Object.fromEntries(LAYERS.map((key) => [key, renderFragment(design.layers[key])]));
  const { shell, claw, glint } = design.palette;
  // Fixed clipping keeps weak model output from turning the tiny avatar into a square.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="-12 -18 144 144" role="img">
<metadata>${escapeXml(LICENSE)}</metadata>
<title>${escapeXml(design.name)}</title><desc>${escapeXml(design.description)}</desc>
<defs><clipPath id="blobster-body-clip"><path d="${BODY}"/></clipPath></defs>
<g stroke="${shell}" stroke-width="4" stroke-linecap="round" fill="none"><path d="M46 14 Q38 4 31 7"/><path d="M74 14 Q82 4 89 7"/></g>
<g>${layers.left_prop}<path d="${LEFT}" fill="${claw}"/></g>
<g>${layers.right_prop}<path d="${RIGHT}" fill="${claw}"/></g>
<path d="${BODY}" fill="${shell}"/>
<g clip-path="url(#blobster-body-clip)">${layers.shell_overlay}</g>
<ellipse cx="48" cy="28" rx="20" ry="11" fill="#ffffff" opacity="0.1"/>
<g>${layers.accessory}</g>
<g><circle cx="45" cy="32" r="5.5" fill="#0a1014"/><circle cx="75" cy="32" r="5.5" fill="#0a1014"/><circle cx="46.5" cy="30.5" r="2.2" fill="${glint}"/><circle cx="76.5" cy="30.5" r="2.2" fill="${glint}"/></g>
</svg>`;
  return { name: design.name, description: design.description, svg };
}
