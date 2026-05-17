# Requirements — Agent Skills format interop

## Outcome

The 50+ skills under `skills/*` are loadable as Anthropic Agent Skills (the SKILL.md format used by Claude.ai, Claude Code, and the Claude Agent SDK) without losing openclaw-specific install metadata. Operators can also load external Agent Skills packages (Anthropic-hosted or third-party) into the openclaw runtime through the same skills mechanism that already exists.

## Users affected

- Skill authors — current SKILL.md frontmatter shape differs slightly from Anthropic's spec.
- Operators who use Claude.ai or Claude Code alongside openclaw and want to share skills.
- Skills runtime — `src/plugins/discovery.ts`, `src/plugins/`, `clawhub` registry, `openclaw configure --section skills`.

## In scope

- Adopt Anthropic's Agent Skills SKILL.md spec as the canonical shape: `name`, `description`, optional `metadata`. Keep openclaw-specific install hints under a namespaced key (`metadata.openclaw`) so the spec stays compliant.
- Bidirectional loader: read both old and new shapes; new writes use the canonical shape.
- Optional `allowed_tools` field reading — when present, skill discovery feeds the existing tool-policy `allow` list.
- Import path: `openclaw skills import <path-or-url>` loads an Anthropic-shape skill bundle into the operator's workspace skills directory.
- Export path: `openclaw skills export <name>` emits a tarball matching the Anthropic Agent Skills file layout.
- Doctor migration: detect old-shape skills and suggest migration (do not auto-rewrite — risk of breaking custom metadata).

## Out of scope

- Replacing or removing the `clawhub` registry — interop is additive.
- Hosting an alternative skills registry.
- Skills that depend on Claude.ai-specific runtime APIs we don't have (those skip discovery with a clear log).
- Auto-migration of existing skills' frontmatter — manual migration via doctor hint.

## Decisions

- Keep `metadata.openclaw` as a namespaced extension. Reason: complies with Anthropic's spec while preserving install metadata (`requires.bins`, `install` arrays).
- New skills authored in canonical shape; old ones still load. Reason: avoid churn while maintaining interop.
- Allowed-tools fed into the existing policy machinery rather than a parallel system. Reason: single source of truth for tool gating.
