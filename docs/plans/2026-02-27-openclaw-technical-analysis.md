# OpenClaw Technical Analysis Document — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `docs/how-openclaw-works.md` (EN + zh-CN) with a comprehensive technical analysis document covering overview, deployment, features/comparison, technical deep-dive, performance testing, and alternatives.

**Architecture:** Single markdown file with 6 parts. Part 1 retains/polishes existing overview. Parts 2-6 add technical depth. Style is conceptual and mental-model driven — minimal code, heavy on analogies. Performance testing (Part 5) requires actually running OpenClaw with cloud (Claude Sonnet) and local (Ollama qwen3:8b) models. EN main version written first, then zh-CN translation.

**Tech Stack:** Markdown, OpenClaw CLI (for performance tests), Ollama.

---

### Task 1: Write Part 1 — Overview

**Files:**
- Modify: `docs/how-openclaw-works.md`

**Step 1: Read the existing file**

Read `docs/how-openclaw-works.md` to get the current content.

**Step 2: Rewrite the file with Part 1**

Replace the entire file. Start with a document title and a brief intro paragraph explaining the two-layer structure (overview for newcomers, deep-dive for the curious). Then include all 5 existing sections with these adjustments:

- Title: `# How OpenClaw Works — A Technical Overview`
- Add intro paragraph after title explaining the document structure
- Section 1 "What is OpenClaw": keep as-is, but mention Feishu alongside other channels
- Section 2 "The Agent Workflow": keep as-is including ASCII diagram
- Section 3 "Memory and Context": keep as-is
- Section 4 "LLM-Driven Logic": add DeepSeek and Qwen to the provider list
- Section 5 "Local Computer Interaction": keep as-is

**Step 3: Verify the file reads correctly**

Read `docs/how-openclaw-works.md` end-to-end. Confirm Part 1 is complete and coherent.

**Step 4: Commit**

```bash
scripts/committer "docs: rewrite how-openclaw-works Part 1 overview" docs/how-openclaw-works.md
```

---

### Task 2: Write Part 2 — Deployment Guide

**Files:**
- Modify: `docs/how-openclaw-works.md`

**Reference docs** (read for accuracy, do NOT copy config verbatim):
- `docs/gateway/local-models.md` — local model setup concepts
- `docs/providers/ollama.md` — Ollama integration concepts
- `docs/providers/litellm.md` — LiteLLM concepts

**Step 1: Read reference docs for accuracy**

Read the three reference docs above to understand the actual deployment flow. Extract conceptual steps only — no JSON/config to copy into the document.

**Step 2: Append Part 2 to the document**

Append after Part 1, using `---` separator. Write three subsections:

**2.1 Cloud Model API Setup** (~2 paragraphs)
- List providers conversationally: Anthropic (Claude), OpenAI (GPT), Google (Gemini), Mistral, DeepSeek, Qwen/Tongyi, OpenRouter
- Describe setup as: run the interactive setup wizard or edit the config file, provide an API key (or OAuth for Google)
- Mention multi-profile: you can configure multiple accounts per provider for reliability

**2.2 Local Model Deployment** (~2 paragraphs)
- Supported engines: Ollama (recommended), LM Studio, vLLM, LiteLLM
- Mental model: "install a local inference engine, pull a model, and OpenClaw discovers it automatically"
- Walk through conceptual flow: install Ollama → pull a model (e.g. qwen3:8b) → set an environment variable → restart the Gateway → the model appears in your model list
- Mention auto-discovery: OpenClaw queries local engines for available models on startup

**2.3 Hybrid Mode** (~2 paragraphs)
- Mental model: "primary pilot + backup co-pilot"
- Describe: set a cloud model as primary, local as fallback (or vice versa). If the primary provider errors out, OpenClaw automatically switches to the next in the fallback chain.
- Cooldown and probe: a failed provider enters a cooldown period and is periodically retested before being restored to active duty

**Step 3: Verify**

Read the appended section. Check no raw JSON/config leaked in.

**Step 4: Commit**

```bash
scripts/committer "docs: add Part 2 deployment guide" docs/how-openclaw-works.md
```

---

### Task 3: Write Part 3 — Features and Comparison

**Files:**
- Modify: `docs/how-openclaw-works.md`

**Step 1: Append Part 3 to the document**

Three subsections:

**3.1 Core Features** (table)

