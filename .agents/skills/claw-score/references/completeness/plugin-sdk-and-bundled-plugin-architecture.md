# Plugin Surface Completeness

Use this rubric when assigning category Completeness scores for the
`plugin-sdk-and-bundled-plugin-architecture` surface.

## What Completeness Means Here

Completeness measures how fully a plugin author or operator can complete the
intended plugin lifecycle for the category: authoring, packaging, installing,
running, approving, publishing, or testing plugins. Score whether OpenClaw
supports the full capability set a plugin builder or operator expects, not just
the underlying SDK or runtime primitives.

## Scoring Questions

For each category, ask:

- Can the intended plugin task be completed end to end by an author or
  operator?
- Are the important plugin variants present for this category, such as channel,
  provider, tool, bundled, local, npm, or ClawHub flows?
- Are the main lifecycle stages present where relevant: create, configure,
  validate, run, update, and remove or roll back?
- Are compatibility, approval, or safety branches present when the category
  implies them?
- Are important author/operator-visible gaps still forcing workarounds or
  unsupported paths?

## Surface-Specific Guidance

- Favor higher Completeness when the category supports the full plugin journey,
  not only one import path, one packaging mode, or one runtime path.
- Lower Completeness when a category works only for bundled plugins or only for
  selected plugin families while the category implies a broader capability.
- Publishing and testing categories should include the expected lifecycle
  support, not just raw commands or fixtures.
- Do not use missing tests to lower Completeness; that is Coverage.
- Do not use fragility or regressions to lower Completeness; that is Quality.

## Suggested Bands

- `Lovable` (95-100): the category supports the full intended plugin lifecycle
  across the expected plugin variants.
- `Stable` (80-95): most author/operator workflows exist, with only bounded
  missing branches.
- `Beta` (70-80): the main workflows exist, but notable lifecycle branches or
  plugin variants are still missing.
- `Alpha` (50-70): only a partial plugin capability set is available.
- `Experimental` (0-50): the category exposes early or fragmentary support only.
