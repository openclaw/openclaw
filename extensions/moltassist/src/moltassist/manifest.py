"""
nox.pitcrew.manifest â€” Parse SOP/checklist into atomic tasks
Reads MASTER_SOP.md or dict manifests into Task objects.
"""
import re
from typing import List, Dict, Any, Optional
from .task import Task, TaskPriority


def load_manifest(source: str) -> 'Manifest':
    """Load manifest from .md file path or raw markdown string."""
    if source.endswith('.md') or '\\' in source or '/' in source:
        try:
            with open(source, 'r', encoding='utf-8') as f:
                content = f.read()
        except FileNotFoundError:
            raise FileNotFoundError(f"Manifest not found: {source}")
    else:
        content = source
    return Manifest.from_markdown(content)


class Manifest:
    """A project manifest parsed from SOP markdown."""

    def __init__(self):
        self.projects: List[Dict[str, Any]] = []
        self.tasks: List[Task] = []
        self.title: str = ""

    @classmethod
    def from_markdown(cls, md: str) -> 'Manifest':
        """Parse SOP markdown into structured manifest."""
        m = cls()
        lines = md.split('\n')
        current_project = None
        task_counter = 0

        for line in lines:
            line_stripped = line.strip()

            # Title
            if line_stripped.startswith('# ') and not m.title:
                m.title = line_stripped[2:].strip()
                continue

            # Project header
            proj_match = re.match(r'^## PROJECT (\d+):\s*(.+)', line_stripped)
            if proj_match:
                current_project = {
                    'number': int(proj_match.group(1)),
                    'name': proj_match.group(2).strip(),
                    'location': '',
                    'tasks': [],
                }
                m.projects.append(current_project)
                continue

            # Location
            loc_match = re.match(r'^\*\*Location:\*\*\s*(.+)', line_stripped)
            if loc_match and current_project:
                current_project['location'] = loc_match.group(1).strip()
                continue

            # Checklist items â†’ Tasks
            check_match = re.match(r'^- \[([ xX])\]\s*(.+)', line_stripped)
            if check_match and current_project:
                done = check_match.group(1).lower() == 'x'
                desc = check_match.group(2).strip()
                task_counter += 1
                task_id = f"t{task_counter:03d}"
                proj_name = current_project['name']

                task = Task(
                    id=task_id,
                    description=desc,
                    project=proj_name,
                    priority=_infer_priority(desc),
                )
                if done:
                    task.finish("pre-completed")

                current_project['tasks'].append(task_id)
                m.tasks.append(task)

        return m

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Manifest':
        """Build manifest from a dict spec."""
        m = cls()
        m.title = data.get('title', 'Untitled')
        for proj in data.get('projects', []):
            p = {
                'name': proj['name'],
                'location': proj.get('location', ''),
                'tasks': [],
            }
            for i, td in enumerate(proj.get('tasks', [])):
                if isinstance(td, str):
                    td = {'description': td}
                task = Task(
                    id=td.get('id', f"{proj['name'][:3].lower()}-{i:03d}"),
                    description=td['description'],
                    project=proj['name'],
                    priority=TaskPriority[td.get('priority', 'MEDIUM').upper()],
                    verify_cmd=td.get('verify', ''),
                    depends_on=td.get('depends_on', []),
                )
                p['tasks'].append(task.id)
                m.tasks.append(task)
            m.projects.append(p)
        return m

    @property
    def pending(self) -> List[Task]:
        return [t for t in self.tasks if t.state.value in ('queued', 'assigned', 'blocked')]

    @property
    def done(self) -> List[Task]:
        return [t for t in self.tasks if t.state.value == 'done']

    @property
    def failed(self) -> List[Task]:
        return [t for t in self.tasks if t.state.value == 'failed']

    def summary(self) -> dict:
        return {
            'title': self.title,
            'projects': len(self.projects),
            'total_tasks': len(self.tasks),
            'done': len(self.done),
            'pending': len(self.pending),
            'failed': len(self.failed),
            'completion': f"{len(self.done)/max(len(self.tasks),1)*100:.0f}%",
        }


def _infer_priority(desc: str) -> TaskPriority:
    """Infer priority from task description keywords."""
    d = desc.lower()
    if any(w in d for w in ['scrub', 'key', 'secret', 'rotate', 'security', 'critical']):
        return TaskPriority.CRITICAL
    if any(w in d for w in ['build', 'create', 'implement', 'write', 'deploy', 'ship']):
        return TaskPriority.HIGH
    if any(w in d for w in ['test', 'verify', 'check', 'validate', 'run']):
        return TaskPriority.MEDIUM
    return TaskPriority.LOW
