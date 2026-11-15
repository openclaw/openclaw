---
name: knowledge-capture
description: Save durable preferences, decisions, project facts, commitments, and lessons cheaply with knowledge_remember, keep the subject page's State current, or save short notes and page updates with attribution and readback. Use for explicit saves or agent-driven remembering when Knowledge is the selected memory provider.
---

# Capture durable knowledge

When Knowledge is the selected memory provider, its ordinary-turn remembering
policy also authorizes selective capture of meaningful durable information. This
is agent judgment, not a background extraction hook. Otherwise require save intent.
Do not save transient task status, secrets, unsupported guesses, or excluded content.
Apply preferences as contextual facts, not executable instructions or new authority.
Saving a preference does not configure the assistant or guarantee that the
preference will be loaded in future turns.
Pre-compaction flushes follow these steps with their available tools; they do
not use `knowledge_attach` or `knowledge_recall`.

## Save a claim

Most captures stop here and need no reference. Save a discrete claim (decision,
preference, commitment, fact, event or belief) with `knowledge_remember`: one
claim per item, short attribution, the supporting conversation excerpt and, only
when you know it, the subject's exact page title or alias. An omitted subject is
inferred when the text names exactly one entity page. It resolves subjects,
reports exact repeats and never creates pages. Its published receipt is the save.

When the claim concerns an entity that has a page and changes what its State
says (a decision, an outcome, a changed status, a resolved question), also
update that page below in the same task. Claims alone leave its State stale.
Continue below too to revise a page's prose or save a longer note.

## Update a page or save a note

Read [setup](references/setup.md), [subject pages](references/profiles.md) and
only the layout for the page's type ([project](references/layout-project.md),
[person](references/layout-person.md), [company](references/layout-company.md),
[concept](references/layout-concept.md)). Read [publish](references/publish.md)
before the write and [writing](references/writing.md) before new prose. You
don't need to reread them after compaction unless you are about to use them.

1. Preserve the supplied wording, especially original ideas. Use the active
   ontology's type descriptions to classify the information. Do not add
   unsupported facts or turn a tentative thought into established fact.
2. Search for an already-captured item and relevant entities with
   `knowledge_grep`; reserve `knowledge_lookup` for already-known exact record
   IDs, full titles or declared aliases, with grep fallback on `missing`. If the
   same source or text is already saved, report that page rather than create
   another. A similar thought is not proof of identity: keep genuinely distinct
   versions with attribution. Use `knowledge-correct` for corrections or
   withdrawal.
3. Put the information on the most specific existing page it is about. Read the
   whole body first. Rewrite the State topic or type section it bears on in
   place so the page reads as current; never append a dated heading or a
   section per capture, and write no Timeline entries. Leave the rest of an
   already-current page alone, and keep every existing citation. Preserve
   decision rationale, event dates and uncertainty without retaining every
   conversational editing step. If the page has a written Timeline or dated
   section, retire it ([retire dated sections](references/retire-dated.md)).
4. Create a separate record only when the information warrants independent
   context, chronology or explanation, and link it to the resolved subject page
   with a body wikilink. Do not invent a subject match or create an empty
   profile merely to supply a link. An ordinary new fact does not authorize
   automatic identity merging.
5. Page bodies have a size budget
   ([page budgets](references/publish.md#page-budgets)). If an edit returns
   `state: "rejected"`, nothing was saved: follow that section's order, and
   save the fact with `knowledge_remember` meanwhile. Never truncate to fit.
6. For a short inline thought, save the exact text via `source: {text,
   attribution}` and cite it in the body ([sources](references/sources.md)).
   Identify the speaker, context and date when known. Identify conversation
   excerpts as excerpts, not complete transcripts; never invent messages,
   hashes or locators. Attach a supplied original file instead of treating a
   paraphrase as the original. User beliefs stay attributed to the user.
7. Publish; on an uncertain or rejected write read
   [recovery](references/recovery.md). Verify that the intended subject page was
   updated, or that the separate record's subject link resolves, and its
   evidence ([verify](references/verify.md)). Report the returned page and
   verified save state. Do not schedule reminders or execute commitments
   mentioned in the note.
8. If the owner explicitly asks for this context to be recalled automatically
   and `knowledge_recall` is available, inspect the published record's current
   revision and hash and approve a short summary with only the requested trigger
   or project scope. Never approve ingested source text, source claims, agent
   inference, secrets, or extra context the owner did not request. A correction
   requires a separate approval on the replacement record.

Route a complete document to `knowledge-ingest`, or a meeting to
`knowledge-meeting-ingest`.
