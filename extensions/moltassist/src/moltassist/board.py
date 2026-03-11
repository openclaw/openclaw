"""
nox.pitcrew.board â€” Status board for pit crew operations
Real-time tracking of all tasks, agents, and progress.
"""
import time
from typing import List, Dict
from .task import Task, TaskState


class Board:
    """Real-time status board. The charge nurse's clipboard."""

    def __init__(self):
        self.start_time: float = time.time()
        self.log: List[Dict] = []

    def record(self, event: str, task_id: str = "", agent_id: str = "", detail: str = ""):
        self.log.append({
            'time': time.time(),
            'elapsed': round(time.time() - self.start_time, 2),
            'event': event,
            'task': task_id,
            'agent': agent_id,
            'detail': detail[:200],
        })

    def report(self, tasks: List[Task]) -> str:
        """Generate ASCII status board."""
        lines = []
        lines.append("=" * 60)
        lines.append("  PIT CREW STATUS BOARD")
        lines.append(f"  Elapsed: {time.time() - self.start_time:.1f}s")
        lines.append("=" * 60)

        # Summary
        by_state = {}
        for t in tasks:
            s = t.state.value
            by_state[s] = by_state.get(s, 0) + 1
        total = len(tasks)
        done = by_state.get('done', 0)
        pct = done / max(total, 1) * 100

        bar_len = 30
        filled = int(bar_len * done / max(total, 1))
        bar = '#' * filled + '-' * (bar_len - filled)
        lines.append(f"\n  [{bar}] {pct:.0f}% ({done}/{total})")
        lines.append("")

        # By state
        STATE_ICON = {
            'done': '[x]', 'running': '[>]', 'assigned': '[=]',
            'queued': '[ ]', 'failed': '[!]', 'blocked': '[~]',
            'verifying': '[?]',
        }
        for state in ['running', 'assigned', 'verifying', 'failed', 'queued', 'done', 'blocked']:
            state_tasks = [t for t in tasks if t.state.value == state]
            if not state_tasks:
                continue
            lines.append(f"  {state.upper()} ({len(state_tasks)})")
            for t in state_tasks[:10]:  # Cap at 10 per section
                icon = STATE_ICON.get(state, '[ ]')
                agent = f" -> {t.assigned_to}" if t.assigned_to else ""
                elapsed = f" ({t.elapsed:.1f}s)" if t.elapsed > 0 else ""
                desc = t.description[:45]
                lines.append(f"    {icon} {t.id} {desc}{agent}{elapsed}")
            if len(state_tasks) > 10:
                lines.append(f"    ... +{len(state_tasks)-10} more")
            lines.append("")

        # By project
        projects = {}
        for t in tasks:
            p = t.project or "unassigned"
            if p not in projects:
                projects[p] = {'done': 0, 'total': 0}
            projects[p]['total'] += 1
            if t.state == TaskState.DONE:
                projects[p]['done'] += 1

        lines.append("  PROJECTS")
        for p, counts in projects.items():
            pct = counts['done'] / max(counts['total'], 1) * 100
            lines.append(f"    {p}: {counts['done']}/{counts['total']} ({pct:.0f}%)")

        lines.append("")
        lines.append("=" * 60)
        return '\n'.join(lines)

    def to_dict(self, tasks: List[Task]) -> dict:
        total = len(tasks)
        done = sum(1 for t in tasks if t.state == TaskState.DONE)
        failed = sum(1 for t in tasks if t.state == TaskState.FAILED)
        return {
            'elapsed': round(time.time() - self.start_time, 2),
            'total': total,
            'done': done,
            'failed': failed,
            'completion': f"{done/max(total,1)*100:.0f}%",
            'tasks': [t.to_dict() for t in tasks],
            'log_entries': len(self.log),
        }
