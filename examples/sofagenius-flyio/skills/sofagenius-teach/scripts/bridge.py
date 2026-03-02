#!/usr/bin/env python3
"""Teach bridge: capture user-taught workflows, skill refinements, and
domain knowledge so SofaGenius can evolve from human guidance.

This is the human-in-the-loop interface for the feedback loop:
  User teaches → OpenClaw captures → feedback store → SofaGenius absorbs

Usage:
    python3 bridge.py teach-workflow --name "name" --description "..." --steps '[...]'
    python3 bridge.py refine-skill --skill "name" --refinement "..."
    python3 bridge.py list-lessons
    python3 bridge.py export-lessons --format json
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
import feedback_store


def teach_workflow(name: str, description: str, steps_json: str,
                   trigger: str | None) -> None:
    steps = json.loads(steps_json)
    draft_id = feedback_store.log_skill_draft(
        name=name,
        description=description,
        steps=steps,
        trigger=trigger,
    )
    print(f"Workflow captured: {draft_id}")
    print(f"  Name: {name}")
    print(f"  Steps: {len(steps)}")
    for i, step in enumerate(steps, 1):
        note = step.get("note", step.get("action", ""))
        print(f"    {i}. {note}")
    print()
    print("This workflow is stored locally and will be synced to SofaGenius")
    print("on the next feedback sync. SofaGenius can use it to:")
    print("  - Generate optimized skill configurations")
    print("  - Pre-populate hyperparameters for similar tasks")
    print("  - Suggest this workflow to other users with similar setups")


def refine_skill(skill: str, refinement: str, context: str | None) -> None:
    # Store as a pattern with type "skill_refinement"
    pat_id = feedback_store.log_pattern(
        pattern_type="skill_refinement",
        description=refinement,
        evidence=[f"skill:{skill}", f"context:{context or 'user feedback'}"],
        suggested_action=f"Update {skill} to incorporate: {refinement}",
    )
    print(f"Skill refinement logged: {pat_id}")
    print(f"  Skill: {skill}")
    print(f"  Refinement: {refinement}")
    if context:
        print(f"  Context: {context}")
    print()
    print("SofaGenius can use this to improve the skill's ML logic.")


def list_lessons() -> None:
    corrections = feedback_store.get_corrections()
    patterns = feedback_store.get_patterns()
    drafts = feedback_store.get_skill_drafts()
    stats = feedback_store.get_stats()

    print("=== What the system has learned ===\n")

    print(f"Execution history: {stats['total_executions']} skill calls tracked")
    if stats.get("executions_by_skill"):
        for skill, count in stats["executions_by_skill"].items():
            failures = stats.get("failures_by_skill", {}).get(skill, 0)
            print(f"  {skill}: {count} calls ({failures} failures)")
    print()

    if corrections:
        print(f"User corrections: {len(corrections)}")
        for c in corrections[-5:]:  # show last 5
            print(f"  - [{c.get('skill')}] {c.get('correction')}")
        print()

    if patterns:
        print(f"Learned patterns: {len(patterns)}")
        for p in patterns[-5:]:
            print(f"  - [{p.get('type')}] {p.get('description')}")
        print()

    if drafts:
        print(f"Taught workflows: {len(drafts)}")
        for d in drafts:
            print(f"  - {d.get('name')}: {d.get('description')}")
            for i, step in enumerate(d.get("steps", []), 1):
                print(f"      {i}. {step.get('note', step.get('action', ''))}")
        print()

    if not corrections and not patterns and not drafts:
        print("No lessons captured yet. As you use the skills and provide")
        print("corrections, the system will learn from your guidance.")

    # Summary for the agent
    print("\n--- Sync status ---")
    cursor = feedback_store.get_sync_cursor()
    if cursor["last_sync_ts"] > 0:
        ago = time.time() - cursor["last_sync_ts"]
        print(f"Last sync to SofaGenius: {ago/3600:.1f} hours ago ({cursor['synced_count']} records)")
    else:
        print("Never synced to SofaGenius yet.")

    unsynced = feedback_store.get_unsynced_feedback()
    total_unsynced = sum(len(v) for v in unsynced.values())
    if total_unsynced > 0:
        print(f"Unsynced feedback: {total_unsynced} records waiting")


def export_lessons(fmt: str) -> None:
    """Export all lessons in a format SofaGenius can ingest."""
    export = {
        "exported_at": time.time(),
        "format_version": "1.0",
        "corrections": feedback_store.get_corrections(),
        "patterns": feedback_store.get_patterns(),
        "skill_drafts": feedback_store.get_skill_drafts(),
        "execution_summary": feedback_store.get_stats(),
    }

    if fmt == "json":
        print(json.dumps(export, indent=2))
    else:
        # JSONL format for streaming ingestion
        for section in ["corrections", "patterns", "skill_drafts"]:
            for record in export[section]:
                record["_type"] = section
                print(json.dumps(record))


def main() -> None:
    parser = argparse.ArgumentParser(description="SofaGenius Teach Bridge")
    parser.add_argument("action", choices=[
        "teach-workflow", "refine-skill", "list-lessons", "export-lessons",
    ])
    parser.add_argument("--name", help="Workflow name")
    parser.add_argument("--description", help="Workflow description")
    parser.add_argument("--steps", help="JSON array of workflow steps")
    parser.add_argument("--trigger", help="Condition for proactive execution")
    parser.add_argument("--skill", help="Skill to refine")
    parser.add_argument("--refinement", help="Description of the refinement")
    parser.add_argument("--context", help="Context for why this refinement matters")
    parser.add_argument("--format", dest="fmt", choices=["json", "jsonl"], default="json")
    args = parser.parse_args()

    if args.action == "teach-workflow":
        if not args.name or not args.description or not args.steps:
            parser.error("--name, --description, and --steps required")
        teach_workflow(args.name, args.description, args.steps, args.trigger)
    elif args.action == "refine-skill":
        if not args.skill or not args.refinement:
            parser.error("--skill and --refinement required")
        refine_skill(args.skill, args.refinement, args.context)
    elif args.action == "list-lessons":
        list_lessons()
    elif args.action == "export-lessons":
        export_lessons(args.fmt)


if __name__ == "__main__":
    main()
