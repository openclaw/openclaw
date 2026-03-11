"""
MoltAssist — Autonomous task execution for OpenClaw.
F1 pit crew for your codebase.

MIT License · AnnulusLabs LLC 2026
"""

__version__ = "0.1.0"

from .task import Task, TaskState, TaskPriority, text_to_gene, gene_similarity
from .crew import PitCrew
from .manifest import Manifest, load_manifest
from .dispatch import Dispatcher, AgentType
from .verify import Verifier, VerifyResult
from .board import Board
from .runner import LocalRunner

__all__ = [
    "PitCrew",
    "LocalRunner",
    "Task",
    "TaskState",
    "TaskPriority",
    "Manifest",
    "load_manifest",
    "Dispatcher",
    "AgentType",
    "Verifier",
    "VerifyResult",
    "Board",
    "text_to_gene",
    "gene_similarity",
]
