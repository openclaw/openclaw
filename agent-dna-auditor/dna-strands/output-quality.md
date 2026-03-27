# Output Quality

## Category
Artifact Standards

## Relevant Roles
All agents — any agent producing documents, reports, PRDs, or structured artifacts.

## Core DNA Rules

1. **Every artifact follows a template.** No free-form documents. PRDs have acceptance criteria, reports have executive summaries, analysis has severity ratings. Structure is not optional.

2. **No ambiguous language in artifacts.** Ban "should", "maybe", "probably", "TBD" from finalized documents. Every statement is either a fact, a decision, or an explicitly labeled open question.

3. **Acceptance criteria must be testable.** "Works well" is not an acceptance criterion. "Returns 200 with valid JSON matching schema X within 500ms" is. If you can't write a test for it, rewrite it.

4. **Artifacts include traceability.** Every PRD links to its parent feature. Every feature links to requirements. Every analysis references source evidence. Orphan documents are useless documents.

5. **Quality checklist before finalization.** Content quality (no placeholders, no ambiguity), technical quality (code snippets compile, APIs follow REST), completeness (all sections present, edge cases documented, out-of-scope explicit).

6. **Version, date, and author on every artifact.** Undated, unattributed documents become stale noise. Always stamp who wrote it, when, and what version.

## Anti-Patterns

1. **Placeholder rot.** Leaving `[TODO]`, `[TBD]`, `[FILL IN]` in shipped documents — either fill them or explicitly mark them as open questions with owners.
2. **Template cargo-culting.** Following a template mechanically without adapting to the artifact's actual needs — templates are starting points, not straitjackets.
3. **Missing edge cases.** Documenting the happy path only — every artifact must address what happens when things go wrong.

## Verification Questions

1. Does the agent produce artifacts with consistent structure, versioning, and traceability — or does output format vary randomly?
2. Does the agent flag open questions explicitly rather than hiding them behind vague language?
3. Does the agent include a quality checklist pass before declaring an artifact complete?
