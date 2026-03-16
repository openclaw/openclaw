"""
bodhi_vault.energy_model — Cluster energy computation and criticality detection.

Energy = sum of recency-weighted revisit events for all nodes in a cluster.

    E(cluster) = Σ exp(-λ × days_since_visit)

where λ = ln(2) / half_life_days (default: 7-day half-life).

Clusters above the criticality threshold are "ripe" — the nudge scheduler
surfaces a question about them. The threshold is derived from the distribution:
any cluster whose energy exceeds (median + k × IQR) is a criticality candidate.
This is a robust outlier detector that works without scipy or numpy.

Design:
- Zero external dependencies (stdlib only)
- Works gracefully with empty vault or zero revisit history
- Deterministic given the same inputs and timestamp
"""

import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NamedTuple, Optional

from bodhi_vault.read import query_nodes
from bodhi_vault.revisit_tracker import REVISIT_LOG, load_events

# Default half-life: energy halves every 7 days.
# Tune via half_life_days argument if you want faster/slower decay.
DEFAULT_HALF_LIFE_DAYS = 7.0

# IQR multiplier for criticality threshold.
# k=1.5 is the Tukey fence. Lower → more nudges. Higher → fewer, higher signal.
DEFAULT_IQR_K = 1.5

# Minimum number of vault nodes in a cluster to qualify for nudge.
MIN_CLUSTER_SIZE = 2


class ClusterEnergy(NamedTuple):
    cluster_id: str
    energy: float
    node_count: int
    domains: list[str]          # Unique domains in this cluster
    top_node_ids: list[str]     # Up to 3 highest-energy nodes


def _recency_weight(event_at: str, now: datetime, half_life_days: float) -> float:
    """
    Compute exp(-λ × days_since) for a single revisit event.

    Returns 0.0 if the timestamp can't be parsed or is in the future.
    """
    lam = math.log(2) / max(half_life_days, 0.01)
    try:
        dt = datetime.fromisoformat(event_at)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        now_utc = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
        days = (now_utc - dt).total_seconds() / 86400.0
        if days < 0:
            return 0.0
        return math.exp(-lam * days)
    except (ValueError, TypeError):
        return 0.0


def _percentile(sorted_vals: list[float], p: float) -> float:
    """Return p-th percentile of a sorted list (0 ≤ p ≤ 100). Linear interpolation."""
    n = len(sorted_vals)
    if n == 0:
        return 0.0
    if n == 1:
        return sorted_vals[0]
    idx = p / 100.0 * (n - 1)
    lo = int(idx)
    hi = lo + 1
    if hi >= n:
        return sorted_vals[-1]
    frac = idx - lo
    return sorted_vals[lo] + frac * (sorted_vals[hi] - sorted_vals[lo])


def compute_cluster_energies(
    vault_path: Path,
    log_path: Path = REVISIT_LOG,
    half_life_days: float = DEFAULT_HALF_LIFE_DAYS,
    now: Optional[datetime] = None,
) -> list[ClusterEnergy]:
    """
    Compute energy for every cluster in the vault.

    Clusters without any revisit history still appear with energy = 0.
    This ensures all clusters can be ranked, not just the recently visited.

    Returns:
        List of ClusterEnergy, sorted by energy descending.
    """
    if now is None:
        now = datetime.now(tz=timezone.utc)

    # Build cluster → nodes map from vault
    nodes = query_nodes(vault_path)
    cluster_nodes: dict[str, list[dict[str, Any]]] = {}
    for node in nodes:
        cid = node.get("cluster_id")
        if not cid:
            continue
        cluster_nodes.setdefault(cid, []).append(node)

    if not cluster_nodes:
        return []

    # Build node → energy map from revisit log
    events = load_events(log_path=log_path)
    node_energy: dict[str, float] = {}
    for event in events:
        nid = event.get("node_id", "")
        if not nid:
            continue
        w = _recency_weight(event.get("at", ""), now, half_life_days)
        node_energy[nid] = node_energy.get(nid, 0.0) + w

    # Aggregate to cluster level
    results: list[ClusterEnergy] = []
    for cid, cluster_node_list in cluster_nodes.items():
        if len(cluster_node_list) < MIN_CLUSTER_SIZE:
            continue

        total_energy = 0.0
        domains: list[str] = []
        node_weights: list[tuple[str, float]] = []

        for node in cluster_node_list:
            nid = node["id"]
            e = node_energy.get(nid, 0.0)
            total_energy += e
            node_weights.append((nid, e))
            d = node.get("domain")
            if d and d not in domains:
                domains.append(d)

        # Top 3 nodes by individual energy for context in nudge
        node_weights.sort(key=lambda x: x[1], reverse=True)
        top_ids = [nid for nid, _ in node_weights[:3]]

        results.append(ClusterEnergy(
            cluster_id=cid,
            energy=total_energy,
            node_count=len(cluster_node_list),
            domains=domains,
            top_node_ids=top_ids,
        ))

    results.sort(key=lambda c: c.energy, reverse=True)
    return results


def find_critical_clusters(
    vault_path: Path,
    log_path: Path = REVISIT_LOG,
    half_life_days: float = DEFAULT_HALF_LIFE_DAYS,
    iqr_k: float = DEFAULT_IQR_K,
    now: Optional[datetime] = None,
) -> list[ClusterEnergy]:
    """
    Return clusters whose energy exceeds the criticality threshold.

    Threshold = median + iqr_k × IQR  (robust outlier detection on the upper tail).
    Clusters with zero energy are excluded from the threshold calculation
    but included in the full ranked list.

    Returns:
        Critical clusters sorted by energy descending. Empty list if none qualify.
    """
    all_clusters = compute_cluster_energies(
        vault_path=vault_path,
        log_path=log_path,
        half_life_days=half_life_days,
        now=now,
    )

    if not all_clusters:
        return []

    # Use only non-zero energies for threshold (zero = never visited, no signal)
    active_energies = sorted(c.energy for c in all_clusters if c.energy > 0)

    if len(active_energies) < 2:
        # Not enough data; return top cluster if it has any energy
        top = all_clusters[0]
        return [top] if top.energy > 0 else []

    q1 = _percentile(active_energies, 25)
    q2 = _percentile(active_energies, 50)
    q3 = _percentile(active_energies, 75)
    iqr = q3 - q1
    threshold = q2 + iqr_k * iqr

    return [c for c in all_clusters if c.energy >= threshold]


def energy_summary(
    vault_path: Path,
    log_path: Path = REVISIT_LOG,
    half_life_days: float = DEFAULT_HALF_LIFE_DAYS,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    """
    Return a human-readable summary dict for /nudge status or /viz status.

    Keys: total_clusters, active_clusters, critical_clusters,
          top_cluster_id, top_energy, threshold
    """
    if now is None:
        now = datetime.now(tz=timezone.utc)

    all_clusters = compute_cluster_energies(
        vault_path=vault_path, log_path=log_path,
        half_life_days=half_life_days, now=now,
    )
    critical = find_critical_clusters(
        vault_path=vault_path, log_path=log_path,
        half_life_days=half_life_days, now=now,
    )
    active = [c for c in all_clusters if c.energy > 0]

    return {
        "total_clusters": len(all_clusters),
        "active_clusters": len(active),
        "critical_clusters": len(critical),
        "top_cluster_id": all_clusters[0].cluster_id if all_clusters else None,
        "top_energy": round(all_clusters[0].energy, 4) if all_clusters else 0.0,
    }
