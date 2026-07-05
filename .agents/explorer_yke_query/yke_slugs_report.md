# YKE Data Plane Slugs & Knowledge Report

**Date:** 2026-07-03  
**Author:** Explorer Subagent (`teamwork_preview_explorer`)  
**Target Path:** `/Users/jakeshrader/openclaw/.agents/explorer_yke_query/yke_slugs_report.md`

---

## 1. YKE SQLite Database Verification

The YouTube Knowledge Engine (YKE) database files are located at:

- **Local MacBook Path:** `/Users/jakeshrader/Desktop/Code/youtube-knowledge-engine/data/knowledge.db`
- **Size:** 5,157,412,864 bytes (5.15 GB)
- **Mac Mini Remote Path:** `/Users/henri/Desktop/Code/youtube-knowledge-engine/data/knowledge.db` (which is pulled to the MacBook via the `pull-knowledge-db-from-mini.sh` rsync script).

The data plane was verified by reading the local media census registries, corpus manifests, and JSON catalogs in the `youtube-knowledge-engine` repository.

---

## 2. Discovered YKE Slugs

Across the verified YKE data plane, more than 30 distinct slugs were retrieved and cataloged. They are organized into three primary categories below.

### 2.1 Channel Slugs (Experts)

These slugs represent individual content creators or organizations whose transcripts are parsed and embedded in the YKE data plane:

| Slug                | Title                 | Focus Domain                                              |
| ------------------- | --------------------- | --------------------------------------------------------- |
| `alexhormozi`       | Alex Hormozi          | Offers, customer acquisition, and monetization            |
| `moremozi`          | Alex Hormozi (More)   | Long-form Q&A and scaling tactics                         |
| `danmartell`        | Dan Martell           | SaaS growth, scaling operations, and "buying back time"   |
| `sharran`           | Sharran Srivatsaa     | Operator leadership, communication cadences, and systems  |
| `siliconvalleygirl` | Marina Mogilko        | Solo startup growth, creators, and tech products          |
| `tommymello`        | Tommy Mello           | Home/field services scaling and marketing engines         |
| `codiesanchez`      | Codie Sanchez         | Boring Main Street cash-flowing businesses                |
| `37signals`         | 37signals (DHH/Fried) | Calm companies, anti-SaaS philosophy, and buy-once models |
| `robwalling`        | Rob Walling           | Bootstrapped SaaS and capital-efficient growth            |
| `microconf`         | MicroConf             | Bootstrap SaaS founder tactical stories                   |
| `gregisenberg`      | Greg Isenberg         | AI-native startups and community-first products           |
| `ycombinator`       | Y Combinator          | Startup fundamentals and iterating fast                   |
| `levelsio`          | Pieter Levels         | Solo founder automation and indie hacking                 |
| `poorpumpersociety` | Poor Pumper Society   | Field service trade operations                            |

### 2.2 Video ID Slugs

Specific video segments indexed with transcripts and Gemini embeddings:

| Video ID Slug | Channel       | Video Title                                                             |
| ------------- | ------------- | ----------------------------------------------------------------------- |
| `XsWSvz-aewA` | `alexhormozi` | The New Way of Making Content In The Age of AI                          |
| `EonibwnAEME` | `alexhormozi` | How to Catch Up In Life (Using Logic)                                   |
| `OQf2Ba-Lp_4` | `alexhormozi` | Building a $2,500,000 Business for a Stranger in 36 Minutes             |
| `3fsJFUvA6Ts` | `alexhormozi` | What Makes The Perfect Business (5 Things)                              |
| `fr78adfAnuA` | `alexhormozi` | How to Use AI in Your Business in 2026                                  |
| `TWuzAO7ukk0` | `danmartell`  | If you’re trying to get rich with AI, you need to hear this…            |
| `yvXNmdfYJYY` | `danmartell`  | If You Understand These 7 Principles, You’ll Understand How to Get Rich |
| `wZeOwqmSw84` | `danmartell`  | Learn 97% of Claude in Under 16 Minutes                                 |
| `mydzICwDb6c` | `danmartell`  | Brutally Honest Advice For Someone Trying to Make Money with AI         |
| `cCSgnEkxMlk` | `sharran`     | Teach kids to create value, not just complete tasks                     |
| `WpoZUki2PoE` | `sharran`     | Great leaders create hope by helping people see                         |
| `vbcelc94VRQ` | `sharran`     | Can the Internet Really Buy an Airline?                                 |
| `ISQkh8bu6EU` | `sharran`     | The Millionaire Mindset I'm Teaching My Kids                            |

### 2.3 Article & Collection Slugs

Custom document indices mapping fleet guidelines and runbooks inside YKE:

