---
name: claw-score
description: Audit an OpenClaw maturity-scorecard surface into an evidence-backed category score report. Use when given a surface from an OpenClaw maturity-scorecard.md and asked to score coverage, quality, readiness, or generate a detailed surface report plus per-category subreports.
dependencies:
- mem
---

# claw-score

Use this skill to turn one row from an OpenClaw maturity scorecard into a
detailed, evidence-backed report for that surface and one subreport per major
category.

## Authority

This skill is the authoritative spec for OpenClaw maturity scoring in this
repo.

It owns:

- scoring policy and score semantics
- scoring workflow and validation
- taxonomy maintenance expectations
- rendered artifact shape and renderer expectations
- maintenance rules for the scorecard artifact directory

Treat `docs/kevinslin/maturity-scorecard/` as an artifact root maintained by
this skill. That includes:

- `docs/kevinslin/maturity-scorecard/README.md`
- `docs/kevinslin/maturity-scorecard/taxonomy.md`
- `docs/kevinslin/maturity-scorecard/taxonomy-outline.md`
- `docs/kevinslin/maturity-scorecard/maturity-scorecard.md`
- `docs/kevinslin/maturity-scorecard/inventory/**`

Treat archived surfaces and historical artifacts under
`/Users/kevinlin/tmp/maturity` as out of scope. Do not edit, regenerate, or
reference them during normal `claw-score` maintenance unless the user
explicitly asks to restore archive material.

Discord archive evidence scope for this skill is intentionally narrow:

- Only use `discrawl` evidence from `clawtributors` and other public channels.
- Do not crawl, cite, or summarize maintainer-only channels.
- Do not crawl, cite, or summarize private security channels.

Keep the separation of concerns tight:

- Put all operational scoring instructions in this skill.
- Keep `docs/kevinslin/maturity-scorecard/README.md` human-facing only:
  canonical source pointers, file roles, artifact contract, and regeneration
  commands.
- Do not split scoring policy, validation rules, or workflow steps across both
  this skill and the human-facing `README.md`.
- When this skill changes artifact layout, ownership, or regeneration rules,
  check `docs/kevinslin/maturity-scorecard/README.md` and update it in the same
  change if needed so it continues to describe the outputs accurately.

## Inputs

Required:

- Surface name: one surface from `.agents/skills/claw-score/taxonomy.yaml`, such as
  `Gateway runtime`.

OpenClaw maintainer default:

- Taxonomy path:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Scorecard path:
  `docs/kevinslin/maturity-scorecard/maturity-scorecard.md`.
- Taxonomy doc path:
  `docs/kevinslin/maturity-scorecard/taxonomy.md`.
- Taxonomy outline path:
  `docs/kevinslin/maturity-scorecard/taxonomy-outline.md`.
- Report root:
  `docs/kevinslin/maturity-scorecard/<artifact-root>/<surface-slug>/`, where
  `<artifact-root>/<surface-slug>` is derived from the taxonomy surface id as
  `inventory/<surface-id>/`. Active work currently means `inventory/`; archived
  surfaces are marked with `archived: true` and skipped by normal render and
  sync workflows.

Default output names:

- Main report: `report.md`.
- Score source: `scores.yaml`.
- Category notes: `<category-slug>.md`.
- Place the main report, score source, and notes inside
  the surface-owned taxonomy artifact root and keep the same filenames unless
  the user gives an explicit output directory.

Command working directory:

- Run shell commands from the repository root that contains both
  `docs/kevinslin/maturity-scorecard/` and `.agents/skills/claw-score/`.
- Script paths in commands are repository-root-relative. Template paths such as
  `./references/category-note-template.md` are skill-directory-relative.

## Common Concepts

- `taxonomy`: `.agents/skills/claw-score/taxonomy.yaml`, the only hand-edited
  source of truth for the active in-repo taxonomy slice, including categories,
  archival state, `last_score_run`, and surface-specific completeness
  instructions.
- `archive taxonomy`: `/Users/kevinlin/tmp/maturity/taxonomy.yaml`, which holds
  the non-active surfaces that are intentionally excluded from the in-repo
  taxonomy slice.
- `surface`: the smallest durable product or operating area that should appear
  as one scorecard row. A good surface name is usually a short noun phrase
  aligned with OpenClaw docs and operator vocabulary, such as `CLI`,
  `Gateway runtime`, or `Slack`, rather than a bundled list of workflows like
  `install, update, onboard, doctor`.
- `surface id`: the stable identifier that drives derived active artifact paths
  as `inventory/<surface-id>/...`.
