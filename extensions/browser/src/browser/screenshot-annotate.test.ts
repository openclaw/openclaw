import { expect, it } from "vitest";
import {
  type AnnotationItem,
  buildOverlayClearScript,
  buildOverlayInjectionScript,
  planAnnotations,
  type RawAnnotationInput,
  scaleAnnotations,
} from "./screenshot-annotate.js";

const sampleInputs: RawAnnotationInput[] = [
  { ref: "e1", role: "button", name: "Submit", doc: { x: 100, y: 200, width: 50, height: 20 } },
  { ref: "e2", role: "link", doc: { x: 300, y: 1500, width: 80, height: 18 } },
];

it("subtracts scroll from doc coords", () => {
  const plan = planAnnotations({
    inputs: sampleInputs,
    space: "viewport",
    scroll: { x: 0, y: 1000 },
  });

  expect(plan.annotations).toEqual([
    {
      ref: "e1",
      number: 1,
      role: "button",
      name: "Submit",
      box: { x: 100, y: -800, width: 50, height: 20 },
    },
    { ref: "e2", number: 2, role: "link", box: { x: 300, y: 500, width: 80, height: 18 } },
  ]);
  expect(plan.overlayItems).toEqual([
    { ref: "e1", x: 100, y: 200, w: 50, h: 20 },
    { ref: "e2", x: 300, y: 1500, w: 80, h: 18 },
  ]);
  expect(plan.skipped).toBe(0);
});

it("throws when scroll missing in viewport mode", () => {
  expect(() => planAnnotations({ inputs: sampleInputs, space: "viewport" })).toThrow(/scroll/);
});
it("throws when elementRect missing", () => {
  expect(() => planAnnotations({ inputs: [], space: "element" })).toThrow(/elementRect/);
});

it("caps drawn annotations at 150", () => {
  const inputs = Array.from({ length: 200 }, (_, i) => ({
    ref: `e${i + 1}`,
    role: "button",
    doc: { x: 0, y: i, width: 5, height: 5 },
  }));
  const plan = planAnnotations({ inputs, space: "fullpage" });
  expect(plan.annotations).toHaveLength(150);
  expect(plan.skipped).toBe(50);
});
it("rounds coordinates to integers", () => {
  const script = buildOverlayInjectionScript({
    items: [{ ref: "e1", x: 100.7, y: 200.4, w: 50.6, h: 20.1 }],
  });
  expect(script).toMatch(/"x":\s*101/);
  expect(script).toMatch(/"y":\s*200/);
});

it("escapes hostile ref characters via JSON.stringify (no breakout)", () => {
  const hostile = 'e1");alert(1);//';
  const script = buildOverlayInjectionScript({
    items: [{ ref: hostile, x: 0, y: 0, w: 1, h: 1 }],
  });
  expect(script).toContain('"e1\\");alert(1);//"');
  expect(script).not.toContain('e1");alert(1);');
});

it("uses capture-relative y when deciding whether to flip labels below boxes", () => {
  const script = buildOverlayInjectionScript({
    items: [{ ref: "e1", x: 0, y: 1005, w: 10, h: 10 }],
    captureY: 1000,
  });

  expect(script).toContain("var captureY = 1000;");
  expect(script).toContain("var relativeY = it.y - captureY;");
  expect(script).toContain("relativeY < 14 ? (it.y + 2) : (it.y - 14)");
});
it("returns an IIFE selecting overlay attr", () => {
  const script = buildOverlayClearScript();
  expect(script).toContain("[data-openclaw-labels]");
  expect(script).toMatch(/^\(\s*\(\s*\)\s*=>\s*\{/);
});
const sample: AnnotationItem[] = [
  {
    ref: "e1",
    number: 1,
    role: "button",
    name: "Submit",
    box: { x: 100, y: 200, width: 50, height: 20 },
  },
];

it.each([
  [1, 1, { x: 100, y: 200, width: 50, height: 20 }],
  [0.5, 0.485, { x: 50, y: 97, width: 25, height: 10 }],
] as const)("scales annotations by %s/%s", (scaleX, scaleY, box) => {
  expect(scaleAnnotations(sample, scaleX, scaleY)).toEqual([{ ...sample[0], box }]);
});
