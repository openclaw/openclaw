## Default Completeness Process

Completeness is scored against the intended operator-visible workflow for each
category, not against test breadth or implementation quality. The completeness
reference files under `completeness/` define the category scope and
any surface-specific variation from this default process.

By default, Completeness measures how fully OpenClaw exposes the intended
surface capability set to the user, operator, author, or maintainer persona for
that surface. Score whether each category delivers the full expected workflow,
including setup, normal use, status or inspection, recovery, and important
platform, provider, channel, security, or lifecycle variants where they apply.

Treat `Surface-Specific Scoring Questions` and `Surface-Specific Guidance` as
higher-priority instructions for that surface. The surface instructions may
flesh out, narrow, or intentionally conflict with the default ideas here; when
they do, follow the surface instructions and make the score rationale reflect
that surface-specific instruction. If a reference file does not include
surface-specific questions or guidance, apply this default process to the
surface's `Category Scope`.

For each category, ask:

- Can the intended user or operator complete the category workflow end to end?
- Are the taxonomy features present as supported capabilities rather than
  isolated implementation fragments?
- Are the important lifecycle stages represented: setup, normal operation,
  status/inspection, recovery, and upgrade or removal where relevant?
- Are the important environment, provider, platform, channel, or security
  branches present for this surface?
- Do the known gaps leave major user-visible capability branches missing?

Default guidance:

- Favor higher Completeness when the category supports the full
  operator-visible workflow described by taxonomy and category evidence.
- Lower Completeness when only the happy path exists, when important variants
  are undocumented or unimplemented, or when recovery/status paths are missing.
- Do not lower Completeness because tests are thin; that is Coverage.
- Do not lower Completeness because implementation quality is fragile; that is
  Quality.

Default Completeness bands:

- `Clawesome` (95-100): complete across expected workflows, variants, and
  recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only
  bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery
  paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete
  some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended
  capability.