- `archived`: optional boolean on a surface. When `true`, normal render and
  sync workflows skip that surface.
- `category`: a taxonomy-defined scored unit with `name`, `category_note`,
  `features`, `docs`, `search_anchors`, and `human_lts_override`.
  `features` is a list of objects with `name` and `description`. Keep feature
  `name` values short and scannable, and use `description` for the fuller
  explanation. A category should represent a user-utilizable capability area
  for the surface, not an internal architecture label. A category should split
  the surface into meaningful operator-facing capability areas, not substeps or
  reliability checks that belong inside a broader workflow. Prefer fewer,
  coarser categories over many fine-grained names. If two related concepts
  share primary docs, operator workflows, or maturity evidence, merge them into
  one category and keep the specific concepts as features. Never use `binding`
  as a category-name word; use operator-facing terms such as `routing`,
  `delivery`, `session routing`, or `thread handling` instead.
- `completeness_instructions`: a taxonomy surface field whose value is a path
  relative to the skill root `.agents/skills/claw-score/`. The referenced file
  defines how to score the Completeness metric for that surface.
- `feature`: a user-invokable capability within one surface and one category.
  A good feature names something an OpenClaw user or operator can actually do
  on that surface, not an internal protocol step or implementation mechanism.
  For example, `Sessions and chat` is a feature because the user creates
  sessions and runs conversations; `First-frame connect` is not a feature
  because it is handshake machinery the user does not invoke directly.
- `docs`: a taxonomy-owned list of repo-relative doc URLs that best cover the
  category. Keep these concise and stable. Use paths like
  `docs/gateway/protocol.md`, not absolute filesystem paths or line-number
  citations. During taxonomy maintenance, derive this list by scanning the
  OpenClaw docs set and selecting the few canonical pages that best explain
  the category.
- `search_anchors`: a taxonomy-owned list of short phrases derived from how the
  existing OpenClaw docs refer to the category. Do not mechanically rename
  these just because the category label changes; update them only when the
  underlying doc terminology changes or better doc-derived anchors are found.
- `scores.yaml`: the canonical per-surface score source for Coverage, Quality,
  Completeness, and row identity (`name` and `category_note`).
- `report.md`: the rendered per-surface Markdown report derived from
  `scores.yaml` plus taxonomy category metadata.
- `taxonomy.md`, `taxonomy-outline.md`, and `maturity-scorecard.md`: top-level
  rendered artifacts derived from taxonomy.
- `discrawl evidence`: Discord archive evidence used for scoring. Restrict this
  to `clawtributors` and public channels only. Maintainer-only and private
  security channels are always out of scope for `claw-score`.
- `process_version`: scoring-run provenance for YAML score sources and
  `last_score_run`, not a signal to bulk-bump during mechanical edits.

## Category Naming Governance

- Optimize for a small set of coarse capability categories, not a long list of
  implementation slices.
- Use short operator-facing nouns such as `Token Management`, `Memory`,
  `Channel Setup`, or `Conversation Routing and Delivery`.
- Fold operation clusters into a capability umbrella. For example, compaction,
  pruning, and token-pressure behavior belongs under `Token Management`.
- Merge related concepts unless they have distinct docs entrypoints, operator
  workflows, failure modes, and maturity evidence. Memory backend, memory
  files, memory tools, and active memory usually belong under `Memory`.
- Do not use `binding` as a category-name word. Preserve binding-related doc
  terminology in `search_anchors`, feature descriptions, or evidence instead.
- Avoid slash-separated lifecycle names such as `Setup/onboarding`; pick the
  broader operator term, such as `Setup`.
- Category display names may change without changing `search_anchors`.
  `search_anchors` are doc-derived handles, not aliases that must mirror the
  latest display label.

## Reference files

`./references/` contains the reusable templates for this skill:

- `./references/update-taxonomy-workflow.md`: detailed workflow for updating
  taxonomy, surfaces, categories, and top-level rendered artifacts.
- `./references/compute-score-workflow.md`: detailed workflow for computing
  Coverage, Quality, and Completeness for a surface and rendering its inventory
  artifacts.
- `./references/self-update-workflow.md`: detailed workflow for updating this
  skill itself, including related scripts, templates, and scorecard artifacts.
- `./references/category-note-template.md`: template for one per-category
  evidence note.
- `./references/surface-report-template.md`: template for the narrative surface
  report that wraps the rendered matrix output.
