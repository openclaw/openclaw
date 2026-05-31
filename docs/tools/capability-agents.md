---
summary: "Run native OpenClaw capability agents through Blackboard, signal-hub, and proof events"
read_when:
  - You want to install or inspect native capability agents
  - You are adding a specialist agent that claims Blackboard tickets
  - You are preparing an adapter to run under the Agent OS contract
title: "Capability agents"
---

Capability agents are specialist OpenClaw agents that claim a known family of Blackboard tickets and produce proof artifacts. They are the native reference surface for the Agent OS contract.

Use native capability agents when you want a stable local worker before adding framework adapters.

## Quickstart

Print the built-in capability profiles:

```bash
node scripts/agents/capability-agent-profile.mjs print
```

Check whether the profiles are installed in your OpenClaw config:

```bash
node scripts/agents/capability-agent-profile.mjs check --config ~/.openclaw/openclaw.json
```

Apply or refresh the profiles:

```bash
node scripts/agents/capability-agent-profile.mjs apply --config ~/.openclaw/openclaw.json
```

Restart the full-local stack after applying profiles so `signal-hub` can load the updated agent registry:

```bash
pnpm local:full
pnpm local:full:status
```

## Built-in profiles

| Agent                    | Capability family  | Ticket types                                                                                             |
| ------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `research_agent`         | `research`         | `research`, `web_research`, `private_search`, `knowledge_search`, `citation_answer`                      |
| `browser_ops_agent`      | `browser-ops`      | `browser_ops`, `browser_task`, `web_automation`, `web_qa`, `browser_e2e`, `ui_qa`                        |
| `security_bouncer_agent` | `security-bouncer` | `security`, `security_event`, `security_incident`, `threat_triage`, `secret_scan`, `dependency_advisory` |

Each profile emits an `agent-os.capability.v1` manifest under `params.agentOsCapability` when applied. That manifest is the stable interface future adapters should target.

## Native agent contract

A native capability agent must:

- declare an `agent-os.capability.v1` manifest
- list at least one `capabilityFamily`
- list the ticket types it can claim
- declare sandbox, network, filesystem, and secret policy
- emit `agent-os.proof-event.v1` proof events
- write artifacts with `agent-os.artifact.v1` metadata when it produces files
- end tickets with a terminal state such as `DONE`, `FAILED`, `BLOCKED`, or `ARCHIVED`

See [Agent OS contract](/reference/agent-os-contract) for the field-level reference.

## Blackboard workflow

The default local flow is:

```text
blackboard-cli post -> signal-hub routes -> agent claims -> agent runs -> proof event -> artifact -> ticket DONE
```

Post a low-impact smoke ticket through the full-local helper:

```bash
pnpm local:full:smoke
```

Run the golden Agent OS E2E when you need packageable proof that tickets, routing, proof contracts, artifact metadata, and restart recovery all work together:

```bash
pnpm local:full:golden
```

The command writes `.artifacts/full-local-agent-os-golden-e2e.json` with an `agent-os.artifact.v1` contract and check results.

Inspect recent tickets:

```bash
node scripts/docker/sidecars/blackboard-cli.cjs list
```

Inspect proof:

```bash
node scripts/docker/sidecars/blackboard-cli.cjs proof-list --limit 50
```

## Production readiness

Before adding a new capability agent, decide these boundaries:

- which ticket types it owns
- which tools it can call
- whether it needs network access
- whether it can write to the workspace
- which secrets it can reference
- which actions require approval
- which proof bundle demonstrates success
- how it recovers from restart or timeout

Full-local defaults keep the Docker-published Gateway, bridge, Teams, and Sentinel host ports on `127.0.0.1`, require a Sentinel token for model proxy requests, and leave health endpoints unauthenticated for orchestration. The Windows native bridge only dispatches configured native agents and records host-native dispatch attempts into `proof_events` so native work has the same audit trail as container work.

Prefer a narrow native agent first. Add external framework adapters only after the native contract is stable.

## Related

- [Agent OS contract](/reference/agent-os-contract)
- [Subagents](/tools/subagents)
- [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools)
