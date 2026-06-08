# Agent Runtime Completeness

Use this rubric when assigning category Completeness scores for the
`agent-runtime-and-provider-execution` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Agent Runtime` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Agent Turn Execution: Turn startup and runtime choice, Session and run coordination, Abort and terminal outcomes
- External Runtimes and Subagents: External harness selection, CLI runtime aliases, Subagent turns, Runtime recovery
- Hosted Provider Execution: Hosted provider turns, Provider-specific model options, Hosted tool use, Reasoning and cache controls, Hosted streaming and replies
- Local and Self-hosted Providers: Local provider profiles, Tool-capability flags, Timeouts and context windows, Local smoke checks, Local failure handling
- Model and Runtime Selection: Model reference selection, Provider and runtime overrides, Thinking and context settings, Invalid route recovery
- Provider Auth: Login and API-key setup, Auth profile selection, Credential health checks, Auth failover, Provider fallback recovery, Rate-limit and capacity recovery, Missing-key and OAuth guidance, Restart and stale-route recovery, Structured provider diagnostics, Subagent credential propagation
- Streaming and Progress: Streaming replies, Progress visibility
- Tool Calls and Response Handling: Tool-call handling, Usage and response reporting, Failure recovery
- Tool Execution Controls: Tool availability rules, Sandboxed exec behavior, Approval flow, Elevated execution, Tool safety controls, Delegated tool access
## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
