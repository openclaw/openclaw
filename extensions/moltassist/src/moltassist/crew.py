"""
nox.pitcrew.crew â€” The charge nurse. Orchestrates everything.

Usage:
    from nox.pitcrew import PitCrew

    crew = PitCrew()
    crew.load("MASTER_SOP.md")
    crew.triage()
    crew.assign()
    crew.execute()
    crew.verify()
    print(crew.report())
"""
import time
import subprocess
import os
import json
from typing import List, Optional, Callable, Dict, Any
from .task import Task, TaskState, TaskPriority
from .manifest import Manifest, load_manifest
from .dispatch import Dispatcher, Agent
from .verify import Verifier, VerifyResult
from .board import Board


class PitCrew:
    """
    F1 pit crew for code operations.
    triage â†’ assign â†’ execute â†’ verify â†’ report
    """

    def __init__(self, python: str = "python", log_path: str = ""):
        self.manifest: Optional[Manifest] = None
        self.dispatcher = Dispatcher()
        self.verifier = Verifier(python=python)
        self.board = Board()
        self.python = python
        self.log_path = log_path
        self._hooks: Dict[str, List[Callable]] = {
            'on_assign': [],
            'on_start': [],
            'on_finish': [],
            'on_fail': [],
        }

    def load(self, source) -> 'PitCrew':
        """Load manifest from file path, markdown string, or dict."""
        if isinstance(source, dict):
            self.manifest = Manifest.from_dict(source)
        elif isinstance(source, str):
            self.manifest = load_manifest(source)
        elif isinstance(source, Manifest):
            self.manifest = source
        else:
            raise TypeError(f"Cannot load manifest from {type(source)}")
        self.board.record('manifest_loaded', detail=self.manifest.title)
        return self

    def hook(self, event: str, fn: Callable):
        """Register a hook: on_assign, on_start, on_finish, on_fail."""
        if event in self._hooks:
            self._hooks[event].append(fn)

    def _fire(self, event: str, **kwargs):
        for fn in self._hooks.get(event, []):
            try:
                fn(**kwargs)
            except Exception:
                pass

    @property
    def tasks(self) -> List[Task]:
        return self.manifest.tasks if self.manifest else []

    def triage(self) -> 'PitCrew':
        """
        Triage: resolve dependencies, unblock ready tasks, sort by priority.
        Like an ER charge nurse â€” assess everything, prioritize, clear the board.
        """
        if not self.manifest:
            raise RuntimeError("No manifest loaded. Call load() first.")

        # Build task lookup
        task_map = {t.id: t for t in self.tasks}

        # Resolve dependencies â€” remove refs to completed tasks
        for task in self.tasks:
            if task.state != TaskState.QUEUED:
                continue
            task.depends_on = [
                dep for dep in task.depends_on
                if dep in task_map and task_map[dep].state != TaskState.DONE
            ]
            if task.depends_on:
                task.state = TaskState.BLOCKED

        # Unblock tasks whose deps are all done
        for task in self.tasks:
            if task.state == TaskState.BLOCKED and not task.depends_on:
                task.state = TaskState.QUEUED

        self.board.record('triage', detail=f"{len(self.manifest.pending)} pending")
        return self

    def assign(self) -> List[tuple]:
        """Assign ready tasks to agents via cavity resonance matching."""
        assignments = self.dispatcher.assign_all(self.tasks)
        for task, agent in assignments:
            self.board.record('assigned', task.id, agent.id,
                              f"{task.description[:40]} -> {agent.agent_type.value}")
            self._fire('on_assign', task=task, agent=agent)
        return assignments

    def execute(self, executor: Optional[Callable] = None) -> 'PitCrew':
        """
        Execute all assigned tasks.
        Default executor runs verify_cmd or marks done.
        Pass custom executor for agent-backed execution.
        """
        for task in self.tasks:
            if task.state != TaskState.ASSIGNED:
                continue

            task.start()
            self.board.record('started', task.id, task.assigned_to)
            self._fire('on_start', task=task)

            try:
                if executor:
                    result = executor(task)
                    if result:
                        task.finish(str(result)[:200])
                    else:
                        task.fail("Executor returned None/False")
                elif task.verify_cmd:
                    r = subprocess.run(
                        task.verify_cmd, shell=True,
                        capture_output=True, text=True, timeout=60,
                    )
                    if r.returncode == 0:
                        task.finish(r.stdout[:200])
                    else:
                        task.fail(r.stderr[:200])
                else:
                    # No verify command â€” mark as needing manual verification
                    task.state = TaskState.VERIFYING

                if task.state == TaskState.DONE:
                    self.board.record('finished', task.id, task.assigned_to,
                                      task.result or '')
                    self._fire('on_finish', task=task)
                    self.dispatcher.release(task.assigned_to)
                elif task.state == TaskState.FAILED:
                    self.board.record('failed', task.id, task.assigned_to,
                                      task.error or '')
                    self._fire('on_fail', task=task)
                    self.dispatcher.release(task.assigned_to)

            except subprocess.TimeoutExpired:
                task.fail("Timeout (60s)")
                self.board.record('timeout', task.id)
                self.dispatcher.release(task.assigned_to)
            except Exception as e:
                task.fail(str(e))
                self.board.record('error', task.id, detail=str(e)[:100])
                self.dispatcher.release(task.assigned_to)

        return self

    def verify(self) -> List[VerifyResult]:
        """Verify all completed/verifying tasks."""
        results = []
        for task in self.tasks:
            if task.state in (TaskState.DONE, TaskState.VERIFYING):
                r = self.verifier.verify(task)
                self.board.record('verified', task.id,
                                  detail=f"{'PASS' if r.passed else 'FAIL'}: {r.output[:60]}")
                results.append(r)
        return results

    def report(self) -> str:
        """Generate status board report."""
        return self.board.report(self.tasks)

    def to_dict(self) -> dict:
        """Full state as dict (for JSON serialization)."""
        return {
            'manifest': self.manifest.summary() if self.manifest else None,
            'dispatcher': self.dispatcher.status(),
            'verifier': self.verifier.summary(),
            'board': self.board.to_dict(self.tasks),
        }

    def save(self, path: str = ""):
        """Save state to JSON."""
        p = path or self.log_path or "pitcrew_state.json"
        with open(p, 'w') as f:
            json.dump(self.to_dict(), f, indent=2)

    def run(self, source=None, executor: Optional[Callable] = None) -> str:
        """
        Full pit stop: load â†’ triage â†’ assign â†’ execute â†’ verify â†’ report.
        One call does everything.
        """
        if source:
            self.load(source)
        self.triage()
        self.assign()
        self.execute(executor)
        self.verify()
        return self.report()
