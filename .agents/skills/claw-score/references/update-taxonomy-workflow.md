# Taxonomy Update Workflow

Use this workflow when the task is to update the maturity taxonomy itself:
surface areas, families, categories, features, filenames, or rendered
top-level artifacts.

## Scope

This workflow owns:

- adding, removing, renaming, or regrouping surfaces
- adding, removing, renaming, or regrouping categories
- changing category note filenames
- changing features or search anchors
- changing archival state such as `archived: true`
- changing rendered taxonomy or scorecard structure through skill templates or
  renderers

This workflow does not score a surface. If the user is evaluating Coverage,
Quality, or Completeness, use `./compute-score-workflow.md`.

## Inputs

Required:

- `.agents/skills/claw-score/taxonomy.yaml`

Optional:

- `docs/maturity-scorecard/inventory/<surface-id>/scores.yaml`
- `docs/maturity-scorecard/inventory/<surface-id>/report.md`
- `docs/maturity-scorecard/inventory/<surface-id>/<category>.md`
- `docs/maturity-scorecard/LTS.md`

## Workflow

1. Update taxonomy source of truth.
   - Treat `.agents/skills/claw-score/taxonomy.yaml` as the only hand-edited
     source of truth for the active in-repo surfaces, levels, rationale,
     categories, `human_lts_override`, archival state,
     optional `completeness_instructions`, and `last_score_run`.
   - Treat `/Users/kevinlin/tmp/maturity/taxonomy.yaml` as the archive taxonomy
     for the other surfaces when the active in-repo taxonomy is intentionally
     narrowed.
   - Do not add derived inventory paths back into taxonomy. Active paths are
     inferred from the surface id as `inventory/<surface-id>/...`.
   - Archived surfaces should be marked with `archived: true`.

