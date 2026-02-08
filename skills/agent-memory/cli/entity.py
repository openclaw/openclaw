#!/usr/bin/env python3
"""CLI wrapper for AgentMemory entity operations."""

import sys
import json
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
from memory import AgentMemory


def main():
    parser = argparse.ArgumentParser(description="Manage tracked entities")
    parser.add_argument("--db", help="Database path", default=None)
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # track command
    track_p = subparsers.add_parser("track", help="Track a new entity")
    track_p.add_argument("name", help="Entity name")
    track_p.add_argument("type", help="Entity type (person, project, company, etc.)")
    track_p.add_argument("--attr", "-a", nargs=2, action="append", metavar=("KEY", "VALUE"),
                         help="Attribute key-value pair (repeatable)")
    
    # get command
    get_p = subparsers.add_parser("get", help="Get entity details")
    get_p.add_argument("name", help="Entity name")
    get_p.add_argument("--type", "-t", help="Entity type (optional)")
    
    # update command
    update_p = subparsers.add_parser("update", help="Update entity attributes")
    update_p.add_argument("name", help="Entity name")
    update_p.add_argument("type", help="Entity type")
    update_p.add_argument("--attr", "-a", nargs=2, action="append", metavar=("KEY", "VALUE"),
                          help="Attribute to update", required=True)
    
    # list command
    list_p = subparsers.add_parser("list", help="List entities")
    list_p.add_argument("--type", "-t", help="Filter by type")
    
    # link command
    link_p = subparsers.add_parser("link", help="Link a fact to an entity")
    link_p.add_argument("name", help="Entity name")
    link_p.add_argument("fact_id", help="Fact ID to link")
    
    args = parser.parse_args()
    mem = AgentMemory(db_path=args.db)
    
    if args.command == "track":
        attrs = dict(args.attr) if args.attr else {}
        entity_id = mem.track_entity(args.name, args.type, attrs)
        print(f"✅ Tracking [{args.type}] {args.name} (id: {entity_id})")
        if attrs:
            print(f"   Attributes: {json.dumps(attrs)}")
            
    elif args.command == "get":
        entity = mem.get_entity(args.name, entity_type=args.type)
        if not entity:
            print(f"❌ Entity '{args.name}' not found")
            sys.exit(1)
        print(f"[{entity.entity_type}] {entity.name}")
        print(f"  ID: {entity.id}")
        print(f"  First seen: {entity.first_seen}")
        print(f"  Last updated: {entity.last_updated}")
        print(f"  Attributes: {json.dumps(entity.attributes, indent=2)}")
        if entity.fact_ids:
            print(f"  Linked facts: {len(entity.fact_ids)}")
            
    elif args.command == "update":
        attrs = dict(args.attr)
        entity = mem.update_entity(args.name, args.type, attrs)
        if entity:
            print(f"✅ Updated {entity.name}: {json.dumps(attrs)}")
        else:
            print(f"❌ Entity not found")
            
    elif args.command == "list":
        entities = mem.list_entities(entity_type=args.type)
        if not entities:
            print("No entities found.")
        for e in entities:
            attr_preview = ", ".join(f"{k}={v}" for k, v in list(e.attributes.items())[:3])
            print(f"[{e.entity_type}] {e.name} ({attr_preview})")
            
    elif args.command == "link":
        mem.link_fact_to_entity(args.name, args.fact_id)
        print(f"🔗 Linked fact {args.fact_id} to {args.name}")


if __name__ == "__main__":
    main()
