# Design: OpenClaw Technical Analysis Document

**Date**: 2026-02-27
**Status**: Approved
**Audience**: Tech-curious non-programmers + professional developers
**Format**: Replace existing how-openclaw-works.md (EN) + .zh-CN.md
**Style**: Conceptual and mental-model driven, minimal code/config, heavy use of analogies and diagrams
**Length**: ~10-12 pages (EN), same for zh-CN

## Key Constraints

- Minimize code snippets and config examples; describe concepts and mental models
- Readable by non-programmers, useful for developers to quickly grasp architecture
- Include Chinese providers (Qwen/Tongyi, DeepSeek) and Feishu channel in examples
- Performance testing: 2 use cases only (simple Q&A + file operations), local model = Ollama qwen3:8b
- EN main version + zh-CN translation, both updated simultaneously

## Document Structure

### Part 1: Overview (retain + polish existing 5 sections)

Keep existing content from how-openclaw-works.md, add a brief intro paragraph explaining the document has two layers: a high-level overview (Part 1) and a technical deep-dive (Parts 2-6).

Sections unchanged:
1. What is OpenClaw
2. The Agent Workflow (with ASCII diagram)
3. Memory and Context
4. LLM-Driven Logic
5. Local Computer Interaction

### Part 2: Deployment Guide (~1.5 pages)

**Style**: Conceptual steps, no raw JSON/config blocks.

**2.1 Cloud Model API Setup**
- Supported providers: Anthropic (Claude), OpenAI (GPT), Google (Gemini), Mistral, DeepSeek, Qwen/Tongyi, OpenRouter
- Setup concept: interactive wizard or config file, API key or OAuth
- Multi-profile: rotate between provider accounts for reliability

**2.2 Local Model Deployment**
- Supported engines: Ollama (recommended), LM Studio, vLLM, LiteLLM
- Mental model: "install a local engine, pull a model, OpenClaw discovers it automatically"
- Auto-discovery: OpenClaw queries local engines for available models on startup
- Example flow: install Ollama -> pull qwen3:8b -> set env var -> restart Gateway -> model appears

**2.3 Hybrid Mode (Cloud + Local)**
- Mental model: "primary pilot + backup co-pilot"
- Cloud as primary, local as fallback (or vice versa)
- Automatic failover: if cloud provider errors out, switches to local seamlessly
- Cooldown and probe: failed provider cools down, periodically retested

### Part 3: Features and Comparison (~2 pages)

**3.1 Core Features Summary** (table)

| Feature | Description |
|---------|-------------|
| Multi-channel | 12+ channels: WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Feishu, etc. |
| Always-on | Background Gateway daemon, always reachable |
| Tool System | Shell, files, browser, media, cron, webhooks |
| Persistent Memory | 3-layer: bootstrap files, session history, semantic search |
| Multi-model | 10+ providers (Anthropic, OpenAI, Google, DeepSeek, Qwen, Mistral...), cloud+local mix |
| Plugin System | Channel plugins + tool plugins + lifecycle hooks |
| Local-first | All data on your machine |

**3.2 Comparison with Other Agent Frameworks**

Compare: Auto-GPT, LangChain Agent, Open Interpreter, Claude Code

Dimensions: positioning, multi-channel, memory, local models, deployment, always-on capability

Mental model for each:
- Auto-GPT = "autonomous task runner" (one-shot missions, not always-on)
- LangChain Agent = "developer toolkit" (build-your-own, not a product)
- Open Interpreter = "smart terminal" (CLI-only, session-scoped)
- Claude Code = "AI pair programmer" (IDE-focused, developer tool)
- OpenClaw = "personal assistant that lives in your messaging apps"

**3.3 Strengths and Limitations**
- Strengths: always-on + multi-channel + local data sovereignty + mature memory + China-region provider support
- Limitations: single-user design, requires local machine for Gateway, learning curve for initial setup

### Part 4: Technical Deep-Dive (~3 pages)

**Style**: Mental models and analogies first, technical terms in parentheses for developers.

