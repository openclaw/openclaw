# QA Scenarios

Seed QA assets for the private `qa-lab` extension.

Files:

- `scenarios.md` - canonical QA scenario pack, kickoff mission, and operator identity.
- `frontier-harness-plan.md` - big-model bakeoff and tuning loop for harness work.

Key workflow:

- `qa suite` is the executable frontier subset / regression loop.
- `qa manual` is the scoped personality and style probe after the executable subset is green.

Keep this folder in git. Add new scenarios here before wiring them into automation.