2. Preserve surface and category contract.
   - Every surface must include `id`, `name`, `family`, `level`, `rationale`,
     `categories`, and `last_score_run`.
   - `completeness_instructions` is optional. When present it must point to a
     file under `.agents/skills/claw-score/` using a skill-relative path.
   - If a surface omits `completeness_instructions`, score completeness from
     the taxonomy feature set, linked docs, and evidence-backed capability
     gaps until a surface-specific rubric is added later.
   - Define a surface as the smallest durable product or operating area that a
     reviewer would expect to see as one scorecard row.
   - Surface names should usually be short noun phrases, ideally 1-4 words.
   - Prefer product-area names such as `CLI`, `Gateway runtime`, or `Slack`
     over workflow bundles such as `CLI install, update, onboard, doctor`.
   - Prefer names that match existing OpenClaw docs navigation and operator
     vocabulary.
   - Do not make a surface name into a list of verbs, lifecycle phases, or
     subflows. If the candidate name reads like a bundled workflow checklist,
     it is probably one surface with multiple categories rather than a good
     surface name.
   - Do not create a new surface when the work is better represented as one
     capability area inside an existing product surface.
   - Surface renames should be rare. Rename a surface only when the old name is
     misleading, over-bundled, or clearly out of step with doc/operator
     vocabulary.
   - Every category must include `name`, `category_note`, `features`, `docs`,
     `search_anchors`, and `human_lts_override`.
   - Define a category as a user-utilizable capability area for the surface.
     The category should name something a user, operator, or author can
     actually do with that surface.
   - `features` entries are objects with `name` and `description`.
   - `docs` must be a list of repo-relative doc URLs that cover the category.
     Use stable paths like `docs/gateway/protocol.md`, not absolute filesystem
     paths and not line-number citations.
   - `search_anchors` should be derived from how the existing OpenClaw docs
     refer to the category. Do not rename `search_anchors` mechanically just
     because the category name changes.
   - When creating or refining a category, scan the OpenClaw docs corpus first
     and attach the relevant canonical pages into taxonomy `docs` as part of
     the category-design step, not as a later cleanup pass.
   - When refreshing `search_anchors`, prefer phrases already used in the docs
     corpus over newly invented aliases that merely mirror the current category
     label.
   - When you finalize a category, make sure the surface's completeness
     instructions still describe how that category's completeness should be
     judged. If the category set changed materially, revise the completeness
     instructions too.
   - In practice, this means searching the OpenClaw docs tree for the category
     and its candidate features, then choosing the smallest set of doc pages a
     reviewer should read first to understand that category.
   - Calibrate categories around operator-facing capability areas, not
     implementation groupings. A category should exist because it has its own
     operator mental model, docs entrypoints, or maturity story.
   - Optimize for a few coarser categories instead of many fine-grained names.
     If a category set starts reading like implementation slices, consolidate it
     before rendering.
   - Do not use internal architecture labels, SDK layout details, protocol
     phases, or runtime subsystems as categories when they only explain how a
     capability is implemented. Keep those in features, descriptions, docs, or
     evidence instead.
   - Do not create a separate category for a prerequisite, preflight,
     reliability check, or repair substep when it is just one part of a
     broader operator workflow such as setup or doctor.
   - Prefer merging categories when one is merely "additional checks",
     "runtime prerequisites", "platform repair", or another sub-phase of a
     broader capability area.
   - Prefer merging related concepts when their primary docs, operator action
     surface, or maturity evidence overlap. For example, memory backend,
     memory files, memory tools, and active memory usually belong under
     `Memory`, with the narrower concepts represented as features.
   - Fold multiple operations into a capability umbrella when the operator
     experiences them as one area. For example, compaction, pruning,
     context-window estimation, and token-pressure handling belong under
     `Token Management`.
   - Prefer splitting categories only when the candidate areas have meaningfully
     different docs entrypoints, failure modes, or maturity signals.
   - If two candidate categories share the same primary docs and the same
     operator action surface, merge them.
   - If a candidate category mostly explains how another category is
     implemented, fold it into features, descriptions, or note evidence rather
     than keeping it as a top-level category.
   - For plugin surfaces in particular, prefer categories such as
     `Channel plugins`, `Provider plugins`, `Publishing plugins`, or
     `Testing plugins` over internal labels such as SDK subpath structure,
     export generation, or runtime registry internals.
   - Define a feature as a user-invokable capability for this surface and this
     category. The feature should name something an OpenClaw user or operator
     can intentionally do, use, or experience.
   - Keep feature `name` values short and descriptive, similar in style to
     category names. Put the elaboration in `description` instead of repeating
     the full sentence in both fields.
   - Prefer features that describe concrete capabilities such as
     `Sessions and chat`, `Node pairing`, or `Tool invocation`.
   - Do not use internal protocol steps, handshake mechanics, wire-format
     details, validation machinery, or other implementation details as
     features. For example, `First-frame connect` is an implementation detail,
     not a feature.
   - Bundle closely related RPCs, generated artifacts, or internal steps into
     one feature when they collectively support one operator-facing capability.
     The taxonomy should capture the capability, while the category note
     explains the underlying implementation.
   - Keep `docs` focused on the canonical doc pages a reviewer should open
     first for that category. Do not dump every evidence citation into
     taxonomy; the category note keeps the detailed line-level evidence.
   - Prefer top-level docs pages that explain behavior, setup, security model,
     or operator workflow. Use the category note evidence section for the
     line-level references that justify scoring decisions.
   - When deciding whether something is a feature, ask: "Can a user/operator
     intentionally invoke this in OpenClaw for this surface and category?" If
     the answer is no, it probably belongs in the description, evidence, or
     category note rather than in taxonomy `features`.
   - Apply the same question one level up for categories: "Would an operator
     intentionally navigate docs or make decisions about this as a distinct
     capability area?" If not, it probably belongs inside another category.
   - When recovering taxonomy from category notes, prefer `## Component Scope`
     bullets in `Short name: full explanation` form so
     `sync_taxonomy_categories.py` can preserve the split cleanly.
   - Category names should be succinct descriptive phrases. Do not repeat the
     surface name or labels like `Feature Matrix` or `Channel` when that
     context is already clear from the surface itself.
   - Never use `binding` as a category-name word. Use operator-facing names
     such as `Session Routing`, `Conversation Routing and Delivery`,
     `Thread Handling`, or `Agent Selection`, and keep binding terminology in
     `search_anchors`, feature descriptions, or evidence when docs use it.
   - Avoid slash-separated lifecycle names such as `Setup/onboarding`. Choose
     the broader capability name, such as `Setup`, and keep onboarding as a
     feature or search anchor when the docs use that term.
   - Avoid `X and Y` category names unless the docs and operator workflow
     consistently treat them as one durable capability area. If `X` is really a
     sub-part of `Y`, keep just `Y`.
   - Keep `category_note` filenames stable unless the user is explicitly
     changing the naming contract.
   - When merging categories, keep useful doc-derived `search_anchors` from the
     prior categories instead of renaming them mechanically to match the new
     label.
   - When changing category splits, update taxonomy first before touching
     `scores.yaml` or rendered Markdown.

