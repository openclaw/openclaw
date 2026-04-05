---
name: dynamic-sandbox
description: Isolated code execution environment with Docker/subprocess backends, static safety validation, and a Voyager-pattern skill library for persisting successful executions as reusable tools.
metadata:
  openclaw:
    emoji: "📦"
    category: tools
---

# Dynamic Sandbox

Secure code execution + persistent skill library (`src/tools/dynamic_sandbox.py`).

## Architecture

```
DynamicSandbox
├── Code Validation (static safety checks)
│   └── Blocks: os.system, subprocess, eval, exec, imports of unsafe modules
├── Execution Backends
│   ├── Docker (preferred) — isolated container, resource limits
│   └── Subprocess (fallback) — tempfile + timeout
├── Skill Library (Voyager pattern)
│   ├── Save successful executions as reusable skills
│   ├── Retrieve by name or search
│   └── Track success/fail counts per skill
└── Result → SandboxResult(success, exit_code, stdout, stderr, elapsed_sec)
```

## Core API

```python
sandbox = DynamicSandbox()

# Execute code
result = await sandbox.execute("print('hello')", language="python", timeout=30)

# Save as reusable skill
if result.success:
    sandbox.save_as_skill("hello_printer", "Prints hello", result, code="print('hello')")

# Execute saved skill
result = await sandbox.execute_skill("hello_printer")

# List all skills
skills = sandbox.skill_library.list_skills()
```

## Safety Validation

Before execution, `validate_code()` checks for:

- Dangerous imports (os, subprocess, shutil, socket)
- Dangerous calls (system, exec, eval, open with 'w')
- Network operations (requests, urllib, socket)
- Shell injection patterns

Rejected code returns `SandboxResult(exit_code=-2, method="validation")`.

## Skill Library (Voyager Pattern)

Based on arXiv:2305.16291 (Voyager: LLM-Powered Agent).

| Field           | Description                |
| --------------- | -------------------------- |
| `skill_id`      | UUID                       |
| `name`          | Human-readable identifier  |
| `description`   | What the skill does        |
| `code`          | Source code to execute     |
| `language`      | python / bash / javascript |
| `success_count` | Executions that succeeded  |
| `fail_count`    | Executions that failed     |

Skills stored in `data/local_skills/` (currently scaffolded but empty — populated at runtime via `save_as_skill()`).

## Integration

- **Coder / Executor roles**: generate code → sandbox validates + runs → results fed back
- **Test_Writer**: generated tests executed in sandbox
- **Reflexion**: failed sandbox runs trigger self-reflection → revised code → retry
- **Pipeline**: DynamicSandbox instance held by PipelineExecutor
