---
name: bodhi-enricher
description: Enriches vault nodes with research context and concept matching.
user-invocable: false
disable-model-invocation: false
---

# bodhi-enricher

Runs asynchronously after the Curator writes a node. Can also be triggered by cron for batch enrichment of unenriched nodes.

The enricher populates the `content_enriched` field and `related_papers` field on vault nodes. The `content_enriched` field is used downstream by the Surveyor for clustering. The raw `content` field is always what gets displayed to the user.

## Channel

Reports and errors go to Telegram. Never Signal. Never WhatsApp.

## Phased Implementation

### Phase 0 (current)

Pure Python concept matching against the hard-coded concepts dictionary.

- Load concepts from `packages/bodhi_vault/src/bodhi_vault/data/concepts.json`
- Match node content against concept entries using keyword overlap and semantic proximity
- Write matched concepts to `content_enriched` field
- Write any related paper references to `related_papers` field

### Phase 1 (when Ollama is online)

Expand fragmented thoughts via Mistral Nemo before concept matching.

- Short or fragmented content (under 20 words) gets expanded into a full sentence by Mistral Nemo
- Expanded version is used only for concept matching, never stored as `content`
- Then run the same concept matching pipeline from Phase 0

Claude (Sonnet/Opus) is never used for enrichment. Small models only. This is a background task and must not consume primary model budget.

## Execution

```bash
python -m bodhi_vault.enrich_cli <node_id> \
  --vault vault \
  --schema vault/schema/nodes.json \
  --concepts packages/bodhi_vault/src/bodhi_vault/data/concepts.json
```

## Idempotency

Skip if the node already has a non-empty `content_enriched` field. Never overwrite existing enrichment unless explicitly forced with a `--force` flag.

## Rules

- `content` is never modified by the enricher
- `content_enriched` is for clustering, never displayed to user
- Small models only for expansion (Mistral Nemo via Ollama)
- Claude is never used for enrichment tasks
- Idempotent by default
- Domains: wellness, fitness, health, mental-health, cognitive
