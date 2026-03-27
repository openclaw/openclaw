import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MINIMAX_DEFAULT_MODEL_ID,
  MINIMAX_DEFAULT_MODEL_REF,
  MINIMAX_TEXT_MODEL_REFS,
} from "../plugins/provider-model-minimax.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const testingDoc = fs.readFileSync(path.join(repoRoot, "docs/help/testing.md"), "utf8");
const faqDoc = fs.readFileSync(path.join(repoRoot, "docs/help/faq.md"), "utf8");
const minimaxDoc = fs.readFileSync(path.join(repoRoot, "docs/providers/minimax.md"), "utf8");

describe("MiniMax docs sync", () => {
  it("keeps the live-testing guide on the current MiniMax default", () => {
    expect(testingDoc).toContain("MiniMax M2.7");
    expect(testingDoc).toContain(MINIMAX_DEFAULT_MODEL_REF);
  });

  it("keeps the FAQ troubleshooting model ids aligned", () => {
    expect(faqDoc).toContain(`Unknown model: ${MINIMAX_DEFAULT_MODEL_REF}`);
    for (const modelRef of MINIMAX_TEXT_MODEL_REFS.slice(3)) {
      expect(faqDoc).toContain(modelRef);
    }
  });

  it("keeps the provider doc aligned with shared MiniMax ids", () => {
    expect(minimaxDoc).toContain(MINIMAX_DEFAULT_MODEL_ID);
    expect(minimaxDoc).toContain(MINIMAX_DEFAULT_MODEL_REF);
    for (const modelRef of MINIMAX_TEXT_MODEL_REFS.slice(3)) {
      expect(minimaxDoc).toContain(modelRef);
    }
    expect(minimaxDoc).not.toContain("(unreleased at the time of writing)");
  });
});
