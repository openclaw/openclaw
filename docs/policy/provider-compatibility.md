---
summary: "Support tiers and risk boundaries for provider integrations"
title: "Provider compatibility policy"
---

# Provider compatibility policy

This policy defines how provider integrations are categorized and documented.

## Support tiers

## Tier 1 — Officially supported
- Maintained in core docs and release flow
- Covered by tests/validation expectations
- Eligible for normal issue support

## Tier 2 — Community-supported (use with caution)
- May work reliably for some users
- Not guaranteed across releases
- Limited/no maintainer support commitment

## Tier 3 — Not recommended
- Conflicts with legal/ToS/security expectations, or
- Requires fragile/unsafe workarounds

## Evaluation criteria

A provider/path is evaluated on:
- Technical reliability
- Security posture
- Terms-of-service/legal clarity
- Maintenance burden
- User safety and supportability

## PR acceptance guidance (provider-related)

Maintainers should require:
- Clear auth model and token handling
- No bypass of existing safeguards
- Explicit risk notes in docs
- Testability or clear validation plan
- Legal/ToS compatibility statement where relevant

If legal/ToS status is unclear, prefer Tier 2 labeling or decline.

## Documentation requirements

Provider docs should always include:
- Support tier label
- Known limitations
- Upgrade/breakage risk note
- Rollback instructions

## User-facing defaults

- Recommend Tier 1 by default
- Present Tier 2 as experimental
- Avoid recommending Tier 3 paths
