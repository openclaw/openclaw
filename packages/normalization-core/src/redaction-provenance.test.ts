import { describe, expect, it } from "vitest";
import {
  REDACTION_PROVENANCE_END,
  REDACTION_PROVENANCE_ESCAPE,
  REDACTION_PROVENANCE_START,
  escapeRedactionProvenanceLiterals,
  hasRedactionProvenance,
  isRedactionProvenanceMask,
  markRedactionProvenance,
  replaceRedactionProvenance,
  stripRedactionProvenance,
} from "./redaction-provenance.js";

const PLACEHOLDER = "[redacted: re-derive this value, do not reuse]";

describe("redaction provenance markers", () => {
  it("marks a produced mask with both boundaries", () => {
    expect(markRedactionProvenance("sk-abc…0xyz")).toBe(
      `${REDACTION_PROVENANCE_START}sk-abc…0xyz${REDACTION_PROVENANCE_END}`,
    );
  });

  it("does not double-wrap an already marked mask", () => {
    const marked = markRedactionProvenance("***");
    expect(markRedactionProvenance(marked)).toBe(marked);
  });

  it("returns the input reference when no marker is present", () => {
    const text = "the file is here…world of pain";
    expect(replaceRedactionProvenance(text, PLACEHOLDER)).toBe(text);
    expect(hasRedactionProvenance(text)).toBe(false);
  });

  it("keeps surrounding text byte-identical around a marked span", () => {
    expect(
      replaceRedactionProvenance(
        `value=${markRedactionProvenance("sk-bug…9f3a")} and trailing`,
        PLACEHOLDER,
      ),
    ).toBe(`value=${PLACEHOLDER} and trailing`);
  });

  it("rewrites several marked spans in one string", () => {
    expect(
      replaceRedactionProvenance(
        `a=${markRedactionProvenance("***")} b=${markRedactionProvenance("nested…t123")}`,
        PLACEHOLDER,
      ),
    ).toBe(`a=${PLACEHOLDER} b=${PLACEHOLDER}`);
  });

  it("leaves an unterminated opener verbatim", () => {
    const text = `keep ${REDACTION_PROVENANCE_START}sk-abc no closing marker`;
    expect(replaceRedactionProvenance(text, PLACEHOLDER)).toBe(text);
  });

  it("leaves literal markdown and ellipsis text untouched", () => {
    const text = "***\nfix ***bold italic*** now\nthe file is here…world of pain";
    expect(replaceRedactionProvenance(text, PLACEHOLDER)).toBe(text);
  });
});

describe("redaction provenance is unambiguous against literal text", () => {
  it("leaves the pre-versioning delimiter text alone", () => {
    const literal = "value=⟦openclaw:redacted⟧example⟦/openclaw:redacted⟧ end";
    expect(replaceRedactionProvenance(literal, PLACEHOLDER)).toBe(literal);
  });

  it("does not read delimiter text with a non-mask body as provenance", () => {
    const literal = `${REDACTION_PROVENANCE_START}example${REDACTION_PROVENANCE_END}`;
    expect(isRedactionProvenanceMask(literal)).toBe(false);
    expect(replaceRedactionProvenance(literal, PLACEHOLDER)).toBe(literal);
  });

  it("leaves mark-free literal delimiter text byte-identical (no genuine mark, no rewrite)", () => {
    // Non-mask bodies are never genuine marks (#142821): with no genuine mark present
    // the string is raw/legacy history and must round-trip byte-identical (#142821 review).
    const literal = `keep ${REDACTION_PROVENANCE_START}example${REDACTION_PROVENANCE_END} literal`;
    expect(escapeRedactionProvenanceLiterals(literal)).toBe(literal);
    expect(replaceRedactionProvenance(literal, PLACEHOLDER)).toBe(literal);
    expect(stripRedactionProvenance(literal)).toBe(literal);
  });

  it("escapes literals surrounding a genuine mark and restores them on replay", () => {
    const literal = `keep ${REDACTION_PROVENANCE_ESCAPE}${REDACTION_PROVENANCE_ESCAPE}b`;
    const stored = `${literal} ${markRedactionProvenance("***")}`;
    // Already-escaped literals stay escaped; the genuine mark is preserved.
    expect(escapeRedactionProvenanceLiterals(stored)).toBe(stored);
    expect(replaceRedactionProvenance(stored, PLACEHOLDER)).toBe(
      `keep ${REDACTION_PROVENANCE_ESCAPE}b ${PLACEHOLDER}`,
    );
  });

  it("leaves a produced mask exactly as it is when escaping runs again", () => {
    const marked = `value=${markRedactionProvenance("***")} tail`;
    expect(escapeRedactionProvenanceLiterals(marked)).toBe(marked);
  });

  it("reads one mask as a whole value only when its body is mask-shaped", () => {
    expect(isRedactionProvenanceMask(markRedactionProvenance("***"))).toBe(true);
    expect(isRedactionProvenanceMask(markRedactionProvenance("sk-abc…0xyz"))).toBe(true);
    expect(isRedactionProvenanceMask(`leaked ${markRedactionProvenance("***")}`)).toBe(false);
    expect(isRedactionProvenanceMask(`${markRedactionProvenance("***")} leaked`)).toBe(false);
  });

  it("canonicalizes a marked mask and a bare mask to the same bytes", () => {
    expect(stripRedactionProvenance(markRedactionProvenance("***"))).toBe("***");
    expect(stripRedactionProvenance("***")).toBe("***");
    expect(stripRedactionProvenance(`key=${markRedactionProvenance("sk-abc…0xyz")} done`)).toBe(
      "key=sk-abc…0xyz done",
    );
  });
});
