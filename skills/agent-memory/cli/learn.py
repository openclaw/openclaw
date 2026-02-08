#!/usr/bin/env python3
"""CLI wrapper for AgentMemory lesson operations."""

import sys
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
from memory import AgentMemory


def main():
    parser = argparse.ArgumentParser(description="Manage agent lessons learned")
    parser.add_argument("--db", help="Database path", default=None)
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # add command
    add_p = subparsers.add_parser("add", help="Record a lesson learned")
    add_p.add_argument("action", help="What was done")
    add_p.add_argument("context", help="Situation/topic")
    add_p.add_argument("outcome", choices=["positive", "negative", "neutral"], help="Result")
    add_p.add_argument("insight", help="What was learned")
    
    # list command
    list_p = subparsers.add_parser("list", help="List lessons")
    list_p.add_argument("--context", "-c", help="Filter by context")
    list_p.add_argument("--outcome", "-o", choices=["positive", "negative", "neutral"])
    list_p.add_argument("--limit", "-n", type=int, default=20)
    
    # apply command
    apply_p = subparsers.add_parser("apply", help="Mark a lesson as applied")
    apply_p.add_argument("lesson_id", help="ID of lesson to mark applied")
    
    args = parser.parse_args()
    mem = AgentMemory(db_path=args.db)
    
    if args.command == "add":
        lesson_id = mem.learn(
            action=args.action,
            context=args.context,
            outcome=args.outcome,
            insight=args.insight
        )
        emoji = {"positive": "✅", "negative": "❌", "neutral": "➖"}[args.outcome]
        print(f"{emoji} Lesson [{lesson_id}]: {args.insight[:60]}...")
        
    elif args.command == "list":
        lessons = mem.get_lessons(context=args.context, outcome=args.outcome, limit=args.limit)
        if not lessons:
            print("No lessons found.")
        for l in lessons:
            emoji = {"positive": "✅", "negative": "❌", "neutral": "➖"}[l.outcome]
            print(f"{emoji} [{l.id}] {l.context}: {l.insight}")
            print(f"   Action: {l.action} | Applied: {l.applied_count}x")
            
    elif args.command == "apply":
        mem.apply_lesson(args.lesson_id)
        print(f"📝 Marked lesson {args.lesson_id} as applied")


if __name__ == "__main__":
    main()
