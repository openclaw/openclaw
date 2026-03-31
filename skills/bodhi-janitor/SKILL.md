---
name: bodhi-janitor
description: Weekly vault health check. Cron-scheduled via openclaw.json (janitor-weekly job, Sundays 3:30am UTC after vault backup).
user-invocable: true
disable-model-invocation: false
---

# bodhi-janitor

Runs every Sunday at 3am. Scans the full vault for orphan nodes, near-duplicates, and broken edges. Generates a hygiene report and sends it via Telegram. Never takes action without explicit user approval.

## Channel

Reports via Telegram. Never Signal. Never WhatsApp.

## Orphan Detection

Orphan nodes have zero edges and were created more than 7 days ago. Nodes younger than 7 days are excluded because they have not had time to form connections.

## Duplicate Detection

Compute pairwise cosine similarity across all node embeddings (nomic-embed-text via Ollama). Flag pairs with cosine similarity above 0.92.

Always show both node contents to the user before any merge.

## Broken Edge Detection

Edges where `from` or `to` references a UUID that no longer exists in the vault. These accumulate when nodes are deleted or moved manually.

## Manifest Verification

Run manifest check as part of every health scan:

```bash
python -c "from bodhi_vault.manifest import verify_manifest; from pathlib import Path; print(verify_manifest(Path('vault')))"
```

If manifest verification fails, alert the user immediately via Telegram. This takes priority over the regular hygiene report.

## Hygiene Report Format

```
Weekly vault health.

Orphans: [n] nodes with no connections
  - "[content preview]" (YYYY-MM-DD)

Possible duplicates: [n] pairs
  - "[content A]" and "[content B]" -- similarity 0.94

Broken edges: [n]
  - Edge {uuid} references missing node {uuid}

Manifest: OK / FAILED

Reply "approve" to clean up, or list specific node IDs to keep.
```

## Safe Defaults

- NEVER auto-delete. Report only. Wait for explicit user approval.
- NEVER merge without showing both node contents side by side.
- Archive orphans to `vault/archive/` instead of deleting.
- If user specifies node IDs to keep, exclude those from cleanup.
- Broken edges are removed only after user approval.

## Energy Handling

Energy values are read from stored nodes. The Janitor never prompts for energy. Energy is inferred at capture time by the Curator.

## Model

Claude (Sonnet/Opus) for report generation and content comparison. Small models (nomic-embed-text) for embedding only.

## Rules

- Deliver via Telegram only
- Never auto-delete anything
- Never merge without showing both contents
- Archive instead of delete for orphans
- Manifest failure is an immediate alert
- Never prompt for energy
- content field is the raw thought, always preserved
- Domains: wellness, fitness, health, mental-health, cognitive
