# Governed Agents for OpenClaw

> **The problem no one had solved:** AI sub-agents could claim "success" — and no one would know they lied.

## The Problem

When you use `sessions_spawn` to delegate a task to a sub-agent (Codex, Claude, etc.), you trust it to:

1. Actually complete the task
2. Deliver what it promised
3. Tell you honestly if it couldn't

In practice, sub-agents hallucinate success. They report "done" when files are missing, tests fail, or nothing was implemented. There was no independent verification layer — until now.

## The Solution

**Governed Agents** wraps every sub-agent task in a three-layer accountability system:

```
┌─────────────────────────────────────────────────┐
│  1. TASK CONTRACT                                │
│     Define objective + acceptance criteria       │
│     BEFORE spawning the agent                    │
├─────────────────────────────────────────────────┤
│  2. VERIFICATION GATES (automatic)               │
│     Files → Tests → Lint → AST Syntax            │
│     Runs independently after agent completion    │
├─────────────────────────────────────────────────┤
│  3. REPUTATION LEDGER (persistent)               │
│     Per-model score. Hallucinated success = -1.0 │
│     Tracks reliability over time                 │
└─────────────────────────────────────────────────┘
```

## Score Matrix

| Outcome              | Score    | When                                    |
| -------------------- | -------- | --------------------------------------- |
| Verified success     | **+1.0** | Agent delivered AND verification passed |
| Hallucinated success | **−1.0** | Agent claimed done, verification failed |
| Honest blocker       | **+0.5** | Agent reported it couldn't proceed      |
| Failure              | **0.0**  | Task not completed                      |

## Quick Start

**Step 1 — Install:**

```bash
bash skills/governed-agents/install.sh
```

**Step 2 — Create a contract and spawn:**

```python
from governed_agents.orchestrator import GovernedOrchestrator

g = GovernedOrchestrator.for_task(
    objective="Add rate limiter to API",
    model="openai/gpt-5.2-codex",
    criteria=["api/rate_limiter.py exists", "pytest tests/test_rate_limiter.py passes"],
    required_files=["api/rate_limiter.py", "tests/test_rate_limiter.py"],
    run_tests="pytest tests/test_rate_limiter.py -v",
)

# Pass g.instructions() as the task to sessions_spawn
# After completion:
result = g.record_success()
```

**Step 3 — Verify:**

```bash
python3 ~/.openclaw/workspace/governed_agents/test_verification.py
# 🏆 ALL VERIFICATION GATE TESTS PASS
```

## Verification Gates

| Gate           | Configured by            | Behavior on fail           |
| -------------- | ------------------------ | -------------------------- |
| **Files**      | `required_files=[...]`   | score = −1.0               |
| **Tests**      | `run_tests="pytest ..."` | score = −1.0               |
| **Lint**       | `run_lint=True`          | graceful skip if no linter |
| **AST Syntax** | `check_syntax=True`      | score = −1.0               |

## No External Dependencies

Pure Python stdlib: `sqlite3`, `subprocess`, `ast`, `glob`, `shlex`, `pathlib`. Requires `git` for install.
Works on Python 3.10+.

## Why This Matters

Every production system that delegates work to AI agents faces this problem. An agent that reports false success is worse than one that reports failure — it silently corrupts your system while you believe everything is fine.

Governed Agents makes this impossible. The verification runs independently of the agent's self-report. If the files aren't there, the tests don't pass, or the syntax is broken — the score is −1.0, and the reputation ledger records it permanently.

Accountability, not trust.
