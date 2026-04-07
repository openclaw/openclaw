# QA Scenarios

Seed QA assets for the private `qa-lab` extension.

Files:

- `QA_KICKOFF_TASK.md` - operator prompt for the QA agent.
- `frontier-harness-plan.md` - big-model bakeoff and tuning loop for harness work.
- `seed-scenarios.json` - repo-backed baseline QA scenarios.

Key workflow:

- `qa suite` is the executable frontier subset / regression loop.
- `qa manual` is the scoped personality and style probe after the executable subset is green.

Keep this folder in git. Add new scenarios here before wiring them into automation.
