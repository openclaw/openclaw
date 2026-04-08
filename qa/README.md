# QA Scenarios

Seed QA assets for the private `qa-lab` extension.

Files:

- `scenarios.md` - canonical QA scenario pack, kickoff mission, and operator identity.
- `frontier-harness-plan.md` - big-model bakeoff and tuning loop for harness work.
- `local-coding-agents.md` - local OpenClaw coding-agent bootstrap and selftest workflow.
- `seed-scenarios.json` - repo-backed baseline QA scenarios.

Key workflow:

- `qa suite` is the executable frontier subset / regression loop.
- `qa manual` is the scoped personality and style probe after the executable subset is green.
- `pnpm qa:local-agents:bootstrap` upserts the local coding-agent profiles into `~/.openclaw`.
- `pnpm qa:local-agents:selftest` runs the local end-to-end coding stack check, with optional GitHub and WhatsApp live verification.

Keep this folder in git. Add new scenarios here before wiring them into automation.
