---
name: governed-agents
description: "Accountable sub-agent orchestration with task contracts, verification gates, and reputation tracking. Prevents hallucinated success in sessions_spawn delegation."
homepage: https://github.com/Nefas11/openclaw-superpowers-workflow
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "requires": { "bins": ["python3", "git"], "python": ">=3.10" },
        "install":
          [
            {
              "id": "governed-agents",
              "kind": "script",
              "script": "skills/governed-agents/install.sh",
              "label": "Install governed-agents",
            },
          ],
      },
  }
---

# Governed Agents

Brings accountability to OpenClaw sub-agent orchestration. Sub-agents that claim
success without delivering are automatically penalized (score −1.0). Honest blockers
are rewarded (+0.5). Reputation persists across sessions.

## Install

```bash
bash skills/governed-agents/install.sh
```

## Core Pattern

```python
from governed_agents.orchestrator import GovernedOrchestrator

# 1. Define the task contract BEFORE spawning
g = GovernedOrchestrator.for_task(
    objective="Add JWT authentication endpoint",
    model="openai/gpt-5.2-codex",
    criteria=[
        "POST /api/auth/login returns JWT token",
        "Invalid credentials return 401",
        "Tests pass: pytest tests/test_auth.py",
    ],
    required_files=["api/auth.py", "tests/test_auth.py"],
    run_tests="pytest tests/test_auth.py -v",
)

# 2. Spawn the sub-agent with g.instructions() as the task prompt
# (use sessions_spawn tool with task=g.instructions())

# 3. After completion — verification runs automatically
result = g.record_success()
# Verifier checks files exist + tests pass + syntax valid
# If anything fails: score = -1.0 (hallucinated success)
```

## Verification Gates

Gates run sequentially — first failure stops the chain and sets score to −1.0.

| Gate  | Config key                      | Skip when            |
| ----- | ------------------------------- | -------------------- |
| Files | `required_files=[...]`          | list empty           |
| Tests | `run_tests="pytest ..."`        | not set              |
| Lint  | `run_lint=True, lint_paths=[.]` | no linter in PATH    |
| AST   | `check_syntax=True` (default)   | `check_syntax=False` |

## Outcome Reporting

```python
# Agent succeeded and verification passed:
g.record_success()                          # score +1.0

# Agent could not proceed (honest):
g.record_blocked("No API key configured")  # score +0.5

# Agent failed:
g.record_failure("Timeout after 300s")     # score 0.0
```

## Reputation

```python
from governed_agents.reputation import get_agent_stats

for agent in get_agent_stats():
    print(agent["agent_id"], agent["reputation"], agent["supervision"]["level"])
```

| Reputation | Supervision |
| ---------- | ----------- |
| > 0.8      | Autonomous  |
| 0.6–0.8    | Standard    |
| 0.4–0.6    | Supervised  |
| < 0.4      | Strict      |

## Verify Installation

```bash
python3 ~/.openclaw/workspace/governed_agents/test_verification.py
```
