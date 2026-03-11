"""
nox.pitcrew.verify â€” Task completion verification
Run verify commands, check file existence, validate outputs.
"""
import subprocess
import os
import time
from dataclasses import dataclass
from typing import Optional
from .task import Task, TaskState


@dataclass
class VerifyResult:
    task_id: str
    passed: bool
    method: str  # 'command', 'file', 'import', 'manual'
    output: str = ""
    elapsed: float = 0.0
    error: str = ""


class Verifier:
    """Verify task completion via commands, file checks, or imports."""

    def __init__(self, python: str = "python"):
        self.python = python
        self.results: list = []

    def verify(self, task: Task) -> VerifyResult:
        """Run verification for a task."""
        t0 = time.time()

        if task.verify_cmd:
            result = self._verify_command(task)
        elif self._looks_like_file_task(task):
            result = self._verify_file(task)
        elif self._looks_like_import_task(task):
            result = self._verify_import(task)
        else:
            result = VerifyResult(
                task_id=task.id,
                passed=task.state == TaskState.DONE,
                method='state',
                output=f"State: {task.state.value}",
            )

        result.elapsed = time.time() - t0
        self.results.append(result)

        if result.passed:
            task.finish(result.output[:200])
        else:
            task.state = TaskState.VERIFYING  # Needs attention

        return result

    def _verify_command(self, task: Task) -> VerifyResult:
        """Run a shell command to verify."""
        try:
            r = subprocess.run(
                task.verify_cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=30,
            )
            return VerifyResult(
                task_id=task.id,
                passed=r.returncode == 0,
                method='command',
                output=r.stdout[:500],
                error=r.stderr[:500] if r.returncode != 0 else "",
            )
        except subprocess.TimeoutExpired:
            return VerifyResult(
                task_id=task.id, passed=False, method='command',
                error="Timeout (30s)",
            )
        except Exception as e:
            return VerifyResult(
                task_id=task.id, passed=False, method='command',
                error=str(e),
            )

    def _verify_file(self, task: Task) -> VerifyResult:
        """Check if output file exists."""
        # Extract file path from description
        desc = task.description
        for token in desc.split():
            if ('/' in token or '\\' in token) and '.' in token:
                path = token.strip('`"\'(),')
                exists = os.path.exists(path)
                return VerifyResult(
                    task_id=task.id,
                    passed=exists,
                    method='file',
                    output=f"{path}: {'exists' if exists else 'NOT FOUND'}",
                )
        return VerifyResult(
            task_id=task.id, passed=False, method='file',
            error="No file path found in description",
        )

    def _verify_import(self, task: Task) -> VerifyResult:
        """Try to import a Python module."""
        desc = task.description.lower()
        # Extract module name
        for token in desc.split():
            if '.' in token and not token.startswith('http'):
                module = token.strip('`"\'()')
                try:
                    r = subprocess.run(
                        [self.python, '-c', f'import {module}; print("OK")'],
                        capture_output=True, text=True, timeout=10,
                    )
                    return VerifyResult(
                        task_id=task.id,
                        passed=r.returncode == 0,
                        method='import',
                        output=r.stdout.strip(),
                        error=r.stderr[:200] if r.returncode != 0 else "",
                    )
                except Exception as e:
                    return VerifyResult(
                        task_id=task.id, passed=False, method='import',
                        error=str(e),
                    )
        return VerifyResult(
            task_id=task.id, passed=False, method='import',
            error="No module found in description",
        )

    def _looks_like_file_task(self, task: Task) -> bool:
        d = task.description.lower()
        return any(w in d for w in ['file', 'create', 'write', 'generate', '.py', '.md', '.json'])

    def _looks_like_import_task(self, task: Task) -> bool:
        d = task.description.lower()
        return any(w in d for w in ['import', 'module', 'verify', 'exports'])

    def summary(self) -> dict:
        passed = sum(1 for r in self.results if r.passed)
        return {
            'total': len(self.results),
            'passed': passed,
            'failed': len(self.results) - passed,
            'rate': f"{passed/max(len(self.results),1)*100:.0f}%",
        }
