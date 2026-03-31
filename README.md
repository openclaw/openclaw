<div align="center">

<img src="docs/bodhi/assets/logo.webp" width="120" alt="OpenBodhi" />

# OpenBodhi

A thinking partner that learns how you think. Your consciousness, organized.

[![Alpha](https://img.shields.io/badge/alpha-0.0.1-d4941a?style=flat-square&labelColor=0e0e11)](docs/bodhi/ROADMAP.md)
[![Fork of](https://img.shields.io/badge/fork%20of-openclaw%2Fopenclaw-5a8a75?style=flat-square&labelColor=0e0e11)](https://github.com/openclaw/openclaw)
[![License](https://img.shields.io/badge/license-MIT-ece5d8?style=flat-square&labelColor=0e0e11)](LICENSE)
[![Discussions](https://img.shields.io/badge/discussions-open-ece5d8?style=flat-square&labelColor=0e0e11)](https://github.com/Qenjin/OpenBodhi/discussions)

<img src="docs/bodhi/assets/banner.webp" width="100%" alt="OpenBodhi knowledge graph" />

</div>

---

Thinking is not linear. It arrives in fragments, clusters around invisible attractors, and bridges across domains you never expected to connect. You capture a thought. You return to it later, transformed, arriving from a different angle. Then it appears again, in a third context. That is not repetition. That is your mind organizing itself.

OpenBodhi watches this process. It catches what you think about. It holds it without judgment or urgency. Over time, it clusters what belongs together. It finds the bridges—the moments when separate threads of thought reveal they were always part of the same larger pattern. When the pattern is dense enough, when the bridges are clear, it says so.

This is not a task manager with AI features. It is a consciousness partner. Built on [OpenClaw](https://github.com/openclaw/openclaw), an open-source personal AI gateway, with a wellness knowledge layer on top. Four background workers. A local vault that stores everything as plain files. And a model for understanding when your thinking has reached critical mass.

Drop a thought. Move on. Bodhi organizes while you sleep.

---

## What happens when you think

You send a message. Bodhi sends back a checkmark.

```
You: "rest is not laziness, I keep forgetting this"

Bodhi: "✓"
```

No forms. No "rate your energy." No friction. Bodhi infers the energy from your language. Your somatic state from word choice. The readiness of the thought from context. The thought is captured, classified, stored as plain text, and waiting.

You don't organize. You don't tag. You don't manage. You think. Bodhi holds it.

Four background workers organize your thinking while you sleep:

| Worker | Runs | What it does |
|--------|------|-------------|
| **Curator** | Every message | Captures the thought, reads energy, stores to vault |
| **Distiller** | Daily 6am | Reads the last week, surfaces what your mind keeps returning to |
| **Janitor** | Sunday 3am | Finds duplicates and orphans, asks before deleting |
| **Surveyor** | Saturday 2am | Clusters ideas by density, finds bridges between clusters |

The vault grows. Duplicates get caught. Clusters form. Then one day you notice: the thing you've been thinking about in three different ways is actually one problem. Or one opportunity. That is Surveyor. That is emergence.

---

## The science behind it

This is built on real neuroscience and cognitive architecture, not wishful thinking.

**Self-Organized Criticality** (Per Bak, 1987): consciousness reaches readiness through density, not force. You capture the same insight in three different forms. Months apart. Each time it surfaces, the system energy increases. At some point the cascade occurs. A decision becomes obvious. An action becomes necessary. Bodhi watches for that threshold. It doesn't schedule breakthroughs. It notices when you are standing at the edge.

**Density-based clustering** (HDBSCAN): Your thinking naturally organizes into clusters. Not by your categories. By the actual density of recurrence. Bodhi finds where ideas cluster together and names what they're about.

**Bridge detection** (Betweenness centrality): The highest-value thinking happens at the bridges—where separate clusters connect. The moment you notice that your meditation practice and your work frustration are the same pattern. That is a bridge. Bodhi finds these first.

**Spaced emergence**: Not spaced repetition. Your breakthrough surfaces automatically at the moment you're most ready to see it, because density naturally rises to that point.

---

## Your vault is yours

Everything stays local. Plain JSON files. No sync. No cloud. No tracking.

```
~/.openclaw/vault/
├── nodes/2026-03/{uuid}.json    one file per thought
├── edges/{uuid}.json            relationships between thoughts
└── schema/                      validation rules
```

When you send a message, Bodhi reads it to understand energy and context. That understanding stays on your machine. The text goes to Anthropic for classification. Nothing else. No behavioral tracking. No inference about what you might want. Only: "Is this person okay? What energy is this? What kind of thinking is this?"

Your vault belongs to you.

---

## Six kinds of thinking

Every thought Bodhi captures becomes one of six types. This is how it organizes consciousness:

| Type | What it means |
|------|--------------|
| **Idea** | A raw thought, unfiltered. Captured as it arrived. Most of what you send. |
| **Pattern** | A recurring theme. Distiller finds these—not you. Something your mind keeps reaching for. |
| **Practice** | Something you do intentionally, repeatedly. The work that embodies your values. |
| **Decision** | A choice made, with context preserved. Why you chose. What you were considering. |
| **Synthesis** | A connection between separate ideas. Surveyor finds these. Two clusters revealing they were one. |
| **Integration** | An insight you have actually embodied. You changed because of it. The rarest one. |

The vault fills with Ideas. Over time, Patterns emerge. Practices accumulate. Decisions get made. Synthesized connections reshape your thinking. Integration happens when you stop thinking and start being.

---

## What's here now (Alpha 0.0.1)

**Available:**
- OpenClaw gateway (Telegram, multi-channel)
- Curator skill (capture thoughts, infer energy, classify)
- Vault schema (nodes, edges, plain JSON)
- Security layer (local-first, privacy-by-default)
- Design system (color tokens, typography, animation)

**In flight:**
- Janitor (duplicate detection, graph cleanup)
- Surveyor (HDBSCAN clustering, bridge finding)
- Distiller (daily synthesis, pattern surfacing)

**Future:**
- Nudge system (readiness-based interventions)
- Web interface (optional, for analysis)
- Mobile capture (if needed)
- Model sync (if you want to run locally)

---

## Stack

- **Runtime:** Node.js 22+, TypeScript 5.x
- **Package manager:** pnpm
- **Gateway:** [OpenClaw](https://github.com/openclaw/openclaw) (MIT)
- **AI:** Claude Opus 4.6 (synthesis) / Claude Sonnet 4.6 (classification)
- **Embeddings:** nomic-embed-text via Ollama (local, no API cost)
- **Vector store:** ChromaDB (embedded mode)
- **Clustering:** HDBSCAN (Python subprocess)
- **Messaging:** Telegram via OpenClaw

---

## The aesthetic

OpenBodhi's design reflects its philosophy. Contemplative. Trustworthy. Warm without urgency.

The color language: **Amber** for energy and attention (the Bodhi tree's golden hour). **Sage** for grounded practice (the tree's leaves). **Warm white** for connections (clarity, trust, the highest contrast). **Muted stone** for low-energy states (thinking-in-progress, not urgency).

The grain texture and breathing animations create life and depth without noise. This is not a startup dashboard. It is a tool for consciousness. The design reinforces that.

See the [Design System](docs/bodhi/DESIGN-SYSTEM.md) for the complete token reference. Watch the [Contemplative Emergence](docs/bodhi/assets/contemplative-emergence.html) visualization to see how clustering actually looks.

---

## Built on OpenClaw

OpenBodhi is a fork of [openclaw/openclaw](https://github.com/openclaw/openclaw). OpenClaw provides the infrastructure: multi-channel messaging, skills system, worker orchestration. The Bodhi workers and vault live in `skills/bodhi-*/` and `packages/bodhi-vault/`. Everything else is OpenClaw upstream.

---

## Follow the build

Building this in public. Conversations at [GitHub Discussions](https://github.com/Qenjin/OpenBodhi/discussions). Updates in the [Roadmap](docs/bodhi/ROADMAP.md).

---

## License

MIT, same as OpenClaw.

---

<div align="center">
<sub>Thinking organized through density. Ideas reach their own readiness.</sub>
</div>