**4.1 Agent Architecture**

Mental model: "think-act-observe loop"
- The agent receives a message and assembles context (who am I, what do I know, what happened before)
- It sends everything to the language model
- The model either replies directly or requests an action (tool call)
- If action requested: execute locally, feed result back, repeat
- Loop ends when the model produces a final text reply
- Analogy: "like a chef reading a recipe, tasting, adjusting, tasting again until the dish is done"

For developers: mention event loop steps (workspace resolution -> model resolution -> auth profile -> session lock -> prompt build -> inference <-> tool loop -> session persist)

**4.2 Scheduling System**

Mental model: "one queue per conversation, one bouncer at the door"
- Each conversation (session) has its own queue - messages are processed one at a time (no cutting in line)
- The Gateway has a global concurrency limit (the "bouncer") - only N conversations can run simultaneously
- When you send rapid-fire messages, they're debounced (batched into one turn) instead of creating chaos

Three queue behaviors:
- Collect (default): gather all pending messages, process as one batch
- Steer: inject new message into the currently-running turn (like passing a note)
- Followup: wait for current turn to finish, then process next

For developers: mention file-based session locks (wx mode), lane abstraction, generation tokens for restart safety

**4.3 Memory Management**

Mental model: "a notebook, a filing cabinet, and a librarian"
- **Notebook** (bootstrap files): opened at the start of every conversation - contains who you are, how to behave, what you've learned. Plain text files you can read and edit yourself.
- **Filing cabinet** (session history): every conversation is filed away as a transcript. When the cabinet gets full, the agent writes a summary and archives the old transcripts (compaction). Before archiving, it re-reads its notes to save anything important (memory flush).
- **Librarian** (semantic search): indexes everything with vector embeddings. When the agent needs to recall something from weeks ago, it searches by meaning (not just keywords). Combines keyword matching (30%) with semantic similarity (70%) for best results.

Additional details for developers:
- Temporal decay: older notes naturally fade (exponential decay, 30-day half-life)
- Diversity re-ranking (MMR): prevents redundant search results
- Embedding providers: cloud (OpenAI, Gemini, Voyage, Mistral) or local (node-llama-cpp)
- Storage: SQLite + sqlite-vec extension

### Part 5: Performance Testing (~1.5 pages)

**Test Environment**
- Hardware: describe the test machine
- Cloud model: Claude Sonnet (via Anthropic API)
- Local model: Ollama qwen3:8b
- Network: describe conditions

**Use Case 1: Simple Q&A**
- Prompt: a factual question with no tool calls needed
- Metrics: time-to-first-token (TTFT), total response time, response quality (subjective 1-5)
- Cloud vs Local comparison

**Use Case 2: File Operations**
- Prompt: read a file, make specific edits, write it back
- Metrics: total completion time, number of tool calls, accuracy of edits, quality
- Cloud vs Local comparison

**Results Table** (to be filled with real data)

| Metric | Cloud (Claude Sonnet) | Local (qwen3:8b) |
|--------|----------------------|-------------------|
| Q&A TTFT | | |
| Q&A total time | | |
| Q&A quality | | |
| File ops total time | | |
| File ops tool calls | | |
| File ops accuracy | | |

**Analysis**: brief commentary on when cloud vs local makes sense

### Part 6: Alternatives Comparison (optional, ~1 page)

Brief profiles of 4 alternatives:
- **Auto-GPT**: autonomous task execution, no always-on, limited channels
- **Open Interpreter**: lightweight CLI agent, no persistent memory, no multi-channel
- **LangChain Agent**: framework for building agents, flexible but requires significant development
- **Claude Code**: developer-focused CLI/IDE tool, not a general-purpose personal assistant

Comparison table with key dimensions, followed by "when to choose what" guidance.

## Implementation Notes

- Write EN version first, then translate to zh-CN
- Performance tests must be actually run (not theoretical)
- Keep diagrams in ASCII for portability
- Technical terms in Chinese version: keep Agent, Gateway, LLM, Ollama, API etc. in English
