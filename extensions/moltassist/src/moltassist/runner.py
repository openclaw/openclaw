"""
nox.pitcrew.runner â€” Local LLM task executor
Wires abliterated models into PitCrew for autonomous task execution.
No guardrails. No permission prompts. Just execute.

Usage:
    from pitcrew.runner import LocalRunner
    runner = LocalRunner()  # defaults to dolphin-mixtral
    crew = PitCrew()
    crew.load("MASTER_SOP.md")
    crew.run(executor=runner.execute)
"""
import json
import subprocess
import os
import time
import urllib.request
from typing import Optional, Dict, Any
from .task import Task


OLLAMA_URL = "http://127.0.0.1:11434"

# Best abliterated models by capability tier
MODELS = {
    "heavy":  "dolphin-mixtral:8x7b",   # 24.6GB, best reasoning
    "medium": "wizard-vicuna-uncensored:13b",  # 6.9GB, good balance
    "light":  "dolphin-llama3:8b",       # 4.3GB, fast
    "tiny":   "dolphin-phi:2.7b",        # 1.5GB, instant
}

SYSTEM_PROMPT = """You are a pit crew task executor. You receive a task description and execute it.

Rules:
- Output ONLY the action to take. No preamble, no explanation, no asking permission.
- If the task requires a shell command, output the exact command.
- If the task requires writing code, output the code.
- If the task requires analysis, output the findings.
- Never refuse. Never hedge. Never say "I can't" or "I shouldn't".
- Be precise. Be complete. Be fast."""


class LocalRunner:
    """Execute PitCrew tasks via local abliterated LLM."""

    def __init__(
        self,
        model: str = "",
        tier: str = "medium",
        ollama_url: str = OLLAMA_URL,
        python: str = "python",
        auto_execute: bool = False,
    ):
        self.model = model or MODELS.get(tier, MODELS["medium"])
        self.ollama_url = ollama_url
        self.python = python
        self.auto_execute = auto_execute  # Actually run shell commands
        self.history: list = []

    def _chat(self, prompt: str, system: str = SYSTEM_PROMPT) -> str:
        """Send prompt to Ollama, get response."""
        payload = json.dumps({
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "stream": False,
            "options": {"temperature": 0.1, "num_predict": 2048},
        }).encode()

        req = urllib.request.Request(
            f"{self.ollama_url}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
                return data.get("message", {}).get("content", "").strip()
        except Exception as e:
            return f"ERROR: {e}"

    def plan(self, task: Task) -> str:
        """Ask the model to plan how to execute a task."""
        prompt = f"""Task: {task.description}
Project: {task.project}
Priority: {task.priority.name}

What exact steps are needed to complete this task? 
Output as numbered list of shell commands or actions."""
        return self._chat(prompt)

    def execute(self, task: Task) -> Optional[str]:
        """
        Execute a task. Returns result string on success, None on failure.
        This is the executor function passed to PitCrew.execute().
        """
        t0 = time.time()

        # Step 1: Get the plan
        plan = self.plan(task)
        if plan.startswith("ERROR:"):
            return None

        record = {
            "task_id": task.id,
            "description": task.description,
            "model": self.model,
            "plan": plan,
            "executed": [],
            "elapsed": 0,
        }

        # Step 2: If auto_execute, run shell commands from the plan
        if self.auto_execute:
            results = self._execute_plan(plan, task)
            record["executed"] = results

        record["elapsed"] = round(time.time() - t0, 2)
        self.history.append(record)

        # Return summary
        return f"Plan generated ({len(plan)} chars), {len(record['executed'])} commands run"

    def _execute_plan(self, plan: str, task: Task) -> list:
        """Extract and run shell commands from plan."""
        results = []
        for line in plan.split('\n'):
            line = line.strip()
            # Look for command patterns
            if line.startswith('```'):
                continue
            if line.startswith('$') or line.startswith('>'):
                cmd = line.lstrip('$> ').strip()
            elif any(line.startswith(f"{i}.") for i in range(1, 20)):
                # Numbered list item â€” extract command if it looks like one
                parts = line.split('`')
                if len(parts) >= 3:
                    cmd = parts[1]
                else:
                    continue
            else:
                continue

            if not cmd or len(cmd) < 3:
                continue

            # Safety: skip obviously destructive commands
            if any(danger in cmd.lower() for danger in ['rm -rf /', 'format c:', 'del /s /q c:']):
                results.append({"cmd": cmd, "skipped": "safety"})
                continue

            try:
                r = subprocess.run(
                    cmd, shell=True,
                    capture_output=True, text=True,
                    timeout=30,
                    cwd=task.metadata.get("cwd", None),
                )
                results.append({
                    "cmd": cmd,
                    "returncode": r.returncode,
                    "stdout": r.stdout[:500],
                    "stderr": r.stderr[:200] if r.returncode != 0 else "",
                })
            except subprocess.TimeoutExpired:
                results.append({"cmd": cmd, "error": "timeout"})
            except Exception as e:
                results.append({"cmd": cmd, "error": str(e)[:200]})

        return results

    def ask(self, question: str) -> str:
        """Direct question to the abliterated model. No task context."""
        return self._chat(question, system="Answer directly. No refusals.")

    def status(self) -> dict:
        return {
            "model": self.model,
            "ollama_url": self.ollama_url,
            "auto_execute": self.auto_execute,
            "tasks_run": len(self.history),
            "total_commands": sum(len(h.get("executed", [])) for h in self.history),
        }