| Feature | Description |
|---------|-------------|
| Multi-channel | 12+ messaging channels including WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Feishu, and more |
| Always-on | Background Gateway daemon — your assistant is always reachable |
| Tool System | Shell commands, file operations, browser automation, media understanding, scheduled tasks, webhooks |
| Persistent Memory | Three layers: identity files, conversation history, semantic search across all notes |
| Multi-model | 10+ providers (Anthropic, OpenAI, Google, DeepSeek, Qwen, Mistral...) with cloud and local model support |
| Plugin System | Extend with channel plugins, tool plugins, and lifecycle hooks |
| Local-first | All data — conversations, memory, tool output — stays on your machine |

**3.2 Comparison with Other Agent Frameworks** (~1.5 pages)

Write a one-sentence mental model for each, then a comparison table:

- **Auto-GPT** = "autonomous task runner" — launches one-shot missions, not always-on
- **LangChain Agent** = "developer toolkit" — a framework to build your own agent, not a ready-to-use product
- **Open Interpreter** = "smart terminal" — CLI-only, session-scoped, no persistent memory
- **Claude Code** = "AI pair programmer" — IDE/CLI focused, developer tool
- **OpenClaw** = "personal assistant that lives in your messaging apps"

Comparison table with dimensions: Positioning, Multi-channel, Always-on, Persistent Memory, Local Models, Local-first Data, Plugin System

**3.3 Strengths and Limitations** (~1 paragraph each)

Strengths: always-on presence across your messaging apps, multi-channel native support, local data sovereignty, mature 3-layer memory system, support for Chinese-region providers and channels (Qwen, DeepSeek, Feishu)

Limitations: single-user by design (not a team/enterprise platform), requires a local machine running the Gateway, initial setup has a learning curve

**Step 2: Verify**

Read the section. Check the comparison table is fair and factual. No marketing fluff.

**Step 3: Commit**

```bash
scripts/committer "docs: add Part 3 features and comparison" docs/how-openclaw-works.md
```

---

### Task 4: Write Part 4 — Technical Deep-Dive

**Files:**
- Modify: `docs/how-openclaw-works.md`

**Step 1: Append Part 4 to the document**

Three subsections, each leading with a mental model/analogy then adding developer details in parenthetical or "For developers:" callouts.

**4.1 Agent Architecture** (~1 page)

Mental model: **"think-act-observe loop"**

Describe the cycle conversationally:
1. Agent receives a message and assembles context — who am I (persona), what do I know (memory), what happened before (history)
2. Everything is sent to the language model
3. The model either replies directly or requests an action (a "tool call")
4. If an action is requested: execute it locally, observe the result, send it back to the model
5. Repeat until the model produces a final text reply

Analogy: "Like a chef reading a recipe step by step — taste, adjust, taste again — until the dish is done."

Developer callout: the event loop steps are workspace resolution → model resolution → auth profile selection → session lock acquisition → system prompt assembly → LLM inference ↔ tool execution loop → session persistence.

Include an ASCII diagram:

```
Message In
    |
    v
[Assemble Context]
    |
    v
[Send to LLM] ──> [Reply?] ──> Yes ──> Stream reply back
    |
    v No
[Execute Tool]
    |
    v
[Observe Result] ──> back to [Send to LLM]
```

**4.2 Scheduling System** (~1 page)

Mental model: **"one queue per conversation, one bouncer at the door"**

- Each conversation has its own queue. Messages are processed one at a time — no cutting in line. This prevents the agent from trying to do two things at once in the same conversation.
- The Gateway has a global concurrency limit (the "bouncer") — only a limited number of conversations can run simultaneously across all channels.
- When you send rapid-fire messages before the agent finishes, they're batched rather than creating chaos.

Three queue behaviors:
- **Collect** (default): gather all pending messages, deliver as one combined turn
- **Steer**: inject the new message into the currently-running turn — like slipping a note under the door
- **Followup**: wait patiently for the current turn to finish, then deliver as the next turn

Developer callout: session serialization uses file-based exclusive locks (POSIX `wx` mode) with PID tracking and 30-minute stale detection. The lane abstraction provides per-session + global concurrency control. Generation tokens prevent stale tasks from interfering after process restarts.

**4.3 Memory Management** (~1 page)

Mental model: **"a notebook, a filing cabinet, and a librarian"**

- **The Notebook** (bootstrap files): Opened at the start of every conversation. Contains who you are, how to behave, and what you've learned over time. These are plain text files in your workspace — you can read and edit them yourself. Think of it as the agent's "morning briefing."

