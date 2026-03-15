"""
bodhi_vault.nudge_scheduler — Generate and track spaced-repetition nudges.

A "nudge" is ONE question about a cluster that has crossed the criticality
threshold. It is never advice, never a prescription — just a question that
surfaces a pattern the vault has been accumulating.

Spaced-repetition logic (Ebbinghaus-derived):
    After a nudge is generated, that cluster enters a cooldown period.
    Cooldown doubles on each consecutive nudge for the same cluster:
        1st nudge  → 3 days
        2nd nudge  → 6 days
        3rd nudge  → 12 days
        4th nudge  → 24 days  (≈ 3.5 weeks)
    This prevents the same thought from drowning out new signal.

State file: ~/.openclaw/nudge-state.json
    {
      "cluster_id": {
        "count": int,           # how many times nudged
        "last_nudge_at": ISO,   # when last nudged
        "cooldown_days": float  # current cooldown
      }
    }

Nudge log: ~/.openclaw/nudges.jsonl  (append-only, one JSON per line)

Design:
- Zero external dependencies
- Deterministic (no random question selection — uses top cluster node as anchor)
- Works with empty vault (returns empty list gracefully)
- Dismissal records stored in nudge-state.json as "snoozed_until"
"""

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from bodhi_vault.energy_model import (
    ClusterEnergy,
    find_critical_clusters,
    DEFAULT_HALF_LIFE_DAYS,
    DEFAULT_IQR_K,
)


NUDGE_STATE_PATH = Path(os.path.expanduser("~/.openclaw/nudge-state.json"))
NUDGE_LOG_PATH = Path(os.path.expanduser("~/.openclaw/nudges.jsonl"))

BASE_COOLDOWN_DAYS = 3.0
MAX_COOLDOWN_DAYS = 30.0


# ---------------------------------------------------------------------------
# Question templates — one per domain pair pattern.
# The nudge engine picks the template that best matches the cluster's domains.
# Always open-ended. Never prescriptive.
# ---------------------------------------------------------------------------

_DOMAIN_QUESTIONS: dict[str, list[str]] = {
    "wellness": [
        "What has changed in how you experience your daily energy this week?",
        "What is the earliest signal, before the low arrives?",
        "When did presence come naturally, and what made that possible?",
    ],
    "fitness": [
        "What does your body tell you that the metrics don't?",
        "What would consistent movement look like if it asked nothing of your willpower?",
        "Where does effort feel different from strain?",
    ],
    "health": [
        "What pattern in these observations has not yet been named?",
        "What would change if you treated this as signal rather than noise?",
        "What is the question your doctor has not asked?",
    ],
    "mental-health": [
        "What thought keeps returning — and what might it be pointing toward?",
        "Where is the boundary between the feeling and the story about the feeling?",
        "What would it mean if this pattern were useful, not just uncomfortable?",
    ],
    "cognitive": [
        "What conditions make thinking easier, and are you building for them?",
        "Which of these observations has shifted how you understand something else?",
        "What idea has been gaining weight without you fully examining it?",
    ],
    "bridge": [
        "These two domains keep showing up together. What connects them?",
        "What does this crossover suggest about the root cause?",
        "If these were chapters in the same story, what is the story?",
    ],
    "default": [
        "What is this cluster of thoughts pointing toward that you have not yet said aloud?",
        "What would it mean to take this seriously?",
        "What do these observations share that is not yet obvious?",
    ],
}


def _pick_question(cluster: ClusterEnergy) -> str:
    """Select the most contextually appropriate question for a cluster."""
    domains = cluster.domains

    # Cross-domain bridge → highest value signal
    if len(domains) >= 2:
        return _DOMAIN_QUESTIONS["bridge"][cluster.node_count % 3]

    domain = domains[0] if domains else "default"
    templates = _DOMAIN_QUESTIONS.get(domain, _DOMAIN_QUESTIONS["default"])
    # Use node_count as a stable selector — same cluster always gets same rotation
    return templates[cluster.node_count % len(templates)]


def _load_state(state_path: Path = NUDGE_STATE_PATH) -> dict[str, Any]:
    if not state_path.exists():
        return {}
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_state(state: dict[str, Any], state_path: Path = NUDGE_STATE_PATH) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = state_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(state_path)


def _append_nudge_log(nudge: dict[str, Any], log_path: Path = NUDGE_LOG_PATH) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(nudge, ensure_ascii=False) + "\n"
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(line)


def _is_on_cooldown(
    cluster_id: str,
    state: dict[str, Any],
    now: datetime,
) -> bool:
    """Return True if this cluster was nudged too recently."""
    entry = state.get(cluster_id)
    if not entry:
        return False

    snoozed_until = entry.get("snoozed_until")
    if snoozed_until:
        try:
            snooze_dt = datetime.fromisoformat(snoozed_until)
            if snooze_dt.tzinfo is None:
                snooze_dt = snooze_dt.replace(tzinfo=timezone.utc)
            now_utc = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
            if now_utc < snooze_dt:
                return True
        except (ValueError, TypeError):
            pass

    last_at = entry.get("last_nudge_at")
    if not last_at:
        return False

    try:
        last_dt = datetime.fromisoformat(last_at)
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=timezone.utc)
        now_utc = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
        days_since = (now_utc - last_dt).total_seconds() / 86400.0
        cooldown = entry.get("cooldown_days", BASE_COOLDOWN_DAYS)
        return days_since < cooldown
    except (ValueError, TypeError):
        return False


