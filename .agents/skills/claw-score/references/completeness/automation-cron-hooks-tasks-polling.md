# Automation: cron, hooks, tasks, polling Completeness

Use this rubric when assigning category Completeness scores for the
`automation-cron-hooks-tasks-polling` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes the intended `Automation: cron, hooks, tasks, polling` capability set to the user, operator, author, or maintainer persona for this surface. Score whether each category delivers the full expected workflow, including setup, normal use, status or inspection, recovery, and important platform/provider/channel variants where they apply.

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

- Cron Jobs: Create/edit/remove jobs, Schedule types, Timezone and stagger, Cron RPCs, Agent cron tool, Manual cron runs, Isolated cron execution, Model/provider preflight, Run history, Timeout and denial diagnostics, Chat announce delivery, Webhook delivery, Failure destinations, Skipped-run alerts, Delivery previews
- Event Ingress: Telegram long polling, Telegram webhook mode, Zalo polling/webhook mode, Polling stall diagnostics, iMessage watch fallback, Gmail setup wizard, Watcher start/serve, Tailscale/public routing, Push token validation, Gmail event routing, POST /hooks/wake, POST /hooks/agent, Mapped hooks, Hook auth policy, Async dispatch
- Automation Hooks: HOOK.md authoring, Hook discovery, Hook CLI management, Hook packs, Lifecycle event dispatch, api.on registration, Tool-call policy hooks, Message hooks, Session/lifecycle hooks, Plugin approval requests, cron_changed
- Background Tasks and Flows: Task list/show/cancel, Task notifications, Task audit and maintenance, Chat task board, Task pressure status, Managed flows, Mirrored flows, openclaw tasks flow, Flow audit and maintenance, Plugin managedFlows
- Heartbeat: Heartbeat scheduling, Active hours, Wake and cooldown handling, Due-only heartbeat tasks, Commitment check-ins
- Polling Controls: openclaw message poll, Telegram polls, Teams polls, Poll flags, Channel capability gates, process poll, process log, Background process status, No-progress loop detection, Process input controls

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
