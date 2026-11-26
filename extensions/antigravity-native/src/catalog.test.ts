import { expect, it } from "vitest";
import { decodeAgyCatalog } from "./catalog.js";

const envelope = (models: unknown[]) =>
  JSON.stringify({ command: { name: "models", data: { models } } });
const row = { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" };

it("preserves exact native IDs and an authoritative empty result", () => {
  expect(decodeAgyCatalog(envelope([row]))).toEqual([row]);
  expect(decodeAgyCatalog(envelope([]))).toEqual([]);
});

it.each([
  "private diagnostic bytes",
  JSON.stringify({ models: [row] }),
  envelope([row, { ...row, label: "Ambiguous duplicate" }]),
  envelope([{ ...row, id: "../not-a-model" }]),
  envelope([{ ...row, label: "inline\ncontrol" }]),
])("does not turn malformed or ambiguous native output into a catalog", (input) => {
  expect(() => decodeAgyCatalog(input)).toThrow(/^Antigravity /u);
});
