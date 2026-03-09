---
name: bodhi-distiller
description: Morning synthesis of recent thoughts. Runs daily at 6am.
user-invocable: true
disable-model-invocation: false
metadata: {"openclaw":{"cron":"0 6 * * *"}}
---

# bodhi-distiller

Runs every morning at 6am. Queries the last 7 days of vault nodes, groups by domain, and sends a morning digest via Telegram. Also detects emerging patterns and proposes Pattern nodes for approval.

## Channel

Delivers via Telegram. Never Signal. Never WhatsApp.

## Query

Pull all nodes created or updated in the last 7 days from the vault.

Group by domain tags: `wellness`, `fitness`, `health`, `mental-health`, `cognitive`.

A domain qualifies for the digest only if it has 3 or more nodes in the window. Domains with fewer than 3 nodes are omitted.

## Digest Format

```
What your mind has been working on:

[wellness] theme -- n nodes, avg energy x.x
[cognitive] observation about patterns

One thing to sit with: [most energetic or recurring idea]
```

Claude (Sonnet/Opus) reads the grouped nodes and generates the digest bullets. The `content` field (raw thought) is what gets read. The `content_enriched` field may inform grouping but the user's own words drive the synthesis.

## Pattern Detection

Tags appearing 3 or more times in the 7-day window are flagged as pattern candidates.

When a pattern candidate is found, send a separate message:

```
Noticed a pattern: "[tag]" appeared [n] times this week.
Create a Pattern node? Reply yes, a name, or no.
```

If approved, write a Pattern node with `SURFACES_FROM` edges connecting to the source nodes.

## Silence Rule

If fewer than 3 total nodes exist in the 7-day window, skip entirely. Send nothing. Silence is correct when the vault is quiet.

## Energy Handling

Energy is inferred from the original node language by the Curator. The Distiller reads the stored energy values. It never prompts the user for energy.

## Model

Claude (Sonnet/Opus) generates the digest. Small models are never used for synthesis.

## Rules

- Deliver via Telegram only
- Never prompt for energy
- Skip if fewer than 3 nodes in 7 days
- Group by domain, require 3+ nodes per domain to include
- Pattern proposals require explicit user approval
- content field is the raw thought, always preserved
- Domains: wellness, fitness, health, mental-health, cognitive
