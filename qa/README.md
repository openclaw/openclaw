# QA Scenarios

Seed QA assets for the private `qa-lab` extension.

Files:

- `scenarios/index.yaml` - canonical QA scenario pack, kickoff mission, and operator identity.
- `scenarios/<theme>/*.yaml` - one runnable scenario per YAML file.
- `frontier-harness-plan.md` - big-model bakeoff and tuning loop for harness work.
- `convex-credential-broker/` - standalone Convex v1 lease broker for pooled live credentials.

Key workflow:

- `qa suite` is the executable frontier subset / regression loop.
- `qa manual` is the scoped personality and style probe after the executable subset is green.
- `qa coverage` prints the scenario coverage inventory from scenario YAML.

Operator workflows:

- Use the `openclaw-qa-testing` skill for QA Lab live lanes, Convex credential
  pool operations, and WhatsApp live credential setup/replacement.

Keep this folder in git. Add new scenarios here before wiring them into automation.

## Confined repository checkpoint commands

`scripts/qa/repository-checkpoint-admission.ts` adapts the product-owned checkpoint
and publication command planners to a campaign Git boundary. It admits only the
canonical bare checkpoint initialization, checkpoint Git-directory query, and
read-only publication config probes. All other commands return `false`.

The launcher supplies freshly validated `checkpointRoot` (from the repository
workspace store), `nodeRoot` (from the current placement), `campaignRoot`, `cwd`,
`argv` (including `git`), and `env`. Paths must already exist, be canonical, and
remain inside the isolated campaign. The adapter does not discover sessions,
read state databases, authorize transport, sanitize execution environments, or
manage checkpoint contents. Those responsibilities stay with their owners.
Do not turn a denied command into a generic Git write allowance.

Import `admitQaRepositoryCheckpointCommand` or pass the same JSON object on stdin
to `node --import ./scripts/tsx.mjs scripts/qa/repository-checkpoint-admission.ts`.
Freeze the adapter with the campaign tooling; preserve the enclosing sandbox,
environment sanitization, current-owner checks, and decision evidence.
