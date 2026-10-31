"""Validate the separate warmed selection-cycle diagnostic; never rewrite old proof."""

import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
summary = json.loads((root / "summary.json").read_text())
assert (summary["planned"], summary["executed"], summary["failed"], summary["skipped"]) == (3, 3, 0, 0)
assert all(value is None for row in summary["summary"] for value in row["metrics"].values())
rows = json.loads((root / "results.json").read_text())
assert len(rows) == 3 and {row["bundle"] for row in rows} == {0, 1, 2}
report = {"samples": [], "constantCandidateHeapDifferenceBytes": [], "rejections": []}
for row in rows:
    assert row["step"] == "data-agent-selection-retention"
    assert row["status"] == "passed" and row["measurementClass"] == "diagnostic"
    evidence = row["scenarioEvidence"]
    assert evidence["selectionCycles"] == 10 and evidence["selectionsPerCycle"] == 4
    assert evidence["selectedMain"] is True and evidence["identityRequests"] == 0
    assert evidence["agentAvatarsInitial"] == evidence["agentAvatarsFinal"] == 300
    assert 0 <= evidence["agentAvatarsRetained"] <= 300
    if row["bundle"] == 1:
        assert evidence["agentAvatarsRetained"] == 300
    assert row["rowIdentity"] == {"initial": 300, "created": 0, "retained": 300, "final": 300}
    snapshots = row["retainedHeap"]
    before, after = snapshots["before"], snapshots["after"]
    for point in (before, after):
        assert (root / point["artifact"]).stat().st_size > 0
        assert point["solidUnknownStateOwners"] == 0
    counters = ["solidLiveOwners", "solidDisposedOwners", "nodes", "documents", "jsEventListeners", "detachedNodes"]
    changes = {key: after[key] - before[key] for key in counters}
    for key in ("timeouts", "intervals"):
        changes[f"timers.{key}"] = after["timers"][key] - before["timers"][key]
    for owner in set(before["listeners"]) | set(after["listeners"]):
        initial, final = before["listeners"].get(owner, {}), after["listeners"].get(owner, {})
        for kind in set(initial) | set(final):
            changes[f"listeners.{owner}.{kind}"] = final.get(kind, 0) - initial.get(kind, 0)
    report["rejections"].extend(
        {"bundle": row["bundle"], "counter": key, "increase": delta}
        for key, delta in changes.items() if delta > 0
    )
    report["samples"].append({
        "bundle": row["bundle"],
        "beforeBytes": snapshots["beforeBytes"],
        "afterBytes": snapshots["afterBytes"],
        "deltaBytes": snapshots["deltaBytes"],
        "heapBytesPerFourSelectionCycle": snapshots["deltaBytes"] / 10,
        "structuralChanges": changes,
        "innerAvatarsRetained": evidence["agentAvatarsRetained"],
        "requests": row["requests"],
        "hostLoadAverage": row["hostLoadAverage"],
    })
candidate = next(row for row in rows if row["bundle"] == 1)
for baseline in (row for row in rows if row["bundle"] != 1):
    report["constantCandidateHeapDifferenceBytes"].append({
        "againstBundle": baseline["bundle"],
        "before": candidate["retainedHeap"]["beforeBytes"] - baseline["retainedHeap"]["beforeBytes"],
        "after": candidate["retainedHeap"]["afterBytes"] - baseline["retainedHeap"]["afterBytes"],
    })
report["requiresHeapAttribution"] = [sample["bundle"] for sample in report["samples"] if sample["deltaBytes"] > 0]
report["note"] = "Finite warmed four-selection cycles only. Positive heap slope needs retained-snapshot attribution; fixed candidate cost is not accumulation."
print(json.dumps(report, indent=2))
sys.exit(1 if report["rejections"] else 2 if report["requiresHeapAttribution"] else 0)
