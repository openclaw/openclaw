# Multi-Agent Orchestration Completeness

Use this rubric when assigning category Completeness scores for the
`multi-agent-orchestration` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw supports multiple coordinated agents
as an operator-facing system. Score whether each category delivers setup,
isolation, conversation routing, account routing, specialist lanes, delegate
identity, status, recovery, and safe defaults.

## Scoring Questions

For each category, ask:

- Can an operator configure and run the category workflow end to end?
- Are the taxonomy features present as supported user paths rather than partial config fragments?
- Are setup, normal operation, status or inspection, recovery, and removal paths represented where relevant?
- Are channel, account, workspace, auth, task, and delegate variants covered where the category expects them?
- Do known gaps leave major coordination or isolation branches missing?

## Surface-Specific Guidance

- Favor higher Completeness when multiple agents can be created, isolated, routed, delegated, and inspected without implicit cross-agent leakage.
- Lower Completeness when a category depends on undocumented config, lacks deterministic routing, or cannot explain who owns state, credentials, and outbound delivery.
- Do not lower Completeness because tests are thin; that is Coverage.
- Do not lower Completeness because implementation quality is fragile; that is Quality.

## Category Scope

- Agent Setup: add agents, agent list/delete, identity files, non-interactive setup, and single-agent default.
- Agent Isolation: workspace separation, state separation, auth separation, session separation, and tool profiles.
- Conversation Routing: agent selection, route precedence, default fallback, peer overrides, and cross-channel examples.
- Account Routing: multi-account setup, account selection, default accounts, account credentials, and delivery targets.
- Specialist Lanes: lane contracts, background handoff, concurrency controls, priority controls, and coordinator handoff.
- Delegate Identities: named delegates, authority model, delegate tiers, identity delegation, and organizational assistants.

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
