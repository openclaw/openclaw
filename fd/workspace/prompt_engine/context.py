"""Context builder — gathers the minimum useful context for each request.

Pulls system state, today's schedule, memory notes, and relevant domain
objects without flooding the engine with unnecessary data.

Uses a short-lived TTL cache (default 30s) so rapid-fire prompts don't
hammer the database or external services on every keystroke.
"""

from __future__ import annotations

import time
from typing import Any, Protocol

from packages.common.logging import get_logger

from .types import ContextPacket, Intent

logger = get_logger(__name__)


# ── Pluggable data-source protocols ─────────────────────────────────────────

class SystemStateProvider(Protocol):
    def snapshot(self) -> dict[str, Any]: ...


class ScheduleProvider(Protocol):
    def get_today_summary(self, *, brand: str | None = None) -> dict[str, Any]: ...


class FinanceProvider(Protocol):
    def get_summary(self, *, brand: str | None = None) -> dict[str, Any]: ...


class MemoryProvider(Protocol):
    def get_relevant_notes(
        self, *, brand: str | None = None, workflow: str | None = None
    ) -> list[str]: ...


# ── TTL cache ───────────────────────────────────────────────────────────────

class _TTLCache:
    """Dead-simple per-key cache with a fixed TTL."""

    def __init__(self, ttl_seconds: int = 30):
        self._ttl = ttl_seconds
        self._store: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        ts, value = entry
        if time.monotonic() - ts > self._ttl:
            del self._store[key]
            return None
        return value

    def set(self, key: str, value: Any) -> None:
        self._store[key] = (time.monotonic(), value)

    def clear(self) -> None:
        self._store.clear()


# ── Stub providers (used when real dependencies aren't wired) ───────────────

class StubSystemState:
    def snapshot(self) -> dict[str, Any]:
        return {"status": "unknown", "note": "no system-state provider wired"}


class StubSchedule:
    def get_today_summary(self, *, brand: str | None = None) -> dict[str, Any]:
        return {"events": [], "note": "no schedule provider wired"}


class StubFinance:
    def get_summary(self, *, brand: str | None = None) -> dict[str, Any]:
        return {"note": "no finance provider wired"}


class StubMemory:
    def get_relevant_notes(
        self, *, brand: str | None = None, workflow: str | None = None
    ) -> list[str]:
        return []


# ── Context builder ─────────────────────────────────────────────────────────

class ContextBuilder:
    """Assembles a :class:`ContextPacket` for a given intent.

    All data-source parameters are optional — the builder falls back to
    stubs so the engine can boot even when external services are down.
    """

    def __init__(
        self,
        system_state: SystemStateProvider | None = None,
        schedule: ScheduleProvider | None = None,
        finance: FinanceProvider | None = None,
        memory: MemoryProvider | None = None,
        cache_ttl: int = 30,
    ):
        self._system_state = system_state or StubSystemState()
        self._schedule = schedule or StubSchedule()
        self._finance = finance or StubFinance()
        self._memory = memory or StubMemory()
        self._cache = _TTLCache(cache_ttl)

    def build(self, intent: Intent) -> ContextPacket:
        brand = intent.brand

        system_snapshot = self._cached(
            "system_state",
            lambda: self._system_state.snapshot(),
        )

        today_summary = {
            "today_schedule": self._cached(
                f"schedule:{brand}",
                lambda: self._schedule.get_today_summary(brand=brand),
            ),
            "finance_summary": self._cached(
                f"finance:{brand}",
                lambda: self._finance.get_summary(brand=brand),
            ),
        }

        memory_notes = self._memory.get_relevant_notes(
            brand=brand,
            workflow=intent.workflow,
        )

        return ContextPacket(
            brand=brand,
            system_state=system_snapshot,
            today_summary=today_summary,
            memory_notes=memory_notes,
            relevant_objects={
                "brand": brand,
                "workflow": intent.workflow,
                "domain": intent.domain,
            },
        )

    # ── helpers ──────────────────────────────────────────────────────────

    def _cached(self, key: str, factory: Any) -> Any:
        value = self._cache.get(key)
        if value is not None:
            return value
        value = factory()
        self._cache.set(key, value)
        return value

    def invalidate_cache(self) -> None:
        self._cache.clear()
