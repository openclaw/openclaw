// Regression tests for the dreaming contamination boundary (Phase 7).
// The predicate targets corruption shapes, never bare tokens such as
// "ID", "timestamp", "Session", or "Assistant".
import { describe, expect, it } from "vitest";
import {
  containsRawSessionMetadataBlock,
  isContaminatedDreamingSnippet,
} from "./short-term-promotion-utils.js";

describe("dreaming contamination predicate", () => {
  it.each([
    // Session Key + Session ID co-occurrence in one snippet (pre-existing).
    "Session Key: agent:main:main Session ID: 4b6b1fc5-1ea9-47fb-9223-8eef7e4ed57a",
    // Existing prompt-line contamination.
    "[memory/.dreams/dreaming-narrative] Assistant: Write a dream diary entry from these memory fragments:",
    // Existing promotion score metadata.
    "- moved backups [score=0.950 signals=3 recalls=3 avg=0.900 source=memory/2026-09-13.md:10-12]",
    // Existing flush-prompt contamination.
    "Save important context from this session to the daily memory file. STRICT RULES: keep it short",
    // Existing transcript-turn shape outside the session corpus.
    "user: do the thing",
    // Conversation summary wrapping a raw transcript turn (PR #94636 shape).
    "Conversation Summary: assistant: Traced all three. No changes made.",
    // Conversation summary wrapping session metadata.
    "Conversation Summary: Session Key: agent:main:main Session ID: abc123",
    // Conversation summary wrapping a flush prompt.
    "Conversation Summary: Save important context from this session to the daily memory file. STRICT RULES: keep it short",
    // Bare summary header with no content.
    "Conversation Summary:",
  ])("rejects known contamination: %s", (snippet) => {
    expect(isContaminatedDreamingSnippet(snippet)).toBe(true);
  });

  it.each([
    // Legitimate migration fact containing an ID.
    "session abc123 was migrated to the new host",
    // Legitimate deployment event containing a timestamp.
    "09:14 deployment started on router vlan 20",
    // Legitimate configuration-change statement.
    "Gateway now binds port 19999 after the control plane migration",
    // Ordinary user statement with operational terminology.
    "the assistant restarted the gateway twice today",
    // Phase 6 example: operational notice with a real embedded fact.
    "Gateway restart config-patch ok; run openclaw doctor --non-interactive",
    // Conversation summary with an ordinary prose remainder: the chunker
    // prepends the active heading, so this is a legitimate bullet that
    // happens to sit under a summary heading.
    "Conversation Summary: Router VLAN 20 carries lab traffic across the workshop switch.",
    "Conversation Summary: we talked about routers",
  ])("preserves legitimate content: %s", (snippet) => {
    expect(isContaminatedDreamingSnippet(snippet)).toBe(false);
    expect(containsRawSessionMetadataBlock(snippet)).toBe(false);
  });

  it("detects the session-metadata block across adjacent chunk lines", () => {
    const window = [
      "# Session: 2026-09-13 08:34:31 America/Sao_Paulo",
      "- **Session Key**: agent:main:main",
      "- **Session ID**: 4b6b1fc5-1ea9-47fb-9223-8eef7e4ed57a",
      "- **Source**: webchat",
    ].join("\n");
    // Neither fragment alone matches the single-snippet predicate: this is
    // the granularity evasion the window check closes.
    expect(isContaminatedDreamingSnippet("- **Session Key**: agent:main:main")).toBe(false);
    expect(containsRawSessionMetadataBlock(window)).toBe(true);
  });

  it("does not match bare identifiers, timestamps, or nearby legitimate lines", () => {
    expect(containsRawSessionMetadataBlock("session abc123 was migrated")).toBe(false);
    expect(containsRawSessionMetadataBlock("09:14 deployment started")).toBe(false);
    expect(
      containsRawSessionMetadataBlock(
        ["## Notes", "", "Router VLAN 20 carries lab traffic across the workshop switch."].join(
          "\n",
        ),
      ),
    ).toBe(false);
  });

  it("matches Key/ID co-occurrence within the block span only", () => {
    const near = `Session Key: a ${"x".repeat(100)} Session ID: b`;
    const far = `Session Key: a ${"x".repeat(700)} Session ID: b`;
    expect(containsRawSessionMetadataBlock(near)).toBe(true);
    expect(containsRawSessionMetadataBlock(far)).toBe(false);
    // A lone label without its counterpart is not a metadata block.
    expect(containsRawSessionMetadataBlock("Session Key: agent:main:main")).toBe(false);
    expect(containsRawSessionMetadataBlock("Session ID: abc123")).toBe(false);
  });

  it("treats summary-wrapped raw shapes as contamination", () => {
    expect(
      isContaminatedDreamingSnippet(
        "Conversation Summary: user: Save important context. STRICT RULES: 1. be brief",
      ),
    ).toBe(true);
    expect(
      isContaminatedDreamingSnippet(
        "Conversation Summary: moved notes [score=0.950 recalls=3 avg=0.900 source=memory/2026-09-13.md:1-2]",
      ),
    ).toBe(true);
  });
});
