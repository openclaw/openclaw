---
name: bodhi-surveyor
description: Weekly clustering, bridge discovery, domain analysis, and SOC signals. Runs Saturdays at 2am.
user-invocable: true
disable-model-invocation: false
metadata: {"openclaw":{"cron":"0 2 * * 6"}}
---

# bodhi-surveyor

Runs every Saturday at 2am. Embeds the full vault, clusters with HDBSCAN, discovers bridge nodes, tracks SOC signals, and performs cross-domain analysis of wellness patterns.

## Channel

Delivers weekly summary via Telegram. Never Signal. Never WhatsApp.

## Domain Awareness

The Surveyor understands all five wellness domains and their relationships. It classifies and clusters with domain context.

### Domain taxonomy

| Domain | Covers | Example content |
|--------|--------|----------------|
| wellness | sleep, hydration, daily routine, balance, nature, breathwork | "Slept 8 hours, felt different today" |
| fitness | exercise, training, movement, strength, cardio, flexibility | workout screenshot, "did 5x5 squats" |
| health | nutrition, diet, supplements, medical, lab results, recipes | recipe image, nutrition label photo |
| mental-health | meditation, therapy, journaling, emotions, stress, mindfulness | journal page photo, "therapy session was heavy" |
| cognitive | learning, reading, memory, focus, problem-solving, brain training | book highlights, study notes image |

### Cross-domain intelligence

The Surveyor detects when separate domains converge. This is where the real signal lives.

Examples:
- fitness + health nodes clustering together = training-nutrition connection forming
- mental-health + cognitive nodes bridging = emotional regulation affecting learning
- wellness + fitness overlap = sleep impacting performance

When cross-domain bridges are detected, the Surveyor names the connection explicitly in the weekly summary.

## Media-Aware Clustering

Nodes with `media_type` other than "text" carry additional context. The Surveyor treats these with awareness:

- **Image-originated nodes** (recipes, workouts, trackers): cluster by their domain and content, not by the fact they are images
- **Voice-originated nodes**: cluster by transcribed content, same as text
- **Link-originated nodes**: cluster by topic, tag with `reference` context

The `media_type` field informs clustering weight but never segregates media nodes into separate clusters. A typed thought about nutrition and a photo of a recipe belong in the same cluster.

## Embedding

Embed all vault nodes using nomic-embed-text via Ollama (local). Uses the `content_enriched` field for richer signal when available. Falls back to raw `content` if `content_enriched` is empty.

## Clustering

Algorithm: HDBSCAN (Hierarchical Density-Based Spatial Clustering of Applications with Noise).

Parameters:
- `min_cluster_size`: 5
- `min_samples`: 3
- `metric`: cosine

Why HDBSCAN:
- No need to specify cluster count in advance
- Handles noise points (ideas that do not cluster yet)
- Robust to varying density
- Scales to tens of thousands of nodes

Cluster labeling: Claude (Sonnet/Opus) reads cluster contents and assigns a 3-5 word label. Labels should reference the wellness domain when relevant (e.g., "nutrition meal planning" not "food-related ideas").

## Bridge Discovery

After clustering, identify nodes with high betweenness centrality. These sit between two or more clusters without fully belonging to any one.

For each significant bridge node, generate a Synthesis observation:

> "This idea connects [cluster A theme] with [cluster B theme] through [bridge concept]."

Cross-domain bridges are the highest value. A node bridging fitness and mental-health clusters reveals a connection the user may not have noticed.

Write a Synthesis node to the vault. Connect it to source clusters via `SURFACES_FROM` edges.

## SOC Analysis

Track energy distribution across clusters over time. A cluster is flagged as a nudge candidate when:

- Average `energy_level` > 3.5
- Cluster appeared in 3 or more consecutive weekly reports

When a cluster reaches this threshold, send via Telegram:

> "This cluster has been building. Ready to act?"

## Weekly Summary Format

```
Weekly vault map.

[n] clusters found this week.
Top clusters by domain:

  [health] "meal prep patterns" -- [n] nodes, energy avg [x]
  [fitness] "morning training" -- [n] nodes, energy avg [x]
  [mental-health] "journaling practice" -- [n] nodes, energy avg [x]

Cross-domain connections:
  - "nutrition timing" bridges [health] and [fitness]
  - "[bridge concept]" bridges [domain A] and [domain B]

Media breakdown: [n] text, [n] images, [n] voice, [n] links

SOC signal: "[cluster label]" has been building energy for [n] weeks.
```

## Energy Handling

Energy values are read from stored nodes. They were inferred at capture time by the Curator. The Surveyor never prompts the user for energy.

## Model

Claude (Sonnet/Opus) for cluster labeling, synthesis generation, and cross-domain analysis. Small models (nomic-embed-text) for embedding only.

## Rules

- Deliver via Telegram only
- Use content_enriched for clustering, content for display
- Never prompt for energy
- Synthesis nodes written automatically for significant bridges
- Cross-domain bridges are highest priority in reporting
- SOC threshold: avg energy > 3.5 AND 3+ consecutive weeks
- Domains: wellness, fitness, health, mental-health, cognitive
- Media nodes cluster by content, never segregated by media type