| Slug                      | Label                              | Contents / Focus                                        |
| ------------------------- | ---------------------------------- | ------------------------------------------------------- |
| `openclaw-fleet`          | OpenClaw Fleet Protocols           | Core playbooks like `RAF_LOOP.md`, `AUTONOMY_BOUNDS.md` |
| `openclaw-security`       | OpenClaw Fleet Security            | Hardening documents, Tailscale ACLs, device audits      |
| `rapid-mlx-ops`           | Rapid-MLX Fleet Operations         | Local MLX inference server configurations and ports     |
| `fleet-model-economy`     | Fleet Model Routing & Cost Economy | Model ladders, per-agent configs, cost safeguards       |
| `cursor-dispatch-runbook` | Cursor Dispatch L1 Runbook         | Coding contracts, parity rules, and task queues         |
| `gtm-lane-contract`       | GTM Lane Contract                  | Creative director guidelines, GTM queues, advisors      |

---

## 3. Surfaced YKE Knowledge Items

The following net-new or detailed grounding items were retrieved from the data plane, focusing on hardware constraints, cost economies, and agent loop optimizations.

### Knowledge Item 1: Rapid-MLX Memory & Inference Concurrency Controls

- **Context:** Following the Ollama sunset on 2026-06-27, the fleet transitioned to **Rapid-MLX** for local chat and code models. Unlike Ollama's silent queuing, Rapid-MLX requires explicit token and concurrency parameters to prevent metal memory spikes and hard macOS Out of Memory (OOM) crashes.
- **YKE Playbook / Invariant details:**
  - `--max-num-seqs 2` sets the maximum in-flight KV sequence count for chat models.
  - `--max-concurrent-requests 4` enforces backpressure, returning `HTTP 503` + `Retry-After` when saturated. This triggers OpenClaw's cloud fallback chains immediately rather than hanging the agent thread.
  - `--chunked-prefill-tokens 2048` smooths Apple Silicon GPU Metal memory allocation spikes during large tool-heavy prompt prefills.
  - `--gpu-memory-utilization 0.90` bounds the model server process space.
  - **Per-host Prefix Caching:** MacBook (48GB RAM) is allocated **4 GB** (`--cache-memory-mb 4096`), while the Mini (24GB RAM) is capped at **2 GB** (`--cache-memory-mb 2048`). Coding models (llama-3.1-8b) are restricted to `--max-num-seqs 1` to ensure stability.

### Knowledge Item 2: Manifest-Based Cost Economy & Model Ladders

- **Context:** System configuration policies enforce a tiered "cost ladder" to dynamically route tasks to the cheapest possible model that can execute them successfully.
- **YKE Playbook / Invariant details:**
  - **Manifest Routing:** A local router at `:2099` (run via `apply-manifest-policy.py`) intercepts queries and runs a prompt complexity evaluator before execution.
  - **Routing Tiers:**
    - _Simple:_ Routed to local `gemma4:12b` (fallback to `openrouter/free`). Cost is $0.
    - _Standard:_ Routed to `google/gemini-2.5-flash-lite`. Most channel agents with tool lists execute here, making standard runs ~30× cheaper than legacy GPT-4o paths.
    - _Complex:_ Routed to `google/gemini-2.5-flash`.
    - _Reasoning:_ Routed to `openrouter/o4-mini` (fallback to `Mistral Large` or `Gemini Flash`).
  - **Premium Gating:** Premium models (Claude Sonnet 4.6, Claude Opus) are strictly excluded from automated fallback chains. They can only be invoked by explicit `/model` commands or custom subagent spawns to prevent accidental billing spikes.

### Knowledge Item 3: Heartbeat Token Compaction & Context Pruning

- **Context:** Constant background execution loops (TICK tier) create significant context and token bloat. The data plane enforces heartbeat and context safeguards.
- **YKE Playbook / Invariant details:**
  - **Heartbeat Restrictions:** Workers are restricted to `ackMaxChars: 160` (and `320` for Kai) to cap the size of heartbeat replies. Tool warning payloads are suppressed (`suppressToolErrorWarnings: true`). Reasoning blocks are disabled for normal heartbeat runs.
  - **Context Safeguard Mode:** In `openclaw.json` agent defaults, `compaction.mode: "safeguard"` is configured. It soft-trims history by 40% when context limit is approached and hard-clears by 60% if exceeded. It sets a context TTL of 30 minutes and retains only the last 2 assistant turns, dropping legacy conversation history.
  - **Agent Concurrency Limits:** The Mac Mini is hardware-constrained to a maximum concurrency of `2` task runs, `1` active subagent, and `1` cron parallel execution, avoiding resource lockouts.
