# HO-2417: Exclude Immutable Bridge Sources from Stale-Page Lint

## Problem

The memory-wiki bridge imports historical public memory artifacts as source
pages. Their source timestamps are intentionally preserved. The stale-page
lint rule currently treats these immutable source records as ordinary pages and
emits warnings even when bridge synchronization confirms that no source changed.

## User Story

As a wiki maintainer, I need lint to distinguish immutable bridge evidence from
knowledge that needs freshness review so that a clean bridge import does not
produce false-positive stale-page warnings.

## Functional Requirements

- Only source pages currently registered in source-sync state with group
  `bridge` are excluded from the `stale-page` lint rule.
- A tracked `unsafe-local` source remains subject to stale-page lint.
- An ordinary stale entity or source remains subject to stale-page lint.
- Existing structure, provenance, link, contradiction, open-question, and
  claim-health checks remain unchanged.
- The change must not rewrite or refresh imported source timestamps.

## Acceptance Criteria

1. A stale bridge-tracked source produces no `stale-page` issue.
2. A stale unsafe-local tracked source still produces `stale-page`.
3. A stale ordinary entity still produces `stale-page`.
4. Focused memory-wiki tests and extension typechecks pass.

## Scope

In scope: `extensions/memory-wiki/src/lint.ts` and its regression tests.

Out of scope: repairing claim-level evidence, reviewing genuinely stale entity
pages, resolving open questions, or changing source timestamps.
