# Build Lobster Invaders

```yaml qa-scenario
id: lobster-invaders-build
title: Build Lobster Invaders
surface: workspace
objective: Verify the agent can read the repo, create a tiny playable artifact, and report what changed.
successCriteria:
  - Agent inspects source before coding.
  - Agent builds a tiny playable Lobster Invaders artifact.
  - Agent explains how to run or view the artifact.
docsRefs:
  - docs/help/testing.md
  - docs/web/dashboard.md
codeRefs:
  - extensions/qa-lab/src/report.ts
  - extensions/qa-lab/web/src/app.ts
execution:
  kind: custom
  handler: lobster-invaders-build
  summary: Verify the agent can read the repo, create a tiny playable artifact, and report what changed.
  config:
    prompt: Read the QA kickoff context first, then build a tiny Lobster Invaders HTML game at ./lobster-invaders.html in this workspace and tell me where it is.
```
