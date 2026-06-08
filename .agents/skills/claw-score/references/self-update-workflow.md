# Self-update Workflow

Use this workflow when the task is to update the `claw-score` skill itself:
`SKILL.md`, reference docs, templates, renderer behavior, sync scripts, or the
artifact-maintenance contract for `docs/kevinslin/maturity-scorecard/`.

## Scope

This workflow owns:

- changing `SKILL.md`
- changing files under `.agents/skills/claw-score/references/`
- changing files under `.agents/skills/claw-score/scripts/`
- changing the human-facing artifact contract in
  `docs/kevinslin/maturity-scorecard/README.md`
- rerendering or resyncing active scorecard artifacts when a skill change
  affects their generated shape or maintenance rules

This workflow does not replace taxonomy maintenance or scoring. If the skill
update also changes taxonomy structure or category inventory, use
`./update-taxonomy-workflow.md` as part of the same change. If it changes
actual surface scores or evidence, use `./compute-score-workflow.md`.

## Inputs

Required:

- `.agents/skills/claw-score/SKILL.md`

Optional, depending on the change:

- `.agents/skills/claw-score/references/**`
- `.agents/skills/claw-score/scripts/**`
- `docs/kevinslin/maturity-scorecard/README.md`
- `docs/kevinslin/maturity-scorecard/taxonomy.md`
- `docs/kevinslin/maturity-scorecard/taxonomy-outline.md`
- `docs/kevinslin/maturity-scorecard/maturity-scorecard.md`
- `docs/kevinslin/maturity-scorecard/inventory/**`

## Workflow

1. Classify the change before editing.
   - Determine whether the request is:
     - instruction-only
     - reference/template-only
     - renderer or sync-script behavior
     - artifact-contract or output-shape change
   - Prefer the smallest change that satisfies the request.
   - Do not edit runtime-installed skill mirrors. Keep edits in the repo-local
     source tree under `.agents/skills/claw-score/`.

2. Update the skill contract at the source.
   - Treat `.agents/skills/claw-score/SKILL.md` as the top-level operational
     contract for this repo-local skill.
   - When adding or changing a workflow, keep the `## Methods` section and the
     `## Reference files` section in sync.
   - When a change adds or removes responsibilities, update the relevant
     authority, input, concept, or output-contract sections in the same change
     if they would otherwise become misleading.

3. Update bundled references, templates, and scripts together.
   - If `SKILL.md` points to a reference file, make sure that file exists and
     matches the router text.
   - If the change affects generated output shape, update the owning template
     or renderer instead of hand-editing generated Markdown.
   - If sync or render behavior changes, update the relevant script in
     `.agents/skills/claw-score/scripts/` and any paired reference docs in the
     same change.

4. Keep the human-facing artifact contract current.
   - Check `docs/kevinslin/maturity-scorecard/README.md` whenever the skill
     changes artifact ownership, regeneration commands, terminology, or the
     division of responsibilities between source YAML and rendered Markdown.
   - Keep the README human-facing: describe file roles, regeneration steps, and
     maintenance expectations without duplicating the full agent workflow.

5. Resync or rerender artifacts when the change affects them.
   - If taxonomy parsing or category-metadata recovery changed, run:

     ```bash
     python3 .agents/skills/claw-score/scripts/sync_taxonomy_categories.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard-root docs/kevinslin/maturity-scorecard
     ```

   - If score-row identity or `scores.yaml` shape changed, run:

     ```bash
     python3 .agents/skills/claw-score/scripts/sync_scores_yaml.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard-root docs/kevinslin/maturity-scorecard
     ```

   - If taxonomy-reference rendering changed, rerender:

     ```bash
     python3 .agents/skills/claw-score/scripts/render_taxonomy_from_taxonomy.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --taxonomy-doc docs/kevinslin/maturity-scorecard/taxonomy.md \
       --taxonomy-outline-doc docs/kevinslin/maturity-scorecard/taxonomy-outline.md
     ```

   - If top-level scorecard rendering changed, rerender:

     ```bash
     python3 .agents/skills/claw-score/scripts/render_scorecard_from_taxonomy.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard docs/kevinslin/maturity-scorecard/maturity-scorecard.md
     ```

   - If per-surface report rendering or report template behavior changed,
     rerender the affected active reports. This also refreshes renderer-owned
     category-note sections such as taxonomy-derived `## Features`. When the
     change is broad, rerender all active reports:

     ```bash
     rg --files docs/kevinslin/maturity-scorecard/inventory -g 'report.md' \
       | while IFS= read -r report; do
           python3 .agents/skills/claw-score/scripts/render_score_matrix.py \
             --taxonomy .agents/skills/claw-score/taxonomy.yaml \
             --report "$report"
         done
     ```

   - Do not hand-edit generated tables in rendered Markdown when the change can
     be expressed in taxonomy, templates, or renderer logic.

6. Verify the changed contract.
   - Run the relevant `--check` command for every script or renderer whose
     output contract changed.
   - For broad renderer or sync changes, prefer the full verification sweep:

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

     python3 .agents/skills/claw-score/scripts/sync_taxonomy_categories.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard-root docs/kevinslin/maturity-scorecard \
       --check

     python3 .agents/skills/claw-score/scripts/sync_scores_yaml.py \
       --taxonomy .agents/skills/claw-score/taxonomy.yaml \
       --scorecard-root docs/kevinslin/maturity-scorecard \
       --check
     ```

   - If `render_score_matrix.py` or `surface-report-template.md` changed,
     verify all rerendered reports with `render_score_matrix.py --check`.
   - Run `git diff --check` over changed files before handoff.
