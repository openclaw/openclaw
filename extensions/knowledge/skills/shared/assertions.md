# Claims and relationships

Use structured records for independently useful, sourced assertions, not every
sentence. The page stays the readable synthesis.

## Create

- `knowledge_create_claim`: title, body, `claim_kind`, `assertion_origin`
  (`source`, `user_belief`, `agent_inference`), attribution and retained
  `evidence`.
- `knowledge_create_relationship`: `from`/`to` page IDs, a declared ontology
  label (check direction in the definition), title, body, attribution, evidence.
- Both need a fresh `requestId`, `expectedVaultId` and
  `expectedOntologyFingerprint`. Reuse existing evidence with verified locators.

| Source meaning              | Representation                                                        |
| --------------------------- | --------------------------------------------------------------------- |
| Material fact               | `fact`, origin `source`, attribution names the source                 |
| Explicit decision           | `decision`; keep conditions and decision maker                        |
| Explicit commitment         | `commitment`; `owner` page ID and `due_at` only when supported        |
| Dated event                 | `event`; `occurred_at` at source precision; all relevant `entities`   |
| Stated belief or preference | `belief`/`preference`; `user_belief` for the user's own view          |
| Your analysis worth keeping | origin `agent_inference`; evidence supports premises, not a quotation |

- One correctable assertion per claim. The speaker goes in attribution, including
  unresolved labels like "Speaker 2".
- **Holder is not subject.** The holder is whoever said or clearly implied it.
  "Alice has a rescuer pattern" said by nobody is your analysis
  (`agent_inference`), not Alice's belief.
- A founder or employee speaking about their company is the holder, not the
  company. Self-report is a strong individual signal, not verified fact.
  Sharing or amplifying something is not endorsing every clause of it.
- Skip trivia (handles, follower counts, obvious bio fields). A claim should
  matter for some future question.
- Proposals, jokes and provisional targets are not decisions or commitments.
- Omit unknown owners and dates. A relative date needs a known source date and
  timezone. Date-only stays date-only; it is not midnight.
- `valid_from`, `valid_until`, `expires_at` take UTC timestamps.
- Creating a commitment schedules nothing.

## Structure

- Publish the source page and entity pages first.
- `dependencies`: the source page ID, plus a claim the assertion truly relies on.
  Not every prose mention. Inactive dependencies hide dependents.
- `entities`: resolved relevant pages. Not an endorsement.
- `source_page`: the source page ID on extracted claims and edges. A page never
  names itself.
- `source_event: true` only on the one event claim that is the meeting or source
  itself.
- `attribution_confidence: {level, basis, evidence}` is speaker-attribution
  confidence, not a truth score.

## Before creating: reuse or reconcile

Inspect the source page's `dependents` and relevant entities' `claims`,
`incoming` and `outgoing` connections. Compare meaning, speaker, qualifiers,
dates, entities and evidence; for relationships also endpoints and label.

- Same assertion, same source: reuse the ID.
- Same assertion, new support: append evidence with `knowledge_annotate`.
- Reaffirmation, updated plan or contrary account: create a new claim with
  `continuity: [{id, relation: "reaffirms" | "updates" | "contradicts", basis,
  evidence}]`. This does not supersede the earlier claim.
- Explicit correction: `knowledge_correct` via the `knowledge-correct` skill.
- Never resurrect a withdrawn or superseded assertion on reimport. Check
  `historical: true` connections before inferring absence.

`knowledge_annotate` updates contextual metadata or adds evidence on an unchanged
assertion. It needs a fresh request ID, vault, ID, revision, hash and reason.
Supplied arrays replace; omitted fields persist. It cannot change text or
lifecycle.

## Example

```json
{
  "requestId": "<new UUID>",
  "expectedVaultId": "<vault UUID>",
  "expectedOntologyFingerprint": "<fingerprint>",
  "title": "Send reliability report",
  "body": "Speaker 2 offered to send the report on Friday; their identity is unresolved.",
  "claim_kind": "commitment",
  "assertion_origin": "source",
  "attribution": "Speaker 2, retained transcript line 5",
  "dependencies": ["<meeting page ID>"],
  "evidence": [{ "path": "<artifact path>", "sha256": "<hash>", "start_line": 5, "end_line": 5 }]
}
```

No `owner` (speaker unresolved) and no `due_at` ("Friday" without date context).
