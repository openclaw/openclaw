# Score Computation Workflow

Use this workflow when the task is to compute or refresh maturity scores for a
surface, its categories, and the features evaluated inside those categories.

## Scope

This workflow owns:

- gathering evidence for one surface
- scoring each category for Coverage, Quality, and Completeness
- writing category notes
- aggregating per-surface `scores.yaml`
- rendering `report.md`
- updating `last_score_run` for the scored surface

This workflow does not redefine surface boundaries or category splits. If the
taxonomy itself is changing, use `./update-taxonomy-workflow.md` first.

## Inputs

Required:

- surface name or surface id
- `.agents/skills/claw-score/taxonomy.yaml`

Expected active outputs:

- `docs/kevinslin/maturity-scorecard/inventory/<surface-id>/scores.yaml`
- `docs/kevinslin/maturity-scorecard/inventory/<surface-id>/report.md`
- `docs/kevinslin/maturity-scorecard/inventory/<surface-id>/<category>.md`

## Workflow

1. Resolve source and target.
   - Read `.agents/skills/claw-score/taxonomy.yaml`.
   - Locate the requested surface. If multiple rows match, ask one concise
     question.
   - Use the taxonomy surface id to derive the output root as
     `docs/kevinslin/maturity-scorecard/inventory/<surface-id>/`.
   - If the surface is marked `archived: true`, stop unless the user explicitly
     asks to rescore archived material.

2. Use the taxonomy category inventory.
   - Do not rediscover categories during a scoring run.
   - Use taxonomy `categories` as the source of truth for category names,
     note filenames, features, docs, search anchors, and
     `human_lts_override`.
   - `features` entries are taxonomy objects with `name` and `description`.
     Treat `name` as the short label and `description` as the detailed
     explanation.
   - `docs` entries are taxonomy-owned repo-relative doc URLs for the
     category's primary reading list.
   - Read each feature as a user-invokable capability, not as a low-level
     implementation primitive. Score the capability using the underlying docs,
     source, tests, and runtime evidence that support it.
   - If evidence shows the category split is wrong, stop and update taxonomy
     first with `./update-taxonomy-workflow.md`.
   - Read the surface's `completeness_instructions` file before assigning any
     Completeness scores. This file is taxonomy-owned and uses a path relative
     to `.agents/skills/claw-score/`.

3. Check archive freshness before scoring.
   - Always run `gitcrawl doctor --json`.
   - Always run `discrawl status --json`.
   - If either command is unavailable or exits non-zero, stop and report the
     blocker.
   - Record the exact freshness result in every category note.
   - Restrict all Discord archive work to `clawtributors` and other public
     channels.
   - Do not query, cite, or summarize maintainer-only channels.
   - Do not query, cite, or summarize private security channels.

4. Research each taxonomy category in parallel.
   - Use one subagent per taxonomy category.
   - Each category agent writes exactly one category note.
   - Read current docs, source, integration/e2e/live tests, unit tests,
     gitcrawl results, and discrawl results.
   - When using `discrawl`, keep searches and any cited results within the
     allowed public-channel scope above.
   - Run any `additional_validation` commands declared on the surface.
   - Separate local prerequisite failures from product evidence.

5. Score Coverage, Quality, and Completeness.
   - All three scores are `0-100` plus `Lovable`, `Stable`, `Beta`, `Alpha`,
     or `Experimental`.
   - Thresholds are `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
     `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose
     the higher label.
   - Coverage measures integration, e2e, live, or real runtime-flow evidence.
   - Quality measures implementation robustness, operator clarity, security
     posture, docs/source alignment, and lived bug/regression/confusion record.
   - Completeness measures how fully the category delivers the intended
     surface-specific capability set. Use the surface's
     `completeness_instructions` file to determine what "complete" means for
     that surface.
   - Test coverage never raises or lowers Quality.
   - LTS is derived later from `(quality > 80 and coverage > 90) OR
     human_lts_override`.

6. Write category notes.
   - Use `./category-note-template.md`.
   - Set category-note frontmatter `version` to the current scoring process
     version. The render step below also enforces that category-note versions
     match `scores.yaml.process_version`.
   - Treat the category note `## Features` section as taxonomy-derived. If the
     listed feature set is wrong, fix `taxonomy.yaml` rather than hand-editing
     the note.
   - Keep `## Evidence` populated with docs, source, tests, archive queries,
     and optional surface validation commands.
   - If a category note includes `discrawl` evidence, state that the queries
     were limited to `clawtributors` and public channels.
   - If the primary reading list for the category changes materially, update
     taxonomy `docs` so the rendered report stays aligned.
   - Use exact score lines:
     `- Score: \`<Label> (<N>%)\`` for Coverage, Quality, and Completeness.

7. Aggregate after all category notes exist.
   - Reject notes with missing evidence, malformed score lines, or Quality
     reasoning that depends on test coverage.
   - Compute arithmetic means for Coverage, Quality, and Completeness and
     round to the nearest whole number.
   - Write `scores.yaml` using `./feature-matrix-template.yaml`.
   - Keep `name` and `category_note` aligned with taxonomy.
   - Do not duplicate `features`, `docs`, or `search_anchors` in
     `scores.yaml`; those stay in taxonomy and are joined by the renderer.
   - Update the scored surface's `last_score_run` in taxonomy with
     `status: complete`, `completed_at`, `by`, `source_ref`, and the current
     scoring process version.

8. Write the main surface report.
   - Use `./surface-report-template.md`.
   - Render score-bearing Markdown from YAML with:

     ```bash
     python3 .agents/skills/claw-score/scripts/render_score_matrix.py \
       --scores <output-root>/scores.yaml \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --report <output-root>/report.md
     ```

   - The renderer owns top-level scores, matrix score columns, matrix LTS,
     per-category `Score decisions`, report-level feature lists, report-level
     primary docs, search-anchor placement, detailed-inventory links to
     category notes, taxonomy-derived category-note `## Features` sections, and
     frontmatter `version` sync for the surface report and category notes.

9. Verify.
   - Confirm all category notes exist.
   - Confirm `scores.yaml` is present, valid, and aligned with taxonomy for
     `name` and `category_note`.
   - Confirm `report.md` is rendered from `scores.yaml` with:

     ```bash
     python3 .agents/skills/claw-score/scripts/render_score_matrix.py \
       --scores <output-root>/scores.yaml \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --report <output-root>/report.md \
       --check
     ```

   - If the scoring refresh changes `human_lts_override`, `LTS.md`, or any
     category included in `LTS.md`, confirm LTS synchronization with:

     ```bash
     python3 .agents/skills/claw-score/scripts/validate_lts_sync.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard-root docs/kevinslin/maturity-scorecard \
       --lts docs/kevinslin/maturity-scorecard/LTS.md
     ```

   - Confirm top-level artifacts are current:

     ```bash
     python3 .agents/skills/claw-score/scripts/render_taxonomy_from_taxonomy.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --taxonomy-doc docs/kevinslin/maturity-scorecard/taxonomy.md \
       --taxonomy-outline-doc docs/kevinslin/maturity-scorecard/taxonomy-outline.md \
       --check

     python3 .agents/skills/claw-score/scripts/render_scorecard_from_taxonomy.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard docs/kevinslin/maturity-scorecard/maturity-scorecard.md \
       --check
     ```

   - Run `git diff --check` over changed files.
