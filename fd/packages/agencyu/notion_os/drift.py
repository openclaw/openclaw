from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from packages.agencyu.canonical.hashing import stable_hash


@dataclass
class DriftResult:
    has_drift: bool
    drift_type: str | None = None  # external/local/dual
    details: dict[str, Any] | None = None


def compute_drift(
    canonical_payload: dict[str, Any],
    notion_snapshot: dict[str, Any],
    last_mirrored_hash: str | None,
) -> DriftResult:
    """Compare canonical payload with current Notion snapshot using stable hashes.

    Drift types:
    - external: source changed since last mirror
    - local: Notion changed since last mirror
    - dual: both changed
    """
    canon_hash = stable_hash(canonical_payload)
    notion_hash = stable_hash(notion_snapshot)

    if last_mirrored_hash is None:
        return DriftResult(has_drift=True, drift_type="external", details={"reason": "never_mirrored"})

    if canon_hash == last_mirrored_hash and notion_hash == last_mirrored_hash:
        return DriftResult(has_drift=False)

    if canon_hash != last_mirrored_hash and notion_hash == last_mirrored_hash:
        return DriftResult(has_drift=True, drift_type="external")

    if canon_hash == last_mirrored_hash and notion_hash != last_mirrored_hash:
        return DriftResult(has_drift=True, drift_type="local")

    return DriftResult(has_drift=True, drift_type="dual")
