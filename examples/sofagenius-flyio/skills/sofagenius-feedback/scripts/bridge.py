#!/usr/bin/env python3
"""Feedback bridge: syncs execution telemetry, corrections, and patterns
back to SofaGenius so it can evolve its ML skills.

This is the return path in the bidirectional loop:
  OpenClaw (observations) → feedback store → SofaGenius (skill evolution)

Usage:
    python3 bridge.py log-correction --skill <skill> --action <action> --correction "..."
    python3 bridge.py log-pattern --type <type> --description "..."
    python3 bridge.py feedback-stats
    python3 bridge.py feedback-recent --hours 24
    python3 bridge.py sync-to-sofagenius
    python3 bridge.py pull-skill-updates
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

# Add the shared module to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
import feedback_store

SOFAGENIUS_URL = os.environ.get("SOFAGENIUS_URL", "http://127.0.0.1:8000")


def api_call(endpoint: str, payload: dict, timeout: int = 60) -> dict | None:
    """POST to SofaGenius feedback API. Returns None if endpoint not available."""
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{SOFAGENIUS_URL}{endpoint}",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            # Feedback endpoints not implemented yet in SofaGenius — that's OK
            return None
        print(f"SofaGenius API error ({e.code}): {e.read().decode()}", file=sys.stderr)
        return None
    except urllib.error.URLError as e:
        print(f"Cannot reach SofaGenius at {SOFAGENIUS_URL}: {e}", file=sys.stderr)
        print("Feedback saved locally. Will sync when SofaGenius is available.", file=sys.stderr)
        return None


def log_correction(skill: str, action: str, correction: str,
                   original_args: str, corrected_args: str | None) -> None:
    orig = json.loads(original_args) if original_args else {}
    corrected = json.loads(corrected_args) if corrected_args else None
    corr_id = feedback_store.log_correction(
        skill=skill,
        action=action,
        original_args=orig,
        original_result={},
        correction=correction,
        corrected_args=corrected,
    )
    print(f"Correction logged: {corr_id}")
    print(f"  Skill: {skill} / {action}")
    print(f"  Correction: {correction}")


def log_pattern(pattern_type: str, description: str,
                evidence: str | None, suggested_action: str | None) -> None:
    evidence_list = json.loads(evidence) if evidence else []
    pat_id = feedback_store.log_pattern(
        pattern_type=pattern_type,
        description=description,
        evidence=evidence_list,
        suggested_action=suggested_action,
    )
    print(f"Pattern logged: {pat_id}")
    print(f"  Type: {pattern_type}")
    print(f"  Description: {description}")


def feedback_stats() -> None:
    stats = feedback_store.get_stats()
    print(json.dumps(stats, indent=2))


def feedback_recent(hours: float) -> None:
    since = time.time() - (hours * 3600)
    exes = feedback_store.get_executions(since_ts=since)
    corrections = feedback_store.get_corrections(since_ts=since)
    patterns = feedback_store.get_patterns(since_ts=since)

    result = {
        "period_hours": hours,
        "executions": len(exes),
        "corrections": len(corrections),
        "patterns": len(patterns),
        "recent_executions": exes[-10:],  # last 10
        "recent_corrections": corrections[-5:],
        "recent_patterns": patterns[-5:],
    }
    print(json.dumps(result, indent=2))


def sync_to_sofagenius() -> None:
    """Push unsynced feedback to SofaGenius backend."""
    unsynced = feedback_store.get_unsynced_feedback()

    total = sum(len(v) for v in unsynced.values())
    if total == 0:
        print("No new feedback to sync.")
        return

    print(f"Syncing {total} feedback records to SofaGenius...")
    print(f"  Executions: {len(unsynced['executions'])}")
    print(f"  Corrections: {len(unsynced['corrections'])}")
    print(f"  Patterns: {len(unsynced['patterns'])}")
    print(f"  Skill drafts: {len(unsynced['skill_drafts'])}")

    result = api_call("/api/feedback/ingest", {
        "executions": unsynced["executions"],
        "corrections": unsynced["corrections"],
        "patterns": unsynced["patterns"],
        "skill_drafts": unsynced["skill_drafts"],
    })

    if result is not None:
        feedback_store.set_sync_cursor(time.time(), total)
        print(f"Synced successfully. SofaGenius response:")
        print(json.dumps(result, indent=2))
    else:
        print("SofaGenius feedback endpoint not available yet.")
        print("Feedback is saved locally and will be synced when the endpoint is ready.")
        print(f"Local feedback store: {feedback_store.FEEDBACK_DIR}")


def pull_skill_updates() -> None:
    """Pull updated/evolved skills from SofaGenius."""
    result = api_call("/api/feedback/skill-updates", {})

    if result is None:
        print("SofaGenius skill-updates endpoint not available yet.")
        print("Once SofaGenius implements this endpoint, updated skills will be")
        print("pulled and applied to improve future executions.")
        return

    updates = result.get("updates", [])
    if not updates:
        print("No skill updates available from SofaGenius.")
        return

    print(f"SofaGenius has {len(updates)} skill update(s):")
    for update in updates:
        print(f"  - {update.get('skill')}: {update.get('description')}")
    print(json.dumps(result, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="SofaGenius Feedback Bridge")
    parser.add_argument("action", choices=[
        "log-correction", "log-pattern", "feedback-stats",
        "feedback-recent", "sync-to-sofagenius", "pull-skill-updates",
    ])
    parser.add_argument("--skill", help="Skill name (e.g. sofagenius-training)")
    parser.add_argument("--action-name", dest="action_name", help="Action within the skill")
    parser.add_argument("--correction", help="Description of user's correction")
    parser.add_argument("--original-args", help="JSON of original arguments")
    parser.add_argument("--corrected-args", help="JSON of corrected arguments")
    parser.add_argument("--type", dest="pattern_type", help="Pattern type")
    parser.add_argument("--description", help="Pattern description")
    parser.add_argument("--evidence", help="JSON array of evidence (execution IDs or descriptions)")
    parser.add_argument("--suggested-action", help="Suggested action for the pattern")
    parser.add_argument("--hours", type=float, default=24, help="Hours to look back")
    args = parser.parse_args()

    if args.action == "log-correction":
        if not args.skill or not args.correction:
            parser.error("--skill and --correction required for log-correction")
        log_correction(args.skill, args.action_name or "", args.correction,
                       args.original_args or "{}", args.corrected_args)
    elif args.action == "log-pattern":
        if not args.pattern_type or not args.description:
            parser.error("--type and --description required for log-pattern")
        log_pattern(args.pattern_type, args.description,
                    args.evidence, args.suggested_action)
    elif args.action == "feedback-stats":
        feedback_stats()
    elif args.action == "feedback-recent":
        feedback_recent(args.hours)
    elif args.action == "sync-to-sofagenius":
        sync_to_sofagenius()
    elif args.action == "pull-skill-updates":
        pull_skill_updates()


if __name__ == "__main__":
    main()
