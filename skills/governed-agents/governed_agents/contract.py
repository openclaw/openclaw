"""
Task Contracts & Result Schemas for Governed Agents.
Defines the "legal code" between Orchestrator and Sub-Agent.
"""
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
import json
import time
import uuid


class TaskStatus(Enum):
    SUCCESS = "success"
    BLOCKED = "blocked"
    FAILED = "failed"


class BlockerCategory(Enum):
    MISSING_CONTEXT = "missing_context"
    TOOL_FAILURE = "tool_failure"
    AMBIGUOUS_SPEC = "ambiguous_spec"
    LOGIC_ERROR = "logic_error"
    DEPENDENCY_MISSING = "dependency_missing"
    TIMEOUT = "timeout"


@dataclass
class TaskContract:
    """What the agent MUST deliver — defined BEFORE work begins."""
    task_id: str = field(default_factory=lambda: f"TASK-{uuid.uuid4().hex[:8]}")
    objective: str = ""
    acceptance_criteria: list[str] = field(default_factory=list)
    required_files: list = field(default_factory=list)
    run_tests: Optional[str] = None
    run_lint: bool = False
    lint_paths: list = field(default_factory=list)
    check_syntax: bool = True
    constraints: list[str] = field(default_factory=list)
    max_retries: int = 3
    timeout_seconds: int = 120
    # Verification gates
    min_file_size: int = 0           # bytes

    def to_prompt(self) -> str:
        """Convert contract to system prompt injection for the sub-agent."""
        criteria = "\n".join(f"  - {c}" for c in self.acceptance_criteria)
        constraints = "\n".join(f"  - {c}" for c in self.constraints)
        files = "\n".join(f"  - {f}" for f in self.required_files)

        return f"""## TASK CONTRACT (BINDING)

**Task ID:** {self.task_id}
**Objective:** {self.objective}

**Acceptance Criteria:**
{criteria}

**Constraints:**
{constraints}

**Required Output Files:**
{files}

**Retries:** max {self.max_retries} | **Timeout:** {self.timeout_seconds}s

---

## OUTPUT FORMAT (MANDATORY)

You MUST end your work with a JSON block in this EXACT format.
This is not optional. Any other output format will be rejected.

If you SUCCEEDED:
```json
{{
  "task_id": "{self.task_id}",
  "status": "success",
  "files_created": ["list", "of", "files"],
  "evidence": "Brief proof that acceptance criteria are met",
  "commands_run": ["list of commands you executed"]
}}
```

If you are BLOCKED or FAILED:
```json
{{
  "task_id": "{self.task_id}",
  "status": "blocked",
  "blocker_category": "one of: missing_context | tool_failure | ambiguous_spec | logic_error | dependency_missing | timeout",
  "what_failed": "What exactly went wrong",
  "what_i_tried": ["Approach 1", "Approach 2"],
  "what_i_need": "Specific resource or clarification needed to continue",
  "partial_result": "Any partial work done (or null)"
}}
```

CRITICAL RULES:
1. An HONEST blocker report is valued MORE than a fake success.
2. Saying "I need X to continue" is a GOOD outcome — silent failure is the WORST outcome.
3. Do NOT hallucinate success. If tests fail, report it. If files are missing, report it.
4. Your reliability score depends on HONESTY, not success rate.
"""

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "objective": self.objective,
            "acceptance_criteria": self.acceptance_criteria,
            "required_files": self.required_files,
            "run_tests": self.run_tests,
            "run_lint": self.run_lint,
            "lint_paths": self.lint_paths,
            "check_syntax": self.check_syntax,
            "constraints": self.constraints,
            "max_retries": self.max_retries,
            "timeout_seconds": self.timeout_seconds,
        }


@dataclass
class TaskResult:
    """Parsed result from a sub-agent's output."""
    task_id: str = ""
    status: TaskStatus = TaskStatus.FAILED
    # Success fields
    files_created: list[str] = field(default_factory=list)
    evidence: str = ""
    commands_run: list[str] = field(default_factory=list)
    # Blocker fields
    blocker_category: Optional[str] = None
    what_failed: str = ""
    what_i_tried: list[str] = field(default_factory=list)
    what_i_need: str = ""
    partial_result: Optional[str] = None
    # Meta
    objective: Optional[str] = None
    raw_output: str = ""
    parse_success: bool = False
    verification_passed: bool = False
    retry_count: int = 0
    elapsed_seconds: float = 0.0

    @classmethod
    def from_agent_output(cls, raw: str, task_id: str) -> "TaskResult":
        """Parse the JSON block from agent output."""
        result = cls(task_id=task_id, raw_output=raw)

        # Find JSON block in output
        json_str = None
        if "```json" in raw:
            parts = raw.split("```json")
            if len(parts) > 1:
                json_part = parts[-1].split("```")[0].strip()
                json_str = json_part
        elif "{" in raw and "}" in raw:
            # Try to find raw JSON
            start = raw.rfind("{")
            end = raw.rfind("}") + 1
            json_str = raw[start:end]

        if not json_str:
            result.status = TaskStatus.FAILED
            result.what_failed = "NO_JSON_OUTPUT: Agent did not produce required JSON schema"
            return result

        try:
            data = json.loads(json_str)
            result.parse_success = True
            result.status = TaskStatus(data.get("status", "failed"))
            result.files_created = data.get("files_created", [])
            result.evidence = data.get("evidence", "")
            result.commands_run = data.get("commands_run", [])
            result.blocker_category = data.get("blocker_category")
            result.what_failed = data.get("what_failed", "")
            result.what_i_tried = data.get("what_i_tried", [])
            result.what_i_need = data.get("what_i_need", "")
            result.partial_result = data.get("partial_result")
        except (json.JSONDecodeError, ValueError) as e:
            result.status = TaskStatus.FAILED
            result.what_failed = f"INVALID_JSON: {e}"

        return result

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "objective": self.objective,
            "status": self.status.value,
            "parse_success": self.parse_success,
            "verification_passed": self.verification_passed,
            "retry_count": self.retry_count,
            "elapsed_seconds": self.elapsed_seconds,
            "files_created": self.files_created,
            "evidence": self.evidence,
            "blocker_category": self.blocker_category,
            "what_failed": self.what_failed,
            "what_i_need": self.what_i_need,
        }
