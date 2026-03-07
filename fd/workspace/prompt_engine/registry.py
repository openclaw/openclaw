"""Executor registry — keeps the system modular.

Each workflow executor registers itself by name.  The plan executor
looks up the right executor at runtime, so adding a new capability
never requires touching the core engine.
"""

from __future__ import annotations

from typing import Any, Protocol

from packages.common.logging import get_logger

logger = get_logger(__name__)


class StepExecutor(Protocol):
    """Protocol that every workflow executor must satisfy."""
    def execute(self, action_type: str, payload: dict[str, Any]) -> dict[str, Any]: ...


class ExecutorRegistry:
    """Thread-safe registry of named executors."""

    def __init__(self) -> None:
        self._executors: dict[str, StepExecutor] = {}

    def register(self, name: str, executor: StepExecutor) -> None:
        if name in self._executors:
            logger.info(
                "executor_replaced",
                extra={"extra": {"name": name}},
            )
        self._executors[name] = executor

    def get(self, name: str) -> StepExecutor:
        if name not in self._executors:
            raise KeyError(f"Executor not registered: {name}")
        return self._executors[name]

    def has(self, name: str) -> bool:
        return name in self._executors

    @property
    def registered_names(self) -> list[str]:
        return list(self._executors.keys())
