"""
enrich_cli.py — CLI entrypoint called by OpenClaw's Enricher SKILL.md via bash.

Usage (from SKILL.md):
    python -m bodhi_vault.enrich_cli <node_id> \
        --vault /path/to/vault \
        --schema /path/to/vault/schema/nodes.json \
        --concepts /path/to/concepts.json

Output: JSON with {"enriched": true/false} on success, {"error": "<message>"} on failure.
Exit code: 0 on success, 1 on failure.
"""

import argparse
import json
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich a vault node with concept matching")
    parser.add_argument("node_id", help="UUID of the node to enrich")
    parser.add_argument("--vault", required=True, help="Path to vault root directory")
    parser.add_argument("--schema", required=True, help="Path to nodes.json schema file")
    parser.add_argument("--concepts", required=True, help="Path to concepts.json file")
    parser.add_argument("--force", action="store_true", default=False,
                        help="Re-enrich even if node already has related_papers")

    args = parser.parse_args()

    try:
        from bodhi_vault.enrich import enrich_node_concepts

        updated = enrich_node_concepts(
            node_id=args.node_id,
            vault_path=Path(args.vault),
            schema_path=Path(args.schema),
            concepts_path=Path(args.concepts),
            force=args.force,
        )
        print(json.dumps({"enriched": updated}))
        sys.exit(0)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
