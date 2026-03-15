"""
write_cli.py — CLI entrypoint called by OpenClaw's Curator SKILL.md via bash.

Usage (from SKILL.md):
    python -m bodhi_vault.write_cli "<content>" \
        --type Idea \
        --energy 4 \
        --source telegram \
        --tags soc,insight \
        --vault /path/to/vault \
        --schema /path/to/vault/schema/nodes.json

Output: JSON with {"id": "<uuid>"} on success, {"error": "<message>"} on failure.
Exit code: 0 on success, 1 on failure.

The Curator SKILL.md reads stdout JSON to confirm the write succeeded and
get the node ID for follow-up enrichment.
"""

import argparse
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Write a node to the vault")
    parser.add_argument("content", help="The thought to capture")
    parser.add_argument("--type", dest="node_type", default="Idea",
                        choices=["Idea", "Pattern", "Practice", "Decision", "Synthesis", "Integration"])
    parser.add_argument("--energy", type=int, default=3, choices=[1, 2, 3, 4, 5])
    parser.add_argument("--source", default="telegram",
                        choices=["telegram", "signal", "whatsapp", "manual", "surveyor", "distiller"])
    parser.add_argument("--tags", default="", help="Comma-separated tags (lowercase, hyphenated)")
    parser.add_argument("--media-type", dest="media_type", default="text",
                        choices=["text", "image", "voice", "document", "link", "video", "location"])
    parser.add_argument("--media-ref", dest="media_ref", default=None,
                        help="Telegram file_id or URL referencing the source media")
    parser.add_argument("--domain", default=None,
                        choices=["wellness", "fitness", "health", "mental-health", "cognitive",
                                 "trading", "business"])
    parser.add_argument("--people", default="", help="Comma-separated people names mentioned in this node")
    parser.add_argument("--social-context", dest="social_context", default=None,
                        choices=["solo", "social", "professional", "intimate"])
    parser.add_argument("--vault", required=True, help="Path to vault root directory")
    parser.add_argument("--schema", required=True, help="Path to nodes.json schema file")

    args = parser.parse_args()

    tags = [t.strip() for t in args.tags.split(",") if t.strip()] if args.tags else []
    people = [p.strip() for p in args.people.split(",") if p.strip()] if args.people else []
    node_id = str(uuid.uuid4())

    node = {
        "id": node_id,
        "type": args.node_type,
        "content": args.content,
        "energy_level": args.energy,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": args.source,
        "tags": tags,
        "created_by": "curator",
    }

    node["media_type"] = args.media_type  # always set, defaults to "text"
    if args.media_ref:
        node["media_ref"] = args.media_ref
    if args.domain:
        node["domain"] = args.domain
    if people:
        node["people"] = people
    if args.social_context:
        node["social_context"] = args.social_context

    try:
        from bodhi_vault.write import write_node
        from bodhi_vault.siyuan_sync import sync_to_siyuan
        from bodhi_vault.obsidian_sync import sync_to_obsidian

        write_node(node, Path(args.vault), Path(args.schema))

        # Fire-and-forget syncs — never block or fail the write
        sync_to_siyuan(node)
        sync_to_obsidian(node)

        print(json.dumps({"id": node_id}))
        sys.exit(0)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
