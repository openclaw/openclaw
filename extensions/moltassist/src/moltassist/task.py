"""
nox.pitcrew.task â€” Atomic unit of work
Every task has a gene (48-trit cavity signature) for routing.
"""
import hashlib
import time
import enum
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any


class TaskState(enum.Enum):
    QUEUED = "queued"
    ASSIGNED = "assigned"
    RUNNING = "running"
    VERIFYING = "verifying"
    DONE = "done"
    FAILED = "failed"
    BLOCKED = "blocked"


class TaskPriority(enum.Enum):
    CRITICAL = 0  # Ship-blocking
    HIGH = 1      # Must do today
    MEDIUM = 2    # Should do today
    LOW = 3       # Nice to have


def text_to_gene(text: str, n_trits: int = 48) -> str:
    """SHA-256 â†’ balanced ternary gene. Deterministic."""
    h = hashlib.sha256(text.encode()).digest()
    trits = []
    for byte in h:
        for i in range(5):  # 5 trits per byte (3^5=243 < 256)
            val = byte % 3
            byte //= 3
            trits.append({0: '0', 1: '+', 2: '-'}[val])
            if len(trits) >= n_trits:
                return ''.join(trits)
    return ''.join(trits[:n_trits])


def gene_similarity(a: str, b: str) -> float:
    """Cosine similarity in trit space {-1, 0, +1}."""
    MAP = {'+': 1, '0': 0, '-': -1}
    va = [MAP.get(c, 0) for c in a]
    vb = [MAP.get(c, 0) for c in b]
    n = min(len(va), len(vb))
    dot = sum(va[i] * vb[i] for i in range(n))
    mag_a = sum(x * x for x in va[:n]) ** 0.5
    mag_b = sum(x * x for x in vb[:n]) ** 0.5
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return dot / (mag_a * mag_b)


@dataclass
class Task:
    """Atomic unit of work in the pit crew."""
    id: str
    description: str
    priority: TaskPriority = TaskPriority.MEDIUM
    state: TaskState = TaskState.QUEUED
    gene: str = ""
    project: str = ""
    depends_on: List[str] = field(default_factory=list)
    assigned_to: str = ""
    result: Optional[str] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    started_at: float = 0.0
    finished_at: float = 0.0
    verify_cmd: str = ""  # Command to verify completion
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not self.gene:
            self.gene = text_to_gene(self.description)

    @property
    def elapsed(self) -> float:
        if self.finished_at:
            return self.finished_at - self.started_at
        if self.started_at:
            return time.time() - self.started_at
        return 0.0

    @property
    def is_ready(self) -> bool:
        """Ready to run if queued and all dependencies done."""
        return self.state == TaskState.QUEUED and not self.depends_on

    def start(self):
        self.state = TaskState.RUNNING
        self.started_at = time.time()

    def finish(self, result: str = "ok"):
        self.state = TaskState.DONE
        self.finished_at = time.time()
        self.result = result

    def fail(self, error: str):
        self.state = TaskState.FAILED
        self.finished_at = time.time()
        self.error = error

    def to_dict(self) -> dict:
        return {
            'id': self.id,
            'description': self.description,
            'priority': self.priority.name,
            'state': self.state.value,
            'gene': self.gene,
            'project': self.project,
            'depends_on': self.depends_on,
            'assigned_to': self.assigned_to,
            'result': self.result,
            'error': self.error,
            'elapsed': round(self.elapsed, 2),
            'verify_cmd': self.verify_cmd,
        }
