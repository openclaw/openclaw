# Gateway Runtime Completeness

Use this rubric when assigning category Completeness scores for the
`gateway-runtime` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended gateway runtime
capability to operators and connected clients. This is not test coverage and
not implementation quality. Score whether the category delivers the full
operator-visible workflow, including the major modes and recovery paths that a
real deployment expects.

## Scoring Questions

For each category, ask:

- Does the category cover the main happy path an operator or client needs?
- Are the major deployment modes present where they matter for this category:
  local, remote, node-mediated, supervised, or browser-facing?
- Are the main lifecycle stages present where relevant: setup, normal use,
  status/inspection, and recovery?
- Are important security or policy branches present where the category implies
  them?
- Are obvious operator-visible holes or "not yet supported" branches still
  missing?

## Surface-Specific Guidance

- Favor higher Completeness only when the category supports the full operator
  journey, not just a protocol primitive or one transport path.
- Lower Completeness when only the core path exists but important branches are
  missing, such as remote versus local differences, supervised lifecycle
  behavior, approval/policy variants, or recovery/diagnostic paths.
- Do not lower Completeness just because tests are thin; that is Coverage.
- Do not lower Completeness just because the implementation is fragile; that is
  Quality.

## Suggested Bands

- `Lovable` (95-100): complete across all expected operator/client modes, with
  only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only
  bounded missing branches.
- `Beta` (70-80): the main workflows exist, but some meaningful branches or
  recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can do core
  tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended
  capability.
