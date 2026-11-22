import { expect, it } from "vitest";
import {
  type AnnotationItem,
  buildOverlayInjectionScript,
  planAnnotations,
  scaleAnnotations,
} from "./screenshot-annotate.js";

const button = { ref: "e1", role: "button", name: "Submit" };
const buttonBox = { x: 100, y: 200, width: 50, height: 20 };
const sample: AnnotationItem[] = [{ ...button, number: 1, box: buttonBox }];

it("throws when scroll missing in viewport mode", () => {
  expect(() => planAnnotations({ inputs: [], space: "viewport" })).toThrow(/scroll/);
});
it("throws when elementRect missing", () => {
  expect(() => planAnnotations({ inputs: [], space: "element" })).toThrow(/elementRect/);
});

it("caps unfiltered annotations at 150 while projecting from document coordinates", () => {
  const inputs = Array.from({ length: 200 }, (_, i) => ({
    ref: `e${i + 1}`,
    role: "button",
    doc: { x: 0, y: 1000 + i, width: 5, height: 5 },
  }));
  const plan = planAnnotations({ inputs, space: "viewport", scroll: { x: 0, y: 1000 } });
  expect(plan.annotations).toHaveLength(150);
  expect(plan.skipped).toBe(50);
  expect(plan.annotations[0]?.box).toEqual({ x: 0, y: 0, width: 5, height: 5 });
  expect(plan.overlayItems[0]).toEqual({ ref: "e1", x: 0, y: 1000, w: 5, h: 5 });
});
it("serializes rounded coordinates and escaped refs without script breakout", () => {
  const hostile = 'e1");alert(1);//';
  const script = buildOverlayInjectionScript({
    items: [{ ref: hostile, x: 100.7, y: 200.4, w: 50.6, h: 20.1 }],
  });
  expect(script).toMatch(/"x":\s*101/);
  expect(script).toMatch(/"y":\s*200/);
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
it.each([
  [1, 1, { x: 100, y: 200, width: 50, height: 20 }],
  [0.5, 0.485, { x: 50, y: 97, width: 25, height: 10 }],
] as const)("scales annotations by %s/%s", (scaleX, scaleY, box) => {
  expect(scaleAnnotations(sample, scaleX, scaleY)).toEqual([{ ...sample[0], box }]);
});
