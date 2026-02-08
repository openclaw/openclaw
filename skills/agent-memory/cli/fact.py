#!/usr/bin/env python3
"""CLI wrapper for AgentMemory fact operations."""

import sys
import argparse
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
from memory import AgentMemory


def main():
    parser = argparse.ArgumentParser(description="Manage agent memory facts")
    parser.add_argument("--db", help="Database path", default=None)
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # add command
    add_p = subparsers.add_parser("add", help="Remember a new fact")
    add_p.add_argument("content", help="The fact to remember")
    add_p.add_argument("--tags", "-t", nargs="+", default=[], help="Tags for the fact")
    add_p.add_argument("--source", "-s", default="conversation", help="Source of fact")
    add_p.add_argument("--confidence", "-c", type=float, default=0.9, help="Confidence 0-1")
    add_p.add_argument("--expires", "-e", type=int, help="Days until expiration")
    
    # recall command
    recall_p = subparsers.add_parser("recall", help="Search for facts")
    recall_p.add_argument("query", help="Search query")
    recall_p.add_argument("--limit", "-n", type=int, default=10, help="Max results")
    recall_p.add_argument("--tags", "-t", nargs="+", help="Filter by tags")
    
    # list command
    list_p = subparsers.add_parser("list", help="List all facts")
    list_p.add_argument("--tags", "-t", nargs="+", help="Filter by tags")
    list_p.add_argument("--limit", "-n", type=int, default=20, help="Max results")
    
    # supersede command
    sup_p = subparsers.add_parser("supersede", help="Replace a fact with new info")
    sup_p.add_argument("fact_id", help="ID of fact to supersede")
    sup_p.add_argument("new_content", help="New fact content")
    
    # forget command
    forget_p = subparsers.add_parser("forget", help="Remove stale facts")
    forget_p.add_argument("--days", "-d", type=int, default=30, help="Forget facts older than N days")
    
    args = parser.parse_args()
    mem = AgentMemory(db_path=args.db)
    
    if args.command == "add":
        fact_id = mem.remember(
            args.content,
            tags=args.tags,
            source=args.source,
            confidence=args.confidence,
            expires_in_days=args.expires
        )
        print(f"✅ Remembered [{fact_id}]: {args.content[:60]}...")
        
    elif args.command == "recall":
        facts = mem.recall(args.query, limit=args.limit, tags=args.tags)
        if not facts:
            print("No matching facts found.")
        for f in facts:
            tags = " ".join(f"#{t}" for t in f.tags) if f.tags else ""
            print(f"[{f.id}] {f.content} {tags}")
            
    elif args.command == "list":
        facts = mem.list_facts(tags=args.tags, limit=args.limit)
        for f in facts:
            tags = " ".join(f"#{t}" for t in f.tags) if f.tags else ""
            print(f"[{f.id}] {f.content[:70]}... {tags}")
            
    elif args.command == "supersede":
        new_fact = mem.supersede(args.fact_id, args.new_content)
        if new_fact:
            print(f"✅ Created [{new_fact.id}] superseding {args.fact_id}")
        else:
            print(f"❌ Fact {args.fact_id} not found")
            
    elif args.command == "forget":
        count = mem.forget_stale(days=args.days)
        print(f"🗑️ Forgot {count} stale facts (>{args.days} days old)")


if __name__ == "__main__":
    main()
