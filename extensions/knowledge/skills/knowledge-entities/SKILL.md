---
name: knowledge-entities
description: Resolve and enrich Knowledge people, companies, projects, and concepts during an authorized ingestion or entity update, with sourced State, timelines, and back-links. Read-only identity questions do not authorize writes.
---

# Resolve and enrich entities

Find who or what an entity is before asking, decide whether it deserves a page,
then write a sourced profile and link it both ways. Read a reference only when
its step needs it. Shared references are identical across Knowledge skills; if
another Knowledge skill brought you here, don't reread ones you already read.

- [setup](references/setup.md): always, first (status, ontology, search)
- [identity](references/identity.md): resolving an entity; whether to create a page
- [enrichment](references/enrichment.md): tiers, what to extract, external lookups, bulk runs
- [profiles](references/profiles.md): page structure, creating or updating
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
- Every fact has an inline citation; every enriched page links to its source and
  the source links back.
- Scale effort to importance. When in doubt, don't create a page.
- Never overwrite user-written assessments; flag contradictions with both
  citations.

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

- **Create:** introduction, State and the first Timeline line, plus only the
  optional sections the evidence supports ([profiles](references/profiles.md)).
- **Update:** add the Timeline line; edit a State topic only when its meaning
  changed; use `knowledge_edit_body` for local edits.
- Use declared ontology fields only; omit unknown values.
- Page bodies have a size budget, smaller for hub pages
  ([page budgets](references/publish.md#page-budgets)). When a write is
  rejected, give the subject that outgrew its section its own page with
  `knowledge_extract_section`; never truncate.
- Create claims and evidenced relationships for independently useful
  assertions ([assertions](references/assertions.md)). Markdown links don't
  create relationships.

**Done when:** every planned write has a published receipt.

### 5. Cross-reference

Link source → entity and entity → source using observed paths. Update related
pages when the new signal matters to them: the company page from a person, and
the reverse; the parent project from a sub-feature.

**Done when:** both link directions exist for every linked entity.

### 6. Verify

Run [verify](references/verify.md) with planned `expectedLinks` in both
directions, associations and relationship endpoints. Reread each changed page
against [writing](references/writing.md) and the no-placeholder rule.

**Done when:** structural checks pass and every changed page reads as a real
briefing.

## Report

Return resolved IDs, created/updated/reused pages, sources used, unresolved or
partial identities, contradictions and skipped work to the caller or user.