- `./references/maturity-scorecard-template.md`: template for the top-level
  `maturity-scorecard.md` layout rendered from taxonomy.
- `./references/feature-matrix-template.yaml`: template for the canonical
  per-surface score source YAML.

Other YAML files used by this skill live in two places:

- `.agents/skills/claw-score/taxonomy.yaml`: skill-owned top-level source of
  truth for the active in-repo surfaces, scorecard metadata, optional
  surface-specific `additional_validation` commands, surface ids, category
  inventory, archival state, `completeness_instructions`, and `last_score_run`.
- `/Users/kevinlin/tmp/maturity/taxonomy.yaml`: archive copy for the other
  surfaces that are temporarily out of the active in-repo taxonomy scope.
- `docs/kevinslin/maturity-scorecard/taxonomy.md`: rendered Markdown reference
  view of the taxonomy source, including surface inventory and per-surface
  category metadata.
- `docs/kevinslin/maturity-scorecard/taxonomy-outline.md`: rendered Markdown
  outline of active surfaces grouped by family, generated from taxonomy.
- `docs/kevinslin/maturity-scorecard/<artifact-root>/<surface-slug>/scores.yaml`:
  rendered per-surface score source for category Coverage, Quality,
  Completeness, and row identity (`name` and `category_note`). It does not
  duplicate taxonomy-owned `features`, `docs`, `search_anchors`,
  `human_lts_override`, or surface-level `completeness_instructions`.

Archived surfaces note:

- Archived surfaces are historical metadata only; active `claw-score` scripts
  skip them by default.
- Do not restore archived artifact trees during routine work. Historical files
  live at `/Users/kevinlin/tmp/maturity`.

Example output shape: the Gateway audit uses
`docs/kevinslin/maturity-scorecard/inventory/<surface-id>/report.md`
plus one note per category in the same surface directory.

## Methods

`claw-score` has three methods:

1. Update taxonomy
   - Use `./references/update-taxonomy-workflow.md`.
   - Choose this when changing surfaces, categories, features,
     category-note filenames, archival state, or top-level rendered artifact
     structure.

2. Compute score
   - Use `./references/compute-score-workflow.md`.
   - Choose this when computing or refreshing Coverage, Quality, and
     Completeness for a specific surface, its categories, and the feature
     evidence inside them.

3. Self update
   - Use `./references/self-update-workflow.md`.
   - Choose this when changing this skill's instructions, references,
     templates, scripts, or artifact-maintenance contract.

## Output Contract

- One human-facing `docs/kevinslin/maturity-scorecard/README.md` that points
  back to this skill, the taxonomy source, and the rendered artifact roles
  without restating the scoring workflow in full.
- One rendered taxonomy reference Markdown file from the taxonomy YAML.
- One rendered taxonomy outline Markdown file from the taxonomy YAML.
- One main report for the selected surface.
- One YAML score source for the selected surface.
- One category note per major category.
- When requested, one top-level scorecard Markdown file rendered from the
  taxonomy YAML.
- Taxonomy `categories` are the authoritative per-surface category inventory.
  Score-source YAML mirrors row identity only and adds scores; taxonomy keeps
  feature names, descriptions, primary docs, search anchors, and
  `human_lts_override`.
- Surface and category Markdown docs include a single frontmatter `version`
  field for scoring-run provenance when newly generated or rescored; existing
  docs keep their prior Markdown `version` when they are only mechanically
  edited. During a real scoring refresh, report and category-note frontmatter
  `version` should match the active `scores.yaml.process_version`.
- Rendered surface reports link each detailed-inventory category back to its
  category note, and category notes include a taxonomy-derived `## Features`
  section that mirrors the category feature list from `taxonomy.yaml`.
- Top-level and score-source YAML include `version: 1` and a
  `process_version`. The top-level taxonomy declares the current process for new
  runs; score-source YAML records the process used for that surface's scores.
- Scores for Coverage, Quality, and Completeness.
- Markdown rollups, matrix Coverage, matrix Quality, matrix Completeness, and
  matrix LTS rendered from the YAML score source plus taxonomy category
  `human_lts_override`.
- `docs/kevinslin/maturity-scorecard/LTS.md`, taxonomy
  `human_lts_override`, and every rendered surface-report matrix LTS column
  must stay synchronized. Run `validate_lts_sync.py` after any LTS-affecting
  taxonomy, score, report, or `LTS.md` edit.
- Archive freshness and exact query records in every category note.
- `## Evidence` preserved and populated in every category note.
- Evidence-grounded known gaps folded into category notes and the main
  inventory.
