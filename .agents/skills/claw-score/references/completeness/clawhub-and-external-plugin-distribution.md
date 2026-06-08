# ClawHub Completeness

Use this rubric when assigning category Completeness scores for the
`clawhub-and-external-plugin-distribution` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `ClawHub` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

## Scoring Questions

For each category, ask:

- Can the intended user or operator complete the category workflow end to end?
- Are the taxonomy features present as supported capabilities rather than isolated implementation fragments?
- Are the important lifecycle stages represented: setup, normal operation, status/inspection, recovery, and upgrade or removal where relevant?
- Are the important environment, provider, platform, channel, or security branches present for this surface?
- Do the known gaps leave major user-visible capability branches missing?

## Surface-Specific Guidance

- Favor higher Completeness when the category supports the full operator-visible workflow described by taxonomy and the category note evidence.
- Lower Completeness when only the happy path exists, when important variants are undocumented or unimplemented, or when recovery/status paths are missing.
- Do not lower Completeness because tests are thin; that is Coverage.
- Do not lower Completeness because implementation quality is fragile; that is Quality.

## Category Scope

- Publishing: ClawHub package publishing owner, OpenClaw-owned package release validation for ClawHub, Version bump gates, npm trusted publishing provenance, External code plugin package contract required, Skill package metadata, Skill publishing flow
- Catalog Discovery: openclaw plugins search as the ClawHub, Search result metadata, Distinction between plugin search, Catalog lookup failure, Skill catalog search
- Compatibility and Trust: openclaw.compat.pluginApi, ClawHub package compatibility validation, npm compatibility fallback to the newest, Official external plugin catalog behavior, Compatibility docs, Operator trust model for installing, ClawHub archive, npm integrity drift, Built-in dangerous-code scanner, ClawHub publishing review/hidden-release behavior as upstream, Skill archive safety, Skill audit signals
- Plugin Lifecycle: Source prefixes, Bare package behavior during the launch, Explicit pinned versions, Managed install records that preserve source, Codex, Local, Marketplace list, Supported mapped features, Remote marketplace path safety, Update by plugin id, Reinstall vs update semantics, Downgrade, Uninstall config/index/policy/file cleanup, Gateway restart/reload requirements after, ClawHub skill installs, Skill upload install path, Skill dependency installers
- Plugin Health: Per-plugin managed npm project, npm-pack local release-candidate installs, Dependency ownership between plugin packages, Peer dependency relinking, Legacy dependency root cleanup, plugins list, Local plugin index, Troubleshooting stale config, Runtime verification after Gateway

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