def generate_nudges(
    vault_path: Path,
    now: Optional[datetime] = None,
    max_nudges: int = 1,
    half_life_days: float = DEFAULT_HALF_LIFE_DAYS,
    iqr_k: float = DEFAULT_IQR_K,
    state_path: Path = NUDGE_STATE_PATH,
    log_path: Path = NUDGE_LOG_PATH,
) -> list[dict[str, Any]]:
    """
    Generate up to max_nudges nudges for clusters above the criticality threshold.

    Each nudge is a dict:
        {
          "cluster_id": str,
          "question": str,
          "domains": [str, ...],
          "node_count": int,
          "top_node_ids": [str, ...],
          "generated_at": ISO str,
          "nudge_count": int,          # how many times this cluster has been nudged
        }

    State file is updated and nudge log is appended.
    Returns empty list if no clusters qualify or all are on cooldown.
    """
    if now is None:
        now = datetime.now(tz=timezone.utc)

    critical = find_critical_clusters(
        vault_path=vault_path,
        half_life_days=half_life_days,
        iqr_k=iqr_k,
        now=now,
    )

    if not critical:
        return []

    state = _load_state(state_path)
    nudges: list[dict[str, Any]] = []

    for cluster in critical:
        if len(nudges) >= max_nudges:
            break
        if _is_on_cooldown(cluster.cluster_id, state, now):
            continue

        question = _pick_question(cluster)
        entry = state.get(cluster.cluster_id, {})
        nudge_count = entry.get("count", 0) + 1
        prev_cooldown = entry.get("cooldown_days", BASE_COOLDOWN_DAYS / 2)
        new_cooldown = min(prev_cooldown * 2, MAX_COOLDOWN_DAYS)

        nudge: dict[str, Any] = {
            "cluster_id": cluster.cluster_id,
            "question": question,
            "domains": cluster.domains,
            "node_count": cluster.node_count,
            "top_node_ids": cluster.top_node_ids,
            "generated_at": now.isoformat(),
            "nudge_count": nudge_count,
        }

        # Update state
        state[cluster.cluster_id] = {
            "count": nudge_count,
            "last_nudge_at": now.isoformat(),
            "cooldown_days": new_cooldown,
        }

        _append_nudge_log(nudge, log_path=log_path)
        nudges.append(nudge)

    _save_state(state, state_path=state_path)
    return nudges


def dismiss_nudge(
    cluster_id: str,
    snooze_days: float = 0.0,
    state_path: Path = NUDGE_STATE_PATH,
    now: Optional[datetime] = None,
) -> None:
    """
    Mark a nudge as dismissed. Optionally snooze for N days.

    snooze_days=0 → uses the standard cooldown (doubling schedule).
    snooze_days>0 → explicit snooze until that many days from now.
    """
    if now is None:
        now = datetime.now(tz=timezone.utc)

    state = _load_state(state_path)
    entry = state.get(cluster_id, {})

    if snooze_days > 0:
        from datetime import timedelta
        snooze_until = now + timedelta(days=snooze_days)
        entry["snoozed_until"] = snooze_until.isoformat()

    state[cluster_id] = entry
    _save_state(state, state_path=state_path)


def get_nudge_history(
    n: int = 20,
    log_path: Path = NUDGE_LOG_PATH,
) -> list[dict[str, Any]]:
    """Return the n most recent nudge records, newest first."""
    if not log_path.exists():
        return []

    lines: list[dict[str, Any]] = []
    with open(log_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                lines.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    return list(reversed(lines[-n:]))


def nudge_status(
    vault_path: Path,
    state_path: Path = NUDGE_STATE_PATH,
    now: Optional[datetime] = None,
) -> str:
    """
    Return a one-paragraph status string suitable for Telegram.

    Shows: critical cluster count, top cluster domains, cooldown info.
    """
    if now is None:
        now = datetime.now(tz=timezone.utc)

    from bodhi_vault.energy_model import energy_summary

    summary = energy_summary(vault_path=vault_path, now=now)
    state = _load_state(state_path)

    critical_count = summary["critical_clusters"]
    active_count = summary["active_clusters"]
    total = summary["total_clusters"]

    if total == 0:
        return "No clusters in vault yet. Add more nodes and come back."

    if critical_count == 0:
        return (
            f"{active_count}/{total} clusters active. "
            "No clusters at criticality threshold — keep observing."
        )

    # Find which critical clusters are on cooldown vs ready
    from bodhi_vault.energy_model import find_critical_clusters
    critical = find_critical_clusters(vault_path=vault_path, now=now)
    ready = [c for c in critical if not _is_on_cooldown(c.cluster_id, state, now)]
    snoozed = len(critical) - len(ready)

    parts = [
        f"{critical_count} cluster(s) at criticality threshold.",
        f"{len(ready)} ready for nudge.",
    ]
    if snoozed:
        parts.append(f"{snoozed} on cooldown.")
    if ready:
        top = ready[0]
        domain_str = " + ".join(top.domains) if top.domains else "unknown"
        parts.append(f"Top cluster: {domain_str} ({top.node_count} nodes).")

    return " ".join(parts)
