"""
Tests for revisit_tracker, energy_model, and nudge_scheduler.

All tests use tmp_path for isolation — no ~/.openclaw writes.
"""

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from bodhi_vault.revisit_tracker import (
    log_revisit,
    load_events,
    get_node_revisit_counts,
    get_cluster_revisit_counts,
    get_recent_events,
)
from bodhi_vault.energy_model import (
    _recency_weight,
    _percentile,
    compute_cluster_energies,
    find_critical_clusters,
    energy_summary,
)
from bodhi_vault.nudge_scheduler import (
    generate_nudges,
    dismiss_nudge,
    get_nudge_history,
    nudge_status,
    BASE_COOLDOWN_DAYS,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _make_node(tmp_path: Path, node_id: str, cluster_id: str, domain: str = "wellness") -> dict:
    """Write a minimal vault node to tmp_path/nodes/2026-01/<id>.json."""
    nodes_dir = tmp_path / "nodes" / "2026-01"
    nodes_dir.mkdir(parents=True, exist_ok=True)
    node = {
        "id": node_id,
        "type": "Idea",
        "content": f"Test node {node_id}",
        "energy_level": 3,
        "created_at": "2026-01-10T08:00:00+00:00",
        "source": "telegram",
        "tags": ["test"],
        "cluster_id": cluster_id,
        "domain": domain,
    }
    (nodes_dir / f"{node_id}.json").write_text(json.dumps(node), encoding="utf-8")
    return node


# ---------------------------------------------------------------------------
# revisit_tracker
# ---------------------------------------------------------------------------

class TestRevisitTracker:
    def test_log_creates_file(self, tmp_path):
        log = tmp_path / "revisit.jsonl"
        log_revisit("node-1", log_path=log)
        assert log.exists()

    def test_log_appends(self, tmp_path):
        log = tmp_path / "revisit.jsonl"
        log_revisit("node-1", log_path=log)
        log_revisit("node-2", log_path=log)
        events = load_events(log_path=log)
        assert len(events) == 2
        assert events[0]["node_id"] == "node-1"
        assert events[1]["node_id"] == "node-2"

    def test_log_stores_cluster_and_domain(self, tmp_path):
        log = tmp_path / "revisit.jsonl"
        log_revisit("n1", cluster_id="clus-a", domain="fitness", log_path=log)
        events = load_events(log_path=log)
        assert events[0]["cluster_id"] == "clus-a"
        assert events[0]["domain"] == "fitness"

    def test_load_empty(self, tmp_path):
        log = tmp_path / "revisit.jsonl"
        assert load_events(log_path=log) == []

    def test_load_since_filter(self, tmp_path):
        log = tmp_path / "revisit.jsonl"
        # Manually write two events with different timestamps
        old_event = {"node_id": "old", "at": "2026-01-01T00:00:00+00:00"}
        new_event = {"node_id": "new", "at": "2026-03-01T00:00:00+00:00"}
        with open(log, "w") as fh:
            fh.write(json.dumps(old_event) + "\n")
            fh.write(json.dumps(new_event) + "\n")
        since = datetime(2026, 2, 1, tzinfo=timezone.utc)
        events = load_events(log_path=log, since=since)
        assert len(events) == 1
        assert events[0]["node_id"] == "new"

    def test_node_revisit_counts(self, tmp_path):
        log = tmp_path / "revisit.jsonl"
        log_revisit("n1", log_path=log)
        log_revisit("n1", log_path=log)
        log_revisit("n2", log_path=log)
        counts = get_node_revisit_counts(log_path=log)
        assert counts["n1"] == 2
        assert counts["n2"] == 1

    def test_cluster_revisit_counts(self, tmp_path):
        log = tmp_path / "revisit.jsonl"
        log_revisit("n1", cluster_id="clus-a", log_path=log)
        log_revisit("n2", cluster_id="clus-a", log_path=log)
        log_revisit("n3", cluster_id="clus-b", log_path=log)
        counts = get_cluster_revisit_counts(log_path=log)
        assert counts["clus-a"] == 2
        assert counts["clus-b"] == 1

    def test_get_recent_events(self, tmp_path):
        log = tmp_path / "revisit.jsonl"
        for i in range(5):
            log_revisit(f"n{i}", log_path=log)
        recent = get_recent_events(n=3, log_path=log)
        assert len(recent) == 3
        assert recent[0]["node_id"] == "n4"  # newest first


# ---------------------------------------------------------------------------
# energy_model — unit functions
# ---------------------------------------------------------------------------

class TestEnergyModelUtils:
    def test_recency_weight_zero_days(self):
        now = _now()
        w = _recency_weight(now.isoformat(), now, half_life_days=7)
        assert abs(w - 1.0) < 0.001  # exp(0) = 1

    def test_recency_weight_half_life(self):
        now = _now()
        week_ago = (now - timedelta(days=7)).isoformat()
        w = _recency_weight(week_ago, now, half_life_days=7)
        assert abs(w - 0.5) < 0.01  # exp(-ln2) ≈ 0.5

    def test_recency_weight_far_past(self):
        now = _now()
        old = (now - timedelta(days=365)).isoformat()
        w = _recency_weight(old, now, half_life_days=7)
        assert w < 0.001  # extremely decayed

    def test_recency_weight_bad_ts(self):
        assert _recency_weight("not-a-date", _now(), 7) == 0.0

    def test_recency_weight_future(self):
        now = _now()
        future = (now + timedelta(days=1)).isoformat()
        assert _recency_weight(future, now, 7) == 0.0

    def test_percentile_single(self):
        assert _percentile([5.0], 50) == 5.0

    def test_percentile_empty(self):
        assert _percentile([], 50) == 0.0

    def test_percentile_quartiles(self):
        vals = sorted([1.0, 2.0, 3.0, 4.0])
        q1 = _percentile(vals, 25)
        q3 = _percentile(vals, 75)
        assert q1 < q3


# ---------------------------------------------------------------------------
# energy_model — integration with vault
# ---------------------------------------------------------------------------

class TestComputeClusterEnergies:
    def test_empty_vault(self, tmp_path):
        vault = tmp_path / "vault"
        vault.mkdir()
        log = tmp_path / "revisit.jsonl"
        result = compute_cluster_energies(vault, log_path=log)
        assert result == []

    def test_cluster_with_no_visits(self, tmp_path):
        vault = tmp_path / "vault"
        vault.mkdir()
        _make_node(vault, "n1", "clus-a")
        _make_node(vault, "n2", "clus-a")
        log = tmp_path / "revisit.jsonl"
        result = compute_cluster_energies(vault, log_path=log)
        assert len(result) == 1
        assert result[0].cluster_id == "clus-a"
        assert result[0].energy == 0.0

    def test_cluster_energy_increases_with_visits(self, tmp_path):
        vault = tmp_path / "vault"
        vault.mkdir()
        _make_node(vault, "n1", "clus-a")
        _make_node(vault, "n2", "clus-a")
        log = tmp_path / "revisit.jsonl"
        log_revisit("n1", cluster_id="clus-a", log_path=log)
        log_revisit("n2", cluster_id="clus-a", log_path=log)
        result = compute_cluster_energies(vault, log_path=log)
        assert result[0].energy > 0

    def test_more_visits_higher_energy(self, tmp_path):
        vault = tmp_path / "vault"
        vault.mkdir()
        _make_node(vault, "n1", "clus-a")
        _make_node(vault, "n2", "clus-a")
        _make_node(vault, "n3", "clus-b")
        _make_node(vault, "n4", "clus-b")
        log = tmp_path / "revisit.jsonl"
        for _ in range(5):
            log_revisit("n1", cluster_id="clus-a", log_path=log)
        log_revisit("n3", cluster_id="clus-b", log_path=log)
        result = compute_cluster_energies(vault, log_path=log)
        energies = {c.cluster_id: c.energy for c in result}
        assert energies["clus-a"] > energies["clus-b"]

    def test_sorted_descending(self, tmp_path):
        vault = tmp_path / "vault"
        vault.mkdir()
        _make_node(vault, "n1", "clus-a")
        _make_node(vault, "n2", "clus-a")
        _make_node(vault, "n3", "clus-b")
        _make_node(vault, "n4", "clus-b")
        log = tmp_path / "revisit.jsonl"
        log_revisit("n3", cluster_id="clus-b", log_path=log)
        result = compute_cluster_energies(vault, log_path=log)
        assert result[0].energy >= result[1].energy

    def test_domains_collected(self, tmp_path):
        vault = tmp_path / "vault"
        vault.mkdir()
        _make_node(vault, "n1", "clus-a", domain="wellness")
        _make_node(vault, "n2", "clus-a", domain="fitness")
        log = tmp_path / "revisit.jsonl"
        result = compute_cluster_energies(vault, log_path=log)
        assert set(result[0].domains) == {"wellness", "fitness"}


class TestFindCriticalClusters:
    def test_no_visits_no_critical(self, tmp_path):
        vault = tmp_path / "vault"
        vault.mkdir()
        _make_node(vault, "n1", "clus-a")
        _make_node(vault, "n2", "clus-a")
        log = tmp_path / "revisit.jsonl"
        result = find_critical_clusters(vault, log_path=log)
        assert result == []

    def test_single_active_cluster_becomes_critical(self, tmp_path):
        vault = tmp_path / "vault"
        vault.mkdir()
        _make_node(vault, "n1", "clus-a")
        _make_node(vault, "n2", "clus-a")
        log = tmp_path / "revisit.jsonl"
        log_revisit("n1", log_path=log)
        # Only 1 active cluster → it is the top cluster, returned
        result = find_critical_clusters(vault, log_path=log)
        assert len(result) == 1

    def test_high_energy_cluster_is_critical(self, tmp_path):
        vault = tmp_path / "vault"
        vault.mkdir()
        for i in range(4):
            _make_node(vault, f"n{i}", "clus-a")
            _make_node(vault, f"m{i}", "clus-b")
            _make_node(vault, f"p{i}", "clus-c")
        log = tmp_path / "revisit.jsonl"
        # clus-a gets 20 visits; others get 1 each
        for _ in range(20):
            log_revisit("n0", cluster_id="clus-a", log_path=log)
        log_revisit("m0", cluster_id="clus-b", log_path=log)
        log_revisit("p0", cluster_id="clus-c", log_path=log)
        result = find_critical_clusters(vault, log_path=log)
        cluster_ids = [c.cluster_id for c in result]
        assert "clus-a" in cluster_ids


# ---------------------------------------------------------------------------
# nudge_scheduler
# ---------------------------------------------------------------------------

class TestNudgeScheduler:
    def _setup_vault_with_active_cluster(self, tmp_path) -> tuple[Path, Path, Path]:
        vault = tmp_path / "vault"
        vault.mkdir()
        log = tmp_path / "revisit.jsonl"
        state = tmp_path / "nudge-state.json"
        nudge_log = tmp_path / "nudges.jsonl"
        _make_node(vault, "n1", "clus-a", domain="cognitive")
        _make_node(vault, "n2", "clus-a", domain="cognitive")
        for _ in range(10):
            log_revisit("n1", cluster_id="clus-a", log_path=log)
        return vault, log, state, nudge_log

    def test_generate_returns_nudge(self, tmp_path):
        vault, log, state, nudge_log = self._setup_vault_with_active_cluster(tmp_path)
        nudges = generate_nudges(
            vault_path=vault,
            state_path=state,
            log_path=nudge_log,
        )
        assert len(nudges) == 1
        assert "question" in nudges[0]
        assert len(nudges[0]["question"]) > 10

    def test_nudge_written_to_log(self, tmp_path):
        vault, log, state, nudge_log = self._setup_vault_with_active_cluster(tmp_path)
        generate_nudges(vault_path=vault, state_path=state, log_path=nudge_log)
        history = get_nudge_history(log_path=nudge_log)
        assert len(history) == 1

    def test_cooldown_prevents_second_nudge(self, tmp_path):
        vault, log, state, nudge_log = self._setup_vault_with_active_cluster(tmp_path)
        now = _now()
        generate_nudges(vault_path=vault, state_path=state, log_path=nudge_log, now=now)
        # Immediately after — should be on cooldown
        nudges2 = generate_nudges(vault_path=vault, state_path=state, log_path=nudge_log, now=now)
        assert nudges2 == []

    def test_nudge_after_cooldown_expires(self, tmp_path):
        vault, log, state, nudge_log = self._setup_vault_with_active_cluster(tmp_path)
        now = _now()
        generate_nudges(vault_path=vault, state_path=state, log_path=nudge_log, now=now)
        # Advance time past initial cooldown (BASE_COOLDOWN_DAYS * 2 since cooldown doubles)
        future = now + timedelta(days=BASE_COOLDOWN_DAYS * 3)
        nudges2 = generate_nudges(vault_path=vault, state_path=state, log_path=nudge_log, now=future)
        assert len(nudges2) == 1

    def test_cooldown_doubles_on_repeat(self, tmp_path):
        vault, log, state, nudge_log = self._setup_vault_with_active_cluster(tmp_path)
        now = _now()
        generate_nudges(vault_path=vault, state_path=state, log_path=nudge_log, now=now)
        saved = json.loads(state.read_text())
        first_cooldown = saved["clus-a"]["cooldown_days"]
        # Fire again after cooldown
        future = now + timedelta(days=first_cooldown + 1)
        generate_nudges(vault_path=vault, state_path=state, log_path=nudge_log, now=future)
        saved2 = json.loads(state.read_text())
        second_cooldown = saved2["clus-a"]["cooldown_days"]
        assert second_cooldown == first_cooldown * 2

    def test_dismiss_sets_snooze(self, tmp_path):
        _, _, state, _ = self._setup_vault_with_active_cluster(tmp_path)
        vault = tmp_path / "vault"
        log = tmp_path / "revisit.jsonl"
        nudge_log = tmp_path / "nudges.jsonl"
        now = _now()
        generate_nudges(vault_path=vault, state_path=state, log_path=nudge_log, now=now)
        dismiss_nudge("clus-a", snooze_days=5, state_path=state, now=now)
        saved = json.loads(state.read_text())
        assert "snoozed_until" in saved["clus-a"]

    def test_empty_vault_no_nudges(self, tmp_path):
        vault = tmp_path / "vault"
        vault.mkdir()
        state = tmp_path / "state.json"
        nudge_log = tmp_path / "nudges.jsonl"
        nudges = generate_nudges(vault_path=vault, state_path=state, log_path=nudge_log)
        assert nudges == []

    def test_nudge_count_increments(self, tmp_path):
        vault, log, state, nudge_log = self._setup_vault_with_active_cluster(tmp_path)
        now = _now()
        n1 = generate_nudges(vault_path=vault, state_path=state, log_path=nudge_log, now=now)
        assert n1[0]["nudge_count"] == 1
        future = now + timedelta(days=BASE_COOLDOWN_DAYS * 4)
        n2 = generate_nudges(vault_path=vault, state_path=state, log_path=nudge_log, now=future)
        assert n2[0]["nudge_count"] == 2

    def test_nudge_status_string(self, tmp_path):
        vault, log, state, nudge_log = self._setup_vault_with_active_cluster(tmp_path)
        status = nudge_status(vault_path=vault, state_path=state)
        assert isinstance(status, str)
        assert len(status) > 0