3. Plan category renames and merges before editing artifacts.
   - For every category rename or merge, write down the old name(s), new name,
     retained `category_note`, deleted or historical note files, feature merge,
     docs merge, preserved `search_anchors`, score merge rule, and whether
     `LTS.md` references the category.
   - Prefer preserving the surviving category-note filename when a merge mostly
     broadens one existing category. Change filenames only when the current
     filename would actively mislead maintainers.
   - When merging scored rows, either keep the lower prior score for a
     conservative merge or document an arithmetic-mean carry-forward in the
     category note and rendered report. Do not silently average or hand-wave the
     score provenance.
   - Apply edits in source order: taxonomy first, then `scores.yaml`, then
     category notes and reports, then `taxonomy.md`, `taxonomy-outline.md`,
     `maturity-scorecard.md`, and finally `LTS.md` if affected.
   - Run strict category-name validation for every edited surface before
     closing the rename:

     ```bash
     python3 .agents/skills/claw-score/scripts/render_scorecard_from_taxonomy.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --validate-only \
       --strict-category-names \
       --strict-category-name-surface <surface-id>
     ```

4. Sync derived YAML when needed.
   - If taxonomy changed in a way that affects per-surface category identity,
     sync score YAML from taxonomy with:

     ```bash
     python3 .agents/skills/claw-score/scripts/sync_scores_yaml.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard-root docs/maturity-scorecard
     ```

   - If taxonomy should be recovered from an existing active inventory tree,
     use:

     ```bash
     python3 .agents/skills/claw-score/scripts/sync_taxonomy_categories.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard-root docs/maturity-scorecard
     ```

   - `sync_taxonomy_categories.py` treats taxonomy and category notes as the
     metadata source for `features`, `docs`, `search_anchors`, and
     `human_lts_override`. Active `scores.yaml` files contribute row identity
     (`name` and `category_note`) only.
   - Normal sync scripts skip archived surfaces.

5. Render top-level artifacts.
   - Render taxonomy reference:

     ```bash
     python3 .agents/skills/claw-score/scripts/render_taxonomy_from_taxonomy.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --taxonomy-doc docs/maturity-scorecard/taxonomy.md \
       --taxonomy-outline-doc docs/maturity-scorecard/taxonomy-outline.md
     ```

   - Render top-level scorecard:

     ```bash
     python3 .agents/skills/claw-score/scripts/render_scorecard_from_taxonomy.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard docs/maturity-scorecard/maturity-scorecard.md
     ```

   - The scorecard layout is owned by
     `./references/maturity-scorecard-template.md`. Change the template when
     the scorecard structure changes.

   - Update `docs/maturity-scorecard/LTS.md` in the same change when
     the taxonomy edit renames, adds, removes, or regroups any surface or
     category referenced by the LTS slice. `LTS.md` is intentionally
     hand-curated rather than fully rendered from taxonomy, so the render
     scripts will not catch stale names there.
   - If `human_lts_override` changes, or if `LTS.md` status rows change,
     rerender every affected surface report before validation. The per-surface
     report matrix LTS column must match `LTS.md`.

6. Verify.
   - Verify rendered taxonomy:

     ```bash
     python3 .agents/skills/claw-score/scripts/render_taxonomy_from_taxonomy.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --taxonomy-doc docs/maturity-scorecard/taxonomy.md \
       --taxonomy-outline-doc docs/maturity-scorecard/taxonomy-outline.md \
       --check
     ```

   - Verify rendered scorecard:

     ```bash
     python3 .agents/skills/claw-score/scripts/render_scorecard_from_taxonomy.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard docs/maturity-scorecard/maturity-scorecard.md \
       --check
     ```

   - When taxonomy changes affect score YAML shape, also run:

     ```bash
     python3 .agents/skills/claw-score/scripts/sync_taxonomy_categories.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard-root docs/maturity-scorecard \
       --check

     python3 .agents/skills/claw-score/scripts/sync_scores_yaml.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard-root docs/maturity-scorecard \
       --check
     ```

   - If the taxonomy change should affect `LTS.md`, search it for stale
     surface and category names before closing the workflow.

   - Verify `LTS.md`, taxonomy LTS flags, and rendered report matrix LTS cells
     are synchronized:

     ```bash
     python3 .agents/skills/claw-score/scripts/validate_lts_sync.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard-root docs/maturity-scorecard \
       --lts docs/maturity-scorecard/LTS.md
     ```

   - Run `git diff --check` over changed files.
