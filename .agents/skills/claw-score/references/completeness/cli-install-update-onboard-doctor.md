# CLI Surface Completeness

Use this rubric when assigning category Completeness scores for the
`cli-install-update-onboard-doctor` surface.

## What Completeness Means Here

Completeness measures how fully the CLI supports the intended operator journey
for installation, onboarding, configuration, repair, and upgrade. Score whether
an operator can complete the end-to-end job for the category across the
expected environments and recovery branches.

## Scoring Questions

For each category, ask:

- Can a normal operator complete the job end to end from the CLI?
- Are the expected environments represented where they matter for the category,
  such as local installs, remote gateway use, supervised services, or
  Windows/WSL2?
- Are the main lifecycle stages present where relevant: setup, inspection,
  change, repair, and upgrade?
- Are common recovery and troubleshooting branches present, or does the
  workflow dead-end after the happy path?
- Are major documented operator expectations still unimplemented?

## Surface-Specific Guidance

- Favor higher Completeness when the CLI covers the full operator journey, not
  only the install or happy path.
- Lower Completeness when the category lacks meaningful repair, migration,
  remote, or platform-specific branches that users are expected to rely on.
- For Windows and WSL2, score against the intended supported experience rather
  than parity with macOS/Linux internals.
- Do not use test breadth to lower Completeness; that is Coverage.
- Do not use fragility or bug history to lower Completeness; that is Quality.

## Suggested Bands

- `Lovable` (95-100): the category covers the full operator journey across the
  expected environments and recovery paths.
- `Stable` (80-95): the main workflow set is broadly complete, with only
  bounded missing paths.
- `Beta` (70-80): the main journey works, but notable operator branches are
  still absent.
- `Alpha` (50-70): only a partial operator workflow is supported.
- `Experimental` (0-50): the category is fragmentary or heavily caveated.
