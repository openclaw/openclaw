---
name: knowledge-entities
description: Resolve and enrich Knowledge people, companies, projects, and concepts during an authorized ingestion or entity update, with sourced State, source notes, and links. Read-only identity questions do not authorize writes.
---

# Resolve and enrich entities

Find who or what an entity is before asking, decide whether it deserves a page,
then write a sourced profile, its source note and links. Read a reference only when
its step needs it. Shared references are identical across Knowledge skills; if
another Knowledge skill brought you here, don't reread ones you already read,
and don't reread any after compaction unless you are about to use it again.

- [setup](references/setup.md): always, first (status, ontology, search)
- [identity](references/identity.md): resolving an entity; whether to create a page
- [enrichment](references/enrichment.md): tiers, what to extract, external lookups, bulk runs
- [subject pages](references/profiles.md): page rules, creating or updating
- the layout for the entity's type, and only that one:
  [project](references/layout-project.md), [person](references/layout-person.md),
  [company](references/layout-company.md), [concept](references/layout-concept.md)
- [retire dated sections](references/retire-dated.md): only when the page has a
  written Timeline or a section named for a date or source
- [source notes](references/source-notes.md): the entity's relationship with the source
- [writing](references/writing.md): before writing page prose
- [sources](references/sources.md): retaining sources and citing them
- [assertions](references/assertions.md): claims and relationships about the entity
- [publish](references/publish.md): page writes and batches
- [recovery](references/recovery.md): any uncertain, rejected or conflicting write
- [verify](references/verify.md): verification and report
- [evidence repair](references/evidence-repair.md): only for an authorized evidence-set repair

## Contract

- Check Knowledge before asking the user or searching externally. Ask only with a
  hypothesis.
- No stubs or placeholders: every page's first line says who or what it is.
- Every fact has an inline citation. The source links to every enriched page, and
  each enriched page has a source note: its relationship with the source.
- Scale effort to importance. When in doubt, don't create a page.
- Never overwrite user-written assessments; flag contradictions with both
  citations.
- Leave a current page alone apart from the new facts. Route each fact to the
  most specific existing page it is about.

## Steps

### 1. Identify entities

List the people, companies, projects and concepts in the source. Separate actual
participants from third parties mentioned in passing.

**Done when:** each entity is marked participant, substantive or incidental.

### 2. Resolve each one

Run the resolve chain in [identity](references/identity.md). Reuse an existing
page's ID. Decide create, update or skip using its page-creation rules, and pick
the best-fitting declared ontology type.

**Done when:** each entity has an existing ID, a create decision with a type, or
is skipped; ambiguous identities are recorded as partial or unresolved.

### 3. Gather signal

Extract texture from the source and, for Key and Notable entities, look up what's
missing ([enrichment](references/enrichment.md)). Only supported claims move on;
inferences stay labeled where they appear.

**Done when:** each entity has its supported facts and texture, each with a
citation, or a reason it has none.

### 4. Write

- **Create:** introduction and State, plus only the sections of its type's
  layout that the evidence supports ([subject pages](references/profiles.md#create-or-update-a-page)).
  No Timeline section and no dated headings.
- **Source note:** one `attended` or `discusses` relationship between the entity
  and the source, with a one-sentence body
  ([source notes](references/source-notes.md)). It is the entity's row
  in its derived Timeline.
- **Update:** rewrite a State topic or type section in place only when its
  meaning changed; never append a section per source or date, and keep every
  existing citation ([update an existing page](references/profiles.md#create-or-update-a-page)).
  Use `knowledge_edit_body` for local edits. Retire a written Timeline or dated
  section when the page still has one ([retire dated sections](references/retire-dated.md)).
- Use declared ontology fields only; omit unknown values.
- Page bodies have a size budget, smaller for hub pages
  ([page budgets](references/publish.md#page-budgets)). When a write is
  rejected, follow the order there: retire a written Timeline and dated
  sections first, and only then give a clearly separate subject that outgrew its
  section its own page with `knowledge_extract_section`. Never truncate.
- Create claims and evidenced relationships for independently useful
  assertions ([assertions](references/assertions.md)). Markdown links don't
  create relationships.

**Done when:** every planned write has a published receipt.

### 5. Cross-reference

Link source → entity using observed paths. The way back from the entity is its
source note, so the entity page needs no link to the source unless its prose
cites it. Update related pages when the new signal matters to them: the company
page from a person, and the reverse; the parent project from a sub-feature.

**Done when:** the source links to every entity and every entity has its source
note.

### 6. Verify

Run [verify](references/verify.md) with planned source → entity
`expectedLinks`, associations and source-note endpoints. Reread each changed page
against [writing](references/writing.md) and the no-placeholder rule.

**Done when:** structural checks pass and every changed page reads as a real
briefing.

## Report

Return resolved IDs, created/updated/reused pages, sources used, unresolved or
partial identities, contradictions and skipped work to the caller or user.