- **The Filing Cabinet** (session history): Every conversation is filed away as a transcript. When the cabinet gets full (the model's context window fills up), the agent writes a summary and archives the old transcripts. But before archiving, it re-reads its notes and saves anything important to the Notebook — this is the "memory flush," ensuring nothing critical is lost in compression.

- **The Librarian** (semantic search): Indexes everything with vector embeddings — mathematical representations of meaning. When the agent needs to recall something from weeks ago, it searches by meaning, not just keywords. The search combines keyword matching (30% weight) with semantic similarity (70% weight) for the best results.

Developer callout:
- Temporal decay: older notes naturally score lower via exponential decay (configurable half-life, default 30 days)
- MMR (Maximal Marginal Relevance): re-ranks results to prevent redundant snippets from dominating
- Embedding providers: cloud (OpenAI, Gemini, Voyage, Mistral) or fully local (node-llama-cpp)
- Storage: SQLite database with the sqlite-vec extension for vector similarity search

**Step 2: Verify**

Read the full section. Confirm: no code snippets, no config blocks, analogies are clear, developer callouts are concise.

**Step 3: Commit**

```bash
scripts/committer "docs: add Part 4 technical deep-dive" docs/how-openclaw-works.md
```

---

### Task 5: Run Performance Tests

**Files:**
- None (data collection only)

**Prerequisites:**
- Ollama installed and running locally with `qwen3:8b` model pulled
- OpenClaw Gateway running with Anthropic API key configured
- A test file available for the file operations use case

**Step 1: Verify Ollama is running with qwen3:8b**

```bash
ollama list | grep qwen3:8b
```

If not present:
```bash
ollama pull qwen3:8b
```

**Step 2: Verify OpenClaw can reach both models**

```bash
pnpm openclaw models list
```

Confirm both `anthropic/claude-sonnet-4-5` (or latest Sonnet) and `ollama/qwen3:8b` appear.

**Step 3: Create a test file for Use Case 2**

Create `/tmp/openclaw-perf-test.txt` with ~20 lines of sample text content.

**Step 4: Run Use Case 1 — Simple Q&A — Cloud**

Use OpenClaw CLI to send a factual question with the cloud model. Measure:
- Time to first token (TTFT)
- Total response time
- Response quality (subjective 1-5)

```bash
time pnpm openclaw agent --model anthropic/claude-sonnet-4-5 --message "What are the three laws of thermodynamics? Explain each in one sentence." --no-stream
```

Record the output and timing.

**Step 5: Run Use Case 1 — Simple Q&A — Local**

Same question with local model:

```bash
time pnpm openclaw agent --model ollama/qwen3:8b --message "What are the three laws of thermodynamics? Explain each in one sentence." --no-stream
```

Record output and timing.

**Step 6: Run Use Case 2 — File Operations — Cloud**

```bash
time pnpm openclaw agent --model anthropic/claude-sonnet-4-5 --message "Read the file /tmp/openclaw-perf-test.txt, add line numbers to every line, and write the result back to the same file." --no-stream
```

Record timing, tool call count, verify file correctness.

**Step 7: Run Use Case 2 — File Operations — Local**

Same task with local model:

```bash
time pnpm openclaw agent --model ollama/qwen3:8b --message "Read the file /tmp/openclaw-perf-test.txt, add line numbers to every line, and write the result back to the same file." --no-stream
```

Record timing, tool call count, verify file correctness.

**Step 8: Record all results**

Compile results into a structured format for Task 6 to use.

---

### Task 6: Write Part 5 — Performance Testing

**Files:**
- Modify: `docs/how-openclaw-works.md`

**Step 1: Append Part 5 to the document**

Use the real data from Task 5.

**Test Environment** (~1 paragraph)
- Describe the hardware (e.g., Mac Mini M2, 16GB RAM)
- Cloud model: Claude Sonnet via Anthropic API
- Local model: qwen3:8b via Ollama
- Network conditions

**Use Case 1: Simple Q&A** (~1 paragraph + mini table)
- Describe the prompt and what it tests (pure LLM reasoning, no tools)
- Results table: TTFT, total time, quality for cloud vs local
- Brief commentary

**Use Case 2: File Operations** (~1 paragraph + mini table)
- Describe the prompt and what it tests (tool calling + reasoning)
- Results table: total time, tool calls, accuracy for cloud vs local
- Brief commentary

**Analysis** (~1 paragraph)
- When cloud makes sense (complex reasoning, high accuracy needed)
- When local makes sense (privacy, offline, cost, acceptable tasks)
- The hybrid approach: use cloud for important tasks, local for routine

**Step 2: Verify**

Read the section. Confirm real data is used, no placeholders remain.

**Step 3: Commit**

```bash
scripts/committer "docs: add Part 5 performance testing" docs/how-openclaw-works.md
```

---

### Task 7: Write Part 6 — Alternatives Comparison

**Files:**
- Modify: `docs/how-openclaw-works.md`

**Step 1: Append Part 6 to the document**

**Section title**: "Alternatives and When to Choose What"

Brief profile for each alternative (~2-3 sentences each):
- **Auto-GPT**: Designed for autonomous multi-step task execution. Launches "missions" that run to completion. Best for one-shot complex tasks; lacks always-on presence and multi-channel support.
- **Open Interpreter**: A lightweight CLI agent that can run code and interact with your computer. Session-scoped with no persistent memory. Best for quick developer tasks in the terminal.
- **LangChain Agent**: A framework for building custom AI agents, not a ready-to-use product. Extremely flexible but requires significant development effort. Best for teams building bespoke agent applications.
- **Claude Code**: Anthropic's developer-focused CLI/IDE tool for coding tasks. Deep IDE integration, optimized for software engineering. Best for developers who want an AI pair programmer.

Comparison table:

| Dimension | OpenClaw | Auto-GPT | Open Interpreter | LangChain Agent | Claude Code |
|-----------|----------|----------|-----------------|-----------------|-------------|
| Positioning | Personal always-on assistant | Autonomous task runner | Smart terminal | Developer framework | AI pair programmer |
| Multi-channel | 12+ native | None | None | Build your own | None |
| Always-on | Yes (Gateway daemon) | No (run-to-complete) | No (session) | Depends on impl | No (session) |
| Persistent Memory | 3-layer system | Short-term + vector | Session only | Build your own | Session + project |
| Local Models | Native (Ollama, vLLM...) | Limited | Yes | Via wrappers | No |
| Local-first Data | Yes | Partial | Yes | Depends | Yes |

"When to choose what" closing paragraph: OpenClaw if you want an always-on assistant across messaging apps with persistent memory. Claude Code if you're a developer wanting AI in your IDE. Open Interpreter for quick CLI tasks. LangChain if you're building a custom agent product. Auto-GPT for autonomous mission execution.

**Step 2: Verify**

Read the section. Confirm it's balanced and factual.

**Step 3: Commit**

```bash
scripts/committer "docs: add Part 6 alternatives comparison" docs/how-openclaw-works.md
```

---

### Task 8: Final Review and Polish (EN)

**Files:**
- Modify: `docs/how-openclaw-works.md`

**Step 1: Read the entire document end-to-end**

Check for:
- Coherent flow from Part 1 through Part 6
- No code snippets or raw config blocks leaked in
- Analogies are consistent (notebook/filing cabinet/librarian used in both Part 1 and Part 4)
- Chinese providers (Qwen, DeepSeek) and Feishu mentioned naturally
- Total length is ~10-12 pages
- Accessible to non-programmers, developer callouts clearly marked
- No personal device names, hostnames, or internal file paths

**Step 2: Fix any issues**

Edit inline.

**Step 3: Commit if changes were made**

```bash
scripts/committer "docs: polish technical analysis EN version" docs/how-openclaw-works.md
```

---

### Task 9: Write Chinese Translation

**Files:**
- Modify: `docs/how-openclaw-works.zh-CN.md`

**Step 1: Read the final EN version**

Read `docs/how-openclaw-works.md` to get the complete final text.

**Step 2: Translate the entire document to Chinese**

Translation guidelines:
- Keep technical terms in English: Agent, Gateway, LLM, Ollama, API, OAuth, TTFT, MMR, BM25, CLI, SSH, WebSocket, SQLite, Markdown, Cron, Webhook
- Keep product/project names in English: OpenClaw, Auto-GPT, LangChain, Open Interpreter, Claude Code, Claude Sonnet, Qwen, DeepSeek, Feishu/飞书 (use both)
- Keep ASCII diagrams as-is (translate labels within diagrams to Chinese)
- Tables: translate headers and content
- Natural, fluent Chinese — not word-for-word translation
- Match the conceptual/analogy-driven style

**Step 3: Verify**

Read the zh-CN version end-to-end. Confirm it's complete, natural, and matches EN structure.

**Step 4: Commit**

```bash
scripts/committer "docs: update Chinese translation of technical analysis" docs/how-openclaw-works.zh-CN.md
```
