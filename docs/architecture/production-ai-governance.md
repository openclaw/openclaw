---
summary: "Lightweight production AI governance checklist for OpenClaw architecture changes"
read_when:
  - Adopting external AI architecture advice for OpenClaw
  - Adding evaluation, replay, tracing, cost, or agent context governance
  - Reviewing whether an AI system change needs a larger architecture project
title: "Production AI governance"
---

OpenClaw already has several production AI building blocks: scoped
`AGENTS.md` files, workspace skills, memory search, provider replay policies,
diagnostic traces, session usage accounting, plugin lifecycle traces, channel
routing, and QA lanes. Use this page when an external production AI checklist
or architecture diagram looks useful, but the right answer is governance and
verification rather than a repo-wide rewrite.

The default stance is lightweight adoption:

- Strengthen existing OpenClaw contracts before adding new layers.
- Prefer evidence, replay, and targeted docs over broad directory reshuffles.
- Keep core extension-agnostic; owner-specific behavior stays in the owning
  plugin, channel, or provider.
- Do not change live config, credentials, provider defaults, channel defaults,
  or runtime services as part of this pass.

## Adoption matrix

| External layer                                  | OpenClaw mapping                                                                                           | Decision                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| App entry and config                            | Gateway, CLI, Control UI, typed config docs                                                                | Adapt through existing docs and config contracts                                 |
| Retrieval and memory                            | [Memory search](/concepts/memory-search), memory backends, QMD/session search                              | Adopt source and scope requirements; do not add a new retrieval stack by default |
| Services and routing                            | [Agent loop](/concepts/agent-loop), [Channel routing](/channels/channel-routing), provider/runtime helpers | Adapt through existing owner boundaries                                          |
| Prompt and agent context                        | [System prompt](/concepts/system-prompt), scoped `AGENTS.md`, [Skills](/tools/skills), workspace files     | Adopt as task contracts and scoped context, not hardcoded prompts                |
| Agents and tools                                | Agent runtime hooks, plugin hooks, tools, subagents                                                        | Adapt with documented hook points; avoid hidden contract bypasses                |
| Security guards                                 | Gateway security, tool policy, exec approvals, sandboxing, hooks                                           | Adapt; fix the core path first unless the surface is high risk                   |
| Evaluation                                      | Unit tests, replay tests, QA lanes, live tests                                                             | Adopt a minimum golden and replay contract for high-risk paths                   |
| Observability and cost                          | Diagnostics, stability events, traces, session usage, `/usage`, `/status`                                  | Adopt a stage-level checklist before adding new telemetry backends               |
| Data boundaries                                 | Memory roots, session stores, external artifacts such as cron task ledgers and command lane snapshots      | Adapt via explicit snapshot or artifact boundaries                               |
| Docs and coding agent context                   | Docs read hints, scoped `AGENTS.md`, skills, repo rules                                                    | Adopt; keep guidance discoverable and scoped                                     |
| Semantic cache, query rewriter, adaptive router | No default adoption                                                                                        | Defer until cost or quality evidence proves the need                             |
| Repo-wide folder structure                      | Existing OpenClaw layout and owner boundaries                                                              | Reject as-is                                                                     |

## Minimum evaluation contract

Any high-risk AI pipeline should have at least one executable or documented
golden case for each relevant behavior below. Link to existing tests when they
already cover the behavior; do not invent a parallel test harness only to match
an external checklist.

- **Memory retrieval:** results preserve source, scope, and degraded-mode
  behavior. A memory failure should not silently become unscoped context.
- **Provider and tool replay:** replay preserves transcript bytes and tool
  results unless a documented repair path intentionally rewrites them.
- **Channel routing:** every configured inbound surface is named separately.
  DMs, groups, channels, threads, mentions, slash commands, webhooks, and
  native command delivery are distinct surfaces when the config exposes them.
- **Agent context:** scoped `AGENTS.md`, workspace files, skills, and memory
  rules are loaded through the documented prompt/context path.
- **Cost and context growth:** unusually large token, context, or cache-read
  changes can be traced back to a session, model, provider, or stage.

Use [Testing](/help/testing) for regular suite selection and QA commands.

## Observability checklist

Before a high-risk pipeline change is considered production-ready, an operator
should be able to answer these questions from existing logs, diagnostics,
session metadata, or test artifacts:

- Which stage failed or produced the surprising output?
- Which session, agent, model, provider, channel, and inbound surface were
  involved?
- What input and output summaries are safe to inspect without exposing raw
  payloads or credentials?
- Are token, cache, and cost changes attributable to a stage or provider?
- Can user feedback, a support report, or a diagnostics bundle be linked back
  to the relevant run?
- Is the failure mode covered by a targeted test, replay, QA scenario, or live
  smoke?

Start with existing surfaces such as diagnostics export, stability events,
session usage, cache traces, plugin lifecycle traces, and provider replay tests.
Add a new telemetry backend only after this checklist shows an actual gap.

## Agent context boundaries

The coding-agent context layer maps to OpenClaw's existing scoped context
system:

- Repo rules live in `AGENTS.md` and scoped `AGENTS.md` files.
- Agent persona and workspace memory live in the agent workspace, not in repo
  docs.
- Skills provide reusable operating procedures and should stay scoped to the
  agent or plugin that needs them.
- System prompt changes must go through the documented prompt assembly path.
- Multi-agent or multi-persona setups need separate workspaces and agent state;
  do not rely on `agentId` alone to isolate persona, memory, or auth behavior.

When a new channel, plugin, agent, or automation surface is added, document the
inbound surfaces it exposes and the context sources it is allowed to load.

## Stop rules

Stop this lightweight adoption path and open a separate architecture project if
the change requires any of the following:

- Public SDK or Gateway protocol changes.
- Provider defaults, channel defaults, credential handling, or live config
  mutation.
- A new telemetry backend, database, queue, or external service.
- Moving owner-specific extension behavior into core without evidence that
  multiple owners need a generic seam.
- Semantic cache, query rewriting, or adaptive routing without concrete cost,
  quality, or reliability evidence.
- Repo-wide folder or package restructuring.

## Verification entry points

For docs-only governance changes, use:

```bash
pnpm docs:list
git diff --check
```

If trace, cost, replay, routing, or runtime code changes are made, run the
smallest targeted test that covers the touched surface first. Escalate to
`pnpm check:changed` when shared runtime, config, protocol, or public contract
behavior changes.

## Related

- [Gateway architecture](/concepts/architecture)
- [Agent loop](/concepts/agent-loop)
- [System prompt](/concepts/system-prompt)
- [Agent workspace](/concepts/agent-workspace)
- [Memory search](/concepts/memory-search)
- [Channel routing](/channels/channel-routing)
- [Usage tracking](/concepts/usage-tracking)
- [Diagnostics export](/gateway/diagnostics)
- [Testing](/help/testing)
