---
summary: "Create, revise, and close out Workshop proposals from chat or the CLI"
title: "Chat and CLI authoring"
read_when:
  - You want the agent to create or update a skill from chat
  - You are using /learn to capture recent work
  - You need the openclaw skills workshop commands and flags
---

## Chat

For Workshop authoring, ask the agent for the skill you want; it calls
`skill_workshop` and returns a proposal id. Personal library authoring instead
returns the managed publication receipt described in
[Personal library authoring](/tools/skill-workshop/personal-library).

### Learn from recent work

Use `/learn` to route the current conversation or named sources into the best
matching pending proposal or live skill, creating a skill only when needed:

```text
/learn
/learn docs/runbook.md and https://example.com/guide; focus on recovery
```

With no request, `/learn` asks the agent to distill the reusable workflow from
the current conversation. With a request, the agent treats paths, URLs, pasted
notes, and conversation references as sources while honoring focus, scope, and
naming requirements. It gathers the sources with its existing tools, then calls
`skill_workshop` to revise a matching pending proposal, update a matching live
skill, or create a proposal when neither exists.

The resulting proposal stays `pending`; `/learn` never applies it. Review and
apply it through the normal approval flow or with `openclaw skills workshop`.

When the actual turn supports only personal publication, including paired-node
personal CLI authoring, `/learn` stops without changing a skill. Ask normally
for explicit personal creation if you want to publish a revision, or use the
existing administrator UI or CLI for Workshop proposal review. Personal turns
cannot stage a pending draft.

Create:

```text
Make a skill called morning-catchup that runs my Monday inbox routine.
```

Update an existing Workshop-generated skill:

```text
Update trip-planning to also check seat maps before booking.
```

If a skill used in the current turn proves wrong or incomplete, the agent reads
the live skill and creates a targeted patch proposal. When the complete skill
does not fit the selected model's read budget, the agent can prepare one unique
exact span and review its bounded surrounding context before patching it. A
runtime receipt limits this flow to skills used in that run. Autonomous mode
`off` disables repair, `propose` leaves the patch pending until explicitly
applied, and `auto` scans and applies it immediately. The repaired skill is
loaded by new sessions; the running session keeps its original skill snapshot.

Iterate on a pending proposal:

```text
Show me the morning-catchup proposal.
Revise it to also flag anything marked urgent.
Apply the morning-catchup proposal.
```

Agent-initiated `apply`, `reject`, and `quarantine` run without an additional
approval prompt by default. Set `skills.workshop.approvalPolicy` to `"pending"`
to require operator approval before those actions.

When approval is required, the prompt identifies the proposal id and target
skill, and shows the proposal description, support-file count, and body size.
Approval requests are bounded to finish before the agent tool watchdog. If no
decision arrives before the prompt expires, the lifecycle action does not run:
the proposal stays pending and unchanged. Decide later in the Skill Workshop UI or run
`openclaw skills workshop apply|reject|quarantine <proposal-id>`. Agents should
not retry an expired lifecycle action in a loop.

## CLI

```bash
# Create
openclaw skills workshop propose-create \
  --name morning-catchup \
  --description "Daily inbox catch-up: triage, archive, surface, draft, plan" \
  --proposal ./PROPOSAL.md

# Update an existing Workshop-generated skill
openclaw skills workshop propose-update trip-planning --proposal ./PROPOSAL.md

# List and inspect
openclaw skills workshop list
openclaw skills workshop inspect <proposal-id>

# Revise before approval
openclaw skills workshop revise <proposal-id> --proposal ./PROPOSAL.md

# Run installed plugin evaluators against the exact current draft
openclaw skills workshop evaluate <proposal-id>

# Close out
openclaw skills workshop apply <proposal-id>
openclaw skills workshop reject <proposal-id> --reason "Duplicate"
openclaw skills workshop quarantine <proposal-id> --reason "Needs security review"
```

Every subcommand takes `--agent <id>` (agent context; defaults to
cwd-inferred, then the default agent) and `--json` (structured output).
Proposals and generated skill targets are scoped to the selected agent.
`propose-create`, `propose-update`, and `revise` also take `--goal <text>` and
`--evidence <text>` to record proposal context alongside `--proposal`.
`evaluate` runs through the live Gateway plugin registry, snapshots the current
proposal revision before dispatch, and accepts `--correlation-id <id>` for external
orchestration.
