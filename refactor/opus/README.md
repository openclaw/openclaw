# Agent Execution Layer Refactoring

**Branch:** `refactor/agent-execution-layer`
**Status:** Planning Complete - Ready for Implementation

---

## Quick Start

To continue working on this refactoring:

1. Check current progress in [01-CHECKLIST.md](./01-CHECKLIST.md)
2. Find the next incomplete phase
3. Copy the handoff prompt from [02-HANDOFFS.md](./02-HANDOFFS.md)
4. Start a new conversation and paste the prompt

---

## Documents

| File                                 | Purpose                                      |
| ------------------------------------ | -------------------------------------------- |
| [00-PLAN.md](./00-PLAN.md)           | Complete implementation plan with all phases |
| [01-CHECKLIST.md](./01-CHECKLIST.md) | Work tracking checklist (update as you work) |
| [02-HANDOFFS.md](./02-HANDOFFS.md)   | Detailed prompts for each phase handoff      |

---

## Phase Summary

| Phase | Name                 | Description                              |
| ----- | -------------------- | ---------------------------------------- |
| 0     | Foundation           | Types, directory structure, feature flag |
| 1     | Event Router         | Canonical event schema and routing       |
| 2     | State Service        | Session persistence extraction           |
| 3     | Runtime Resolver     | Unified runtime selection                |
| 4     | Turn Executor        | Execution and normalization              |
| 5     | Execution Kernel     | Full orchestration layer                 |
| 6     | CLI Migration        | First entry point migration              |
| 7     | Auto-Reply Migration | Main messaging path                      |
| 8     | Remaining Migrations | Followup, Cron, Hybrid Planner           |
| 9     | Cleanup              | Remove old code, feature flag            |

---

## Design Documents

The underlying design is documented in:

- [01-agent-execution-layer.md](../../docs/design/plans/opus/01-agent-execution-layer.md) - Main design
- [02-observable-pipeline-abstraction.md](../../docs/design/plans/opus/02-observable-pipeline-abstraction.md) - Pipeline framework
- [03-dependency-injection-container.md](../../docs/design/plans/opus/03-dependency-injection-container.md) - DI container

---

## Target Architecture

```
Entry Points (thin)
       │
       ▼
ExecutionKernel (orchestration)
       │
       ├── RuntimeResolver (runtime selection)
       ├── TurnExecutor (execution + normalization)
       ├── StateService (persistence)
       └── EventRouter (observability)
```

---

## Success Criteria

1. All entry points use `ExecutionKernel.execute()`
2. Zero behavioral regressions
3. Entry point code reduced by 70%+
4. Single place to fix runtime selection bugs
5. Consistent events across all execution modes
