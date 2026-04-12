---
title: "HEARTBEAT.md Template"
summary: "Workspace template for HEARTBEAT.md"
read_when:
  - Bootstrapping a workspace manually
---

# HEARTBEAT.md Template

```markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.

# Optional: Pending-review anti-loop state for long-running delegated tasks

## WorkflowState

- status: active|active-longrun|pending-review|blocked
- stage: <current stage>
- lastConfirmedIntent: <summary>
- lastSuccessfulStage: <stage>
- blockedStage: <stage or none>
- expectedDuration: quick|analytical|heavy
- intentHash: <stable hash for stage+objective+expected output>

## ProgressSignals

- lastSessionUpdatedAt: <iso8601>
- lastTaskEventAt: <iso8601>
- lastTokenGrowthAt: <iso8601>
- lastArtifactChangeAt: <iso8601>

## RecoveryPolicy

- stallWindowMinutes: quick=10, analytical=30, heavy=90
- cooldownHoursPerIntentHash: 6
- maxRecoveryDispatchPerCooldown: 1

## RecoveryDecision

- if no progress across full stall window: enter pending-review
- if same intentHash already in-flight: keep active-longrun, do not redispatch
- if recovery exhausted: ask user with fixed options (continue waiting|revise scope|terminate branch)
```
