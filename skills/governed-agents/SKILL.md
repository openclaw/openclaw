---
name: governed-agents
description: Accountable sub-agent orchestration with task contracts, verification gates, and reputation tracking. Use when spawning Codex or other sub-agents to implement features, fixes, or tasks — ensures agents can't fake success and builds a persistent reputation score per model. Triggers on requests involving sessions_spawn, sub-agent task delegation, or when you need verifiable outcomes from AI sub-agents.
homepage: https://github.com/Nefas11/openclaw-superpowers-workflow
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "requires": { "bins": ["python3"], "python": [">=3.10"] },
      },
  }
---

# Governed Agents

A lightweight system that brings **accountability** to OpenClaw sub-agent orchestration via:

1. **Task Contracts** — define objective + acceptance criteria BEFORE spawning
2. **Verification Gates** — independently check deliverables after completion (Files → Tests → Lint → AST)
3. **Reputation Ledger** — persistent per-model score; hallucinated success → −1.0

## Setup

Run once to install the package into your workspace:

```bash
cd ~/.openclaw/workspace
git clone https://github.com/Nefas11/openclaw-superpowers-workflow governed_agents_src
cp -r governed_agents_src/governed_agents ./governed_agents
rm -rf governed_agents_src
```

No pip dependencies — uses only Python stdlib (sqlite3, subprocess, ast, glob).

## Core Workflow

### 1. Create a contract + spawn

```python
from governed_agents.orchestrator import GovernedOrchestrator

g = GovernedOrchestrator.for_task(
    objective="Add JWT authentication to API",
    model="openai/gpt-5.2-codex",
    criteria=[
        "POST /api/auth/login returns JWT token",
        "Invalid credentials return 401",
        "Tests pass: pytest tests/test_auth.py",
    ],
    required_files=["api/auth.py", "tests/test_auth.py"],
    run_tests="pytest tests/test_auth.py -v",
)

# Use g.instructions() as the task prompt for sessions_spawn
result = sessions_spawn(task=g.instructions(), model="Codex")
```

### 2. Record outcome after completion

```python
# After sub-agent completes:
verification = g.record_success()
# → Verifier automatically checks required_files + runs tests
# → If verification FAILS: score = -1.0, status = "failed" (hallucinated success)
# → If verification PASSES: score = +1.0, status = "success"

# For honest blockers (sub-agent couldn't proceed):
g.record_blocked("Missing API key for external service")
# → score = +0.5 (rewarded for honesty, no verification)

# For failures:
g.record_failure("Task not attempted within timeout")
# → score = 0.0
```

## Verification Gates

Gates run sequentially — first failure stops the chain:

| Gate | Configured by | Pass condition | Skip when |
|------|--------------|---------------|-----------|
| **Files** | `required_files=["path/to/file.py"]` | All files/globs exist | list empty |
| **Tests** | `run_tests="pytest tests/ -v"` | Exit code 0 | not set |
| **Lint** | `run_lint=True, lint_paths=["src/"]` | Exit code 0 | graceful skip if no linter installed |
| **AST** | `check_syntax=True` (default) | All .py files parse without SyntaxError | `check_syntax=False` |

```python
# Full contract example with all gates:
g = GovernedOrchestrator.for_task(
    objective="Refactor payment module",
    model="openai/gpt-5.2-codex",
    criteria=["No regressions", "Lint clean"],
    required_files=["app/payment.py", "tests/test_payment.py"],
    run_tests="pytest tests/test_payment.py -v",
    run_lint=True,
    lint_paths=["app/payment.py"],
    check_syntax=True,   # default
)
```

## Score Matrix

| Outcome | Score | Condition |
|---------|-------|-----------|
| Verified success | **+1.0** | `record_success()` + all gates pass |
| Hallucinated success | **−1.0** | `record_success()` + any gate fails |
| Honest blocker | **+0.5** | `record_blocked("reason")` |
| Failure | **0.0** | `record_failure("reason")` |

## Reputation & Supervision

```python
from governed_agents.reputation import get_agent_stats

stats = get_agent_stats()
for agent in stats:
    print(f"{agent['agent_id']}: {agent['reputation']:.3f} ({agent['supervision']['level']})")
```

| Reputation | Supervision Level |
|-----------|-----------------|
| > 0.8 | Autonomous |
| 0.6 – 0.8 | Standard |
| 0.4 – 0.6 | Supervised |
| < 0.4 | Strict |

## Task History (Dashboard)

If you have the OpenClaw Command Center running, add the governed agents widget to `app.py`:

```python
@app.get("/api/governed/latest")
async def governed_latest(_=Depends(verify_token)):
    from governed_agents.reputation import get_agent_stats, get_task_history
    return {
        "agents": get_agent_stats(),
        "recent_tasks": get_task_history(limit=10)
    }
```

## Anti-Patterns

❌ Spawning without a contract → no verification, no accountability  
❌ Skipping `record_success()` → reputation never updated  
❌ Empty `required_files` → Files gate skipped, agent can claim anything  
❌ Using `record_success()` before checking the sub-agent actually finished  

## File Structure

```
governed_agents/
├── contract.py        # TaskContract dataclass
├── orchestrator.py    # GovernedOrchestrator (for_task, record_*)
├── reputation.py      # SQLite DB, scoring, get_agent_stats()
├── verifier.py        # 4-gate verification pipeline
├── self_report.py     # CLI for sub-agents to self-report
└── test_verification.py  # Unit tests (run to verify install)
```

Verify installation:
```bash
cd ~/.openclaw/workspace
python3 governed_agents/test_verification.py
# Expected: 🏆 ALL VERIFICATION GATE TESTS PASS
```
