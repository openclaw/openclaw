<div align="center">

<img src="docs/bodhi/assets/logo.webp" width="120" alt="OpenBodhi" />

# OpenBodhi

A personal AI that learns how you think.

[![Phase](https://img.shields.io/badge/phase-0%20%E2%80%94%20foundation-c06cff?style=flat-square&labelColor=0a0a0a)](docs/bodhi/ROADMAP.md)
[![Fork of](https://img.shields.io/badge/fork%20of-openclaw%2Fopenclaw-00d4ff?style=flat-square&labelColor=0a0a0a)](https://github.com/openclaw/openclaw)
[![License](https://img.shields.io/badge/license-MIT-00f5d4?style=flat-square&labelColor=0a0a0a)](LICENSE)
[![Discussions](https://img.shields.io/badge/discussions-open-ff6b9d?style=flat-square&labelColor=0a0a0a)](https://github.com/Qenjin/OpenBodhi/discussions)

<img src="docs/bodhi/assets/banner.webp" width="100%" alt="OpenBodhi knowledge graph" />

</div>

---

I started OpenBodhi because I needed something that would catch my thinking, not just my tasks.

The tools I tried were all good at organizing what I had already decided. None of them helped me notice what I was actually thinking about. The recurring theme. The idea that kept showing up in different forms. The connection I almost made but didn't.

OpenBodhi is built on [OpenClaw](https://github.com/openclaw/openclaw), an open-source personal AI gateway. I forked it and added a wellness knowledge layer on top. Four workers. A local vault that stores everything as plain files. And a model for understanding when your thinking is ready to become action.

Drop a thought. Bodhi files it. Over time it finds the patterns. When something is ready, it says so.

---

## What Bodhi does

You send a message. Bodhi sends back a checkmark.

```
You: "rest is not laziness, I keep forgetting this"

Bodhi: "✓"
```

No forms. No energy ratings. No follow-up questions unless the thought needs it. Bodhi infers energy from your language. The thought is filed, classified, and waiting.

Four workers run in the background:

| Worker | When | What it does |
|--------|------|-------------|
| **Curator** | Every message | Classifies the thought, infers energy, writes it to the vault |
| **Distiller** | 6am daily | Synthesizes the last 7 days, surfaces what your mind keeps returning to |
| **Janitor** | Sunday 3am | Finds duplicates and orphans, asks you before touching anything |
| **Surveyor** | Saturday 2am | Clusters your ideas, finds connections between separate threads |

---

## The science behind it

I wanted this to be real, not just a journal with AI features.

**Self-Organized Criticality** (Per Bak, 1987): ideas accumulate energy through recurrence. The same insight surfaces again in a different form. The same problem shows up in a new context. At some point, the cascade occurs. A decision becomes obvious. An action becomes necessary. Bodhi watches for that threshold. It does not schedule your breakthroughs. It notices when you are close.

**Spaced repetition** (Ebbinghaus): high-energy un-acted ideas surface at optimal intervals. Not reminders. Mirrors.

**HDBSCAN clustering**: density-based pattern discovery that does not require you to pre-define categories. Your thinking decides the structure.

**Betweenness centrality**: identifies bridge ideas, the thoughts that connect otherwise separate clusters of your thinking.

---

## Your vault

Everything is local. Plain files. Nothing synced.

```
vault/
├── nodes/2026-03/{uuid}.json    one file per thought
├── edges/{uuid}.json            typed relationships between thoughts
└── schema/                      validation rules
```

Anthropic receives message text for classification. Nothing else leaves your machine.

---

## Six kinds of thoughts

| Node | What it is |
|------|-----------|
| **Idea** | The raw thought. Captured as it arrived. |
| **Pattern** | A recurring theme. Distiller surfaces these, not you. |
| **Practice** | Something you do intentionally. |
| **Decision** | A choice made, with its context preserved. |
| **Synthesis** | A connection Surveyor found between separate ideas. |
| **Integration** | An insight you have actually embodied. The rarest one. |

---

## Roadmap

```
Phase 0: Foundation          <- you are here
  Fork OpenClaw, documentation, vault schema, skill specs

Phase 1: Local Gateway
  OpenClaw running on a dedicated machine, Telegram connected

Phase 2: Curator
  Real-time thought capture. Zero friction. Vault fills.

Phase 3: Vault layer
  Shared read/write module, ChromaDB embeddings

Phase 4: Distiller
  Daily digest. Energy trajectories. Pattern candidates.

Phase 5: Janitor + Surveyor
  Clustering. Bridge discovery. Message from past self.

Phase 6: Nudge system
  SOC-based readiness detection.
```

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

## Built on OpenClaw

OpenBodhi is a fork of [openclaw/openclaw](https://github.com/openclaw/openclaw). OpenClaw provides the infrastructure: multi-channel messaging, skills system, Docker deployment. The Bodhi workers and vault live in `skills/bodhi-*/` and `packages/bodhi-vault/`. Everything else is OpenClaw upstream.

---

## Follow the build

Building this in public. Follow on GitHub Discussions or watch the repo for updates.

---

## License

MIT, same as OpenClaw.

---

<div align="center">
<sub>Ideas reach their own readiness.</sub>
</div>
