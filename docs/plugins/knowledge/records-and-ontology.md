---
summary: "Knowledge record format, structured claim fields, the default ontology, local ontology extensions, and Markdown links"
read_when:
  - You are reading or editing Knowledge Markdown files directly
  - You want to extend the Knowledge vocabulary with your own page or relationship types
  - You need to know how wikilinks, backlinks, and filenames work in a Knowledge vault
title: "Knowledge records and ontology"
sidebarTitle: "Records and ontology"
---

The on-disk record format, the vocabulary that types it, and how links resolve.
Part of the [Knowledge plugin](/plugins/knowledge) guide.

## Records

Each page, claim, or relationship is one UTF-8 Markdown file that starts with a
closed `---` YAML 1.2 frontmatter block. Every record has:

- `format: knowledge-record-v1`, an opaque `id`, and a positive integer
  `revision`.
- `kind: page | claim | relationship`, `title`, and `recorded_at`/`updated_at`
  UTC timestamps.
- A store-owned `scope`; see
  [Partitions](/plugins/knowledge/stores-and-access#partitions).
- `lifecycle: active | superseded | withdrawn | merged`. There is no candidate or
  approval state.
- Optional `aliases`, `tags`, and stable-ID `dependencies`.

Identity comes from the `id`, never from the filename, title, or alias. Unknown
frontmatter survives reads and page saves. Duplicate IDs stay listed, but exact
lookup returns no record for them. Files with an invalid envelope or YAML stay on
disk and appear in diagnostics. Typed records with invalid ontology data or
references stay inspectable and are marked invalid.

### Pages

A page has a domain `type` and ontology-defined `fields`. Without a declared
type, ordered ontology path prefixes classify it at read time without rewriting
the file. Entity types (person, company, project, and others) are pages. A
project's optional `fields.status` is `active`, `paused`, `completed`, or
`cancelled`, independent of record lifecycle.

### Claims

A claim has `claim_kind` (`fact`, `preference`, `decision`, `commitment`,
`event`, `belief`), `assertion_origin` (`source`, `user_belief`,
`agent_inference`), `attribution`, nonempty evidence, and the claim text as its
body. Optional `entities` reference page IDs. Unresolved speakers stay as
attribution text, never invented entity IDs.

### Relationships

A relationship has `from`, `to`, a declared ontology `label`, attribution, and
nonempty evidence. Both endpoints must be pages of permitted types. Relationships
are stored as one directed edge and traversed in both directions.

### Optional assertion fields

| Field                       | Applies to          | Meaning                                                     |
| --------------------------- | ------------------- | ----------------------------------------------------------- |
| `occurred_at`               | Claim               | Date or timestamp of the source event or statement          |
| `owner`                     | Commitment claim    | Known owner page ID; omit if unknown                        |
| `due_at`                    | Commitment claim    | Source due date or timestamp; never schedules work          |
| `valid_from`, `valid_until` | Claim, relationship | UTC validity interval, inclusive start and exclusive end    |
| `expires_at`                | Claim, relationship | UTC instant after which the assertion leaves active results |

Occurrence and due values accept a real `YYYY-MM-DD` date or a timestamp with
seconds and an explicit `Z` or numeric offset. No midnight or time zone is
inferred. Validity and expiry accept UTC timestamps. Unknown values must be
omitted, not empty strings. Expired, not-yet-valid, and ended assertions leave
active lookup, search, and connections; occurrence and due dates do not affect
eligibility.

### Lifecycle and merge metadata

`knowledge_correct` and `knowledge_withdraw` write `supersedes`,
`superseded_by`, and `lifecycle_change: {reason, at, actor, request_id}`.
`knowledge_merge` writes `lifecycle: merged` and `merged_into` on the absorbed
page and `merged_from` on the survivor. These fields are never accepted as
arbitrary metadata. See [Corrections and merges](/plugins/knowledge/corrections).

### Automatic recall block

An active record may carry a service-written `recall` block:

```yaml
recall:
  summary: "The short text approved for automatic prompt injection."
  triggers: ["standing preference", "recurring phrase"]
  importance: 8
  projects: ["github.com/example/project"]
  approved_by: owner-private
  approved_at: 2026-09-28T18:30:00.000Z
```

`summary` (1–500 characters) is the only text automatic recall may inject.
`triggers` holds at most 20 phrases of 1–100 characters without newlines,
semicolons, or pipes. `importance` is 1–10. `projects` holds at most 20 host
project keys without newlines or angle brackets. An invalid block produces an
`invalid-recall` diagnostic and is never injected. See
[Automatic recall](/plugins/knowledge/memory-provider#automatic-recall).

### Displayed author

Read responses can include `writtenByAgentId` when the current revision has
journaled agent provenance. The UI shows it as "Saved by". Operator saves,
external edits, and imports without agent provenance have no byline. Source and
speaker attribution are separate.

## Ontology

Without `ontology.yaml`, a store's private partition uses the shipped
`knowledge-default@1.0.0` vocabulary. To extend it, add a manifest at
`private/ontology.yaml`:

```yaml
format: knowledge-ontology-v1
name: research
version: 1.0.0
description: Local research vocabulary
extends: knowledge-default
definitions:
  - name: researcher
    label: Researcher
    description: A person conducting research
    kind: page
    primitive: entity
    directory: researchers/
    aliases: [person]
    fields:
      - name: specialty
        label: Specialty
        type: string
        required: true
        values: [ecology, history]
  - name: investigates
    label: Investigates
    description: A researcher investigates a project
    kind: relationship
    directory: relationships/
    fields: []
    from_types: [researcher]
    to_types: [project]
```

Other local manifests live under `ontologies/` in the same partition. `extends`
resolves by manifest name, not path or URL. The active manifest is always
`ontology.yaml`; unused manifests do not activate. Malformed active manifests,
missing dependencies, duplicate names, cycles, and chains longer than eight
manifests prevent activation. There are no network imports and no last-known-good
fallback.

### Composition rules

- One parent per manifest. Precedence is child, then borrowed, then nearest
  parent, then earlier ancestors.
- An override replaces the whole definition. Fields, aliases, prefixes, endpoint
  constraints, and flags are not deep-merged.
- `directory` is the primary filing location. Filing elsewhere is a diagnostic,
  not a move or an invalid record.
- `aliases` form a symmetric, transitive query graph. They do not rename records,
  activate types, widen endpoint constraints, or mean "subtype of".
- Page and relationship names share one namespace. Changing an inherited name's
  kind is rejected.
- Omitted relationship endpoint constraints allow any page type; nonempty
  `from_types`/`to_types` restrict exact type names.
- Primitives (`entity`, `media`, `temporal`, `annotation`, `concept`) group types
  for display. They add no fields or behavior.
- `behaviors: {extractable, expert_routing}` are declarations only. No extraction
  or expert service runs.
- `fields` support `string`, `number`, `boolean`, and string-array values, with
  optional `required` and string enumerations.
- A page type may declare a `layout`: how its pages are written. See
  [Page layouts](#page-layouts).

Selective borrowing reads only a donor's own declarations:

```yaml
borrow_from:
  - ontology: research-library
    types: [researcher]
    relationships: [investigates]
```

Requested definitions that do not exist are rejected. For overlapping donors,
root page overrides use the last borrowed declaration and new definitions use the
first. Prefer disjoint donors.

### Default vocabulary

The default ontology is adapted from gbrain's `gbrain-base-v2` pack. It has 19
page types and 19 relationships.

| Page type       | Category   | Notes                                             |
| --------------- | ---------- | ------------------------------------------------- |
| `person`        | Entity     | Optional `role`                                   |
| `company`       | Entity     | Query alias `organization`                        |
| `media`         | Media      |                                                   |
| `tweet`         | Media      | Vocabulary only; no social connector              |
| `social-digest` | Temporal   | Vocabulary only; no scheduled digest              |
| `analysis`      | Media      |                                                   |
| `atom`          | Annotation | A page, not a substitute for claims               |
| `concept`       | Concept    |                                                   |
| `source`        | Media      | Optional canonical and snapshot provenance fields |
| `deal`          | Temporal   | Vocabulary only                                   |
| `email`         | Temporal   | Vocabulary only; no email connector               |
| `slack`         | Temporal   | Vocabulary only; no Slack connector               |
| `meeting`       | Temporal   | Optional `occurred_at` string                     |
| `conversation`  | Temporal   |                                                   |
| `writing`       | Media      |                                                   |
| `project`       | Concept    | Optional `status`                                 |
| `note`          | Concept    | No automatic retyping                             |
| `event`         | Temporal   |                                                   |
| `diary`         | Temporal   | No journaling automation                          |

Relationships: `partner_of`, `relates_to`, `mentions`, `discusses`, `owes_to`,
`awaiting_reply_from`, `founded`, `works_at`, `invested_in`, `advises`,
`sourced_from`, `derived_from`, `supersedes`, `redirects_to`, `attended`,
`authored`, and `attributed_to` have unrestricted endpoints. `leads` (person →
project) and `supports` (company → project) are constrained. A relationship name
implies no inverse edges, inference, redirection, or lifecycle change.

All shipped fields are optional; extensions can require fields.

### Page layouts

A page type's optional `layout` says how its pages are written after the
introduction and State: the question a page answers, its sections in order with
guidance for each, and optional notes for the whole page.

```yaml
layout:
  question: what is it for, where does it stand, and what is undecided?
  sections:
    - heading: Key decisions
      guidance: decisions that still shape the project, newest first.
    - heading: Open questions
      guidance: unresolved decisions and risks, with who owns each.
  notes: State says where things stand.
```

`question` is up to 500 characters, each `heading` up to 100 (one line, without
`#`), each `guidance` up to 2,000, `notes` up to 4,000, with 1–30 sections.
Layouts guide agents and the Knowledge UI; validation never reads them, so a page
that departs from its layout is not invalid. The default vocabulary ships layouts
for `project`, `person`, `company`, and `concept`. Agents read a type's layout
with `knowledge_ontology` `view: "definitions"`; the default catalog omits it.

Because an override replaces the whole definition, a manifest can also replace
only layouts, by type name, without copying definitions:

```yaml
layouts:
  project:
    question: what is it for and what is due?
    sections:
      - heading: Milestones
        guidance: dated outcomes and targets.
```

Layout maps apply from the farthest ancestor to the active manifest, so the
nearest one wins. An entry for a type the resolved ontology no longer declares
is ignored with an `ontology-layout-ignored` diagnostic. Borrowing does not
import a donor's `layouts` map.

The Knowledge UI edits layouts in **Settings → Vocabulary**: open a page type's
details, then **Edit layout**, **Add layout**, or **Reset to default**. A save
sets or removes that type's entry in the partition's `layouts` map. When the
vault has no `ontology.yaml`, the first save creates one named `vault` that
extends `knowledge-default` and declares no definitions. Each save is a
journaled publication: it is rejected when the layout changed after the editor
opened it, appears in mutation history with operation `layout`, and is committed
to [local Git history](/plugins/knowledge#local-git-history). Saving needs
`operator.write` and enabled writes; agents cannot edit layouts.

Older Knowledge versions reject manifests that contain `layout` or `layouts`,
which makes that vault's ontology unavailable until the plugin is upgraded or the
keys are removed. Do not open a vault with saved layouts in an older plugin.

### Fingerprints

The SHA-256 fingerprint covers the canonical effective definitions, excluding
layouts. Parent or donor edits that change effective definitions change it;
layouts, manifest names and versions, formatting, comments, key order, and
unused declarations do not. Saving a layout, including the save that first
creates `ontology.yaml`, therefore never invalidates an in-flight write.
Assertion writes require the current fingerprint, so a definition change between
read and write is rejected.

## Filenames and links

New records get a title-based filename in the ontology's directory, such as
`people/ada-lovelace.md`. Collisions receive a short ID suffix. Saves keep the
current path, and external renames keep identity. After a rename, read the record
again before editing: observation can advance its revision even when the bytes
are unchanged.

Inside saved pages:

- `[[path/to/page|Label]]`, `[[Title]]`, `[[Alias]]`, and relative Markdown `.md`
  links resolve against the authorized catalog. Wikilink paths may omit `.md`.
  Links to a merged page resolve to its survivor.
- Native Markdown links strip literal fragments before decoding filenames:
  `plan%23v2.md` and `plan%23v2.md#Details` both target `plan#v2.md`.
  Ordinary `plan.md#Details` and wiki-link fragments keep their existing meaning.
- Ambiguous and missing targets stay unlinked and are diagnosed; they do not
  invalidate the page.
- Code, image destinations, raw HTML, and generated
  `<!-- backlinks:start --> … <!-- backlinks:end -->` sections add no links.
- HTML comments are not rendered but stay in the stored file. Other raw HTML is
  escaped.
- References and backlinks are recomputed from each scan, not stored.
- Cite sources inline as readable wikilinks with line locators in the label.
  Hashes and ranges stay in structured evidence.

A Markdown link is navigation, not evidence of a typed relationship.
