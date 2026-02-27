# OpenClaw Technical Brief Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a concise (~1200 words) bilingual (EN + zh-CN) technical brief about OpenClaw for sharing with colleagues and supervisors.

**Architecture:** 4 sections per file — tech overview, comparison, localization development, performance. Write EN first, then translate to zh-CN. Each section is one task + commit.

**Tech Stack:** Markdown only. No code, no tests — pure documentation.

**Reference:** Design doc at `docs/plans/2026-02-27-openclaw-technical-brief-design.md`. Long-form source at `docs/how-openclaw-works.md`.

---

### Task 1: Write Section 1 — OpenClaw Technical Overview (EN)

**Files:**
- Create: `docs/openclaw-technical-brief.md`

**Step 1: Write the file with Section 1 content**

Create `docs/openclaw-technical-brief.md` with the following content (~250 words):

```markdown
# OpenClaw — Technical Brief

## Technical Overview

OpenClaw is a local-first personal AI assistant built around a single background daemon called the Gateway. The Gateway owns every channel connection and all session state, running continuously as a menu-bar app on macOS or a system service on Linux. It connects to 12+ messaging channels — WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Feishu, and others — plus companion apps on macOS, iOS, and Android.

When you send a message, the Gateway routes it to the correct session and starts the agent's **think-act-observe loop**:

```
Message In → [Assemble Context] → [Send to LLM]
                                       |
                              Reply? ──Yes──→ Stream reply out
                                       |
                                      No
                                       ↓
                              [Execute Tool] → [Observe Result] → back to LLM
```

The agent assembles context (persona, memory, conversation history), sends it to the language model, and the model either replies or requests a tool action (shell command, file operation, browser automation). Tool results feed back for further reasoning. This loop repeats until the model produces a final reply.

**Model flexibility.** 10+ cloud providers (Anthropic, OpenAI, Google, DeepSeek, Qwen, Mistral, OpenRouter) plus local inference engines (Ollama, vLLM, LM Studio). Hybrid mode designates a primary model with automatic fallback — if the cloud provider fails, the Gateway switches to the next model mid-conversation, with cooldown and probe-based recovery.

**Memory system.** Three layers: (1) bootstrap files — Markdown files loaded at session start containing persona, instructions, user profile, and accumulated notes; (2) session history — conversation transcripts with automatic compaction that flushes important notes to memory before trimming; (3) semantic search — vector embeddings over workspace files enabling cross-session recall via hybrid keyword (30%) + vector similarity (70%) search.

**Scheduling.** Per-session serial queues ensure one turn at a time per conversation. A global concurrency limit controls how many sessions run simultaneously. Rapid-fire messages are debounced and batched.

**Tool system.** Shell commands, file operations, browser automation, media understanding, scheduled tasks (cron), and webhooks — sandboxed with per-channel policies that control what each session can do.
```

**Step 2: Verify word count**

Run: `wc -w docs/openclaw-technical-brief.md`
Expected: ~250 words (200-280 range acceptable)

**Step 3: Commit**

```bash
scripts/committer "docs: add Section 1 technical overview for brief" docs/openclaw-technical-brief.md
```

---

### Task 2: Write Section 2 — Comparison with Alternatives (EN)

**Files:**
- Modify: `docs/openclaw-technical-brief.md`

**Step 1: Append Section 2 content**

Append to `docs/openclaw-technical-brief.md` (~250 words):

```markdown
---

## Comparison with Alternatives

One-sentence mental models for context:

- **Auto-GPT** = autonomous task runner — launches one-shot missions that run to completion
- **LangChain Agent** = developer toolkit — a framework to build your own agent, not a ready-to-use product
- **Open Interpreter** = smart terminal — CLI-only, session-scoped, lightweight
- **Claude Code** = AI pair programmer — IDE/CLI focused, optimized for software engineering
- **OpenClaw** = personal assistant that lives in your messaging apps

| Dimension | OpenClaw | Auto-GPT | Open Interpreter | LangChain Agent | Claude Code |
|-----------|----------|----------|-----------------|-----------------|-------------|
| Positioning | Always-on personal assistant | Autonomous task runner | Smart terminal | Developer framework | AI pair programmer |
| Multi-channel | 12+ native (WhatsApp, Telegram, Slack, Feishu...) | None | None | Build your own | None |
| Always-on | Yes (Gateway daemon) | No (run-to-complete) | No (session) | Depends | No (session) |
| Persistent Memory | 3-layer system | Short-term + vector | Session only | Build your own | Session + project |
| Local Models | Native (Ollama, vLLM, LM Studio) | Limited | Yes | Via wrappers | No |
| Local-first Data | Yes | Partial | Yes | Depends | Yes |

**Strengths.** Always-on presence across messaging apps you already use, no special interface needed. Native support for Chinese ecosystem (Feishu channel, Qwen and DeepSeek providers). All data stays local. Three-layer memory provides cross-session continuity. Plugin architecture for extending channels, tools, and behaviors.

**Limitations.** Single-user by design — personal assistant, not a team platform. Requires always-on hardware. Steeper initial setup than hosted solutions. Local model quality depends on available hardware.
```

**Step 2: Verify cumulative word count**

Run: `wc -w docs/openclaw-technical-brief.md`
Expected: ~500 words (450-550 range)

**Step 3: Commit**

```bash
scripts/committer "docs: add Section 2 comparison for brief" docs/openclaw-technical-brief.md
```

---

### Task 3: Write Section 3 — Our Localization and Development (EN)

**Files:**
- Modify: `docs/openclaw-technical-brief.md`

**Step 1: Append Section 3 content**

Append to `docs/openclaw-technical-brief.md` (~350 words):

```markdown
---

## Our Localization and Development

### Feishu Extension

We contributed bug fixes and new features to OpenClaw's Feishu channel extension, enabling the assistant to work natively in the Chinese enterprise ecosystem. Key work includes fixing the `resolveAllowFrom` function to handle string-type allowlist values correctly (with test coverage), and adding public permission management actions (`get_public`, `update_public`) to the Feishu permission tool — allowing the agent to query and modify document sharing settings on behalf of the user. Four Feishu app accounts are configured and operational.

### Peekaboo — macOS UI Automation

Peekaboo is a visual automation skill that gives OpenClaw the ability to see and interact with any macOS application — even those without APIs. It captures screenshots of app windows or screen regions, identifies UI elements, and performs clicks and text input. This means the agent can operate graphical applications through the same natural language interface used for everything else.

Real-world usage on our setup includes: automating travel booking in Ctrip (携程旅行), browsing the macOS Photos library, creating and editing Calendar events, and launching and interacting with arbitrary macOS apps — all initiated from a chat message.

### Deployed Skills and Capabilities

Our Mac mini M4 (32 GB) runs 10 active skills:

| Skill | Capability |
|-------|-----------|
| Feishu Doc | Read and write Feishu documents |
| Feishu Drive | Cloud storage file management |
| Feishu Wiki | Knowledge base navigation |
| Feishu Perm | Document permission management |
| Peekaboo | macOS screen capture and UI automation |
| Himalaya | Email management via IMAP/SMTP |
| Coding Agent | Delegate tasks to Codex/Claude Code agents |
| Browser | Web browsing and search via Chrome extension |
| Weather | Current conditions and forecasts |
| Healthcheck | Host security hardening and risk assessment |

These skills combine to give the agent broad reach: writing Feishu documents and scheduling meetings, automating macOS apps via Peekaboo, sending and reading email, browsing the web, delegating coding tasks — all accessible from any connected messaging channel through natural language.
```

**Step 2: Verify cumulative word count**

Run: `wc -w docs/openclaw-technical-brief.md`
Expected: ~850 words (800-900 range)

**Step 3: Commit**

```bash
scripts/committer "docs: add Section 3 localization and development for brief" docs/openclaw-technical-brief.md
```

---

### Task 4: Write Section 4 — Performance Results (EN)

**Files:**
- Modify: `docs/openclaw-technical-brief.md`

**Step 1: Append Section 4 content**

Append to `docs/openclaw-technical-brief.md` (~250 words):

```markdown
---

## Performance Results

All benchmarks were collected on our Mac mini M4 (Apple Silicon) with 32 GB RAM on standard home broadband. Cloud model: Claude Sonnet 4.6 via Anthropic API through the OpenClaw Gateway (the same path a real user message takes). Local model: qwen3:8b (8B parameters) on Ollama, called through its local API.

### Simple Q&A

Prompt: explain the three laws of thermodynamics, each in one sentence.

| Metric | Cloud (Claude Sonnet) | Local (qwen3:8b) |
|--------|----------------------|-------------------|
| Response time | ~9 seconds | ~57 seconds |
| Quality | Excellent (5/5) — accurate, concise, bonus context | Good (4/5) — accurate, slightly verbose |
| Tokens generated | ~150 | ~949 (includes internal reasoning) |

### File Operations

Task: read a 20-line text file, add line numbers, write back. Tested end-to-end through the Gateway.

| Metric | Cloud (Claude Sonnet) | Local (qwen3:8b) |
|--------|----------------------|-------------------|
| Total time | ~12.5 seconds | ~60-70 seconds (estimated) |
| Tool calls | 2 (read + write) | Expected similar |
| Accuracy | Perfect | Not tested end-to-end |

### Analysis

Cloud models are roughly 6x faster with more polished output — the 9-second Q&A and 12.5-second file operation feel conversational. Local models trade speed for privacy and zero API cost. An 8B-parameter model handles factual tasks well; 70B+ models narrow the quality gap considerably. The practical sweet spot is hybrid mode: route complex tasks to the cloud, handle routine queries locally. OpenClaw's fallback system makes this seamless — configure once, the Gateway routes automatically.
```

**Step 2: Verify final word count**

Run: `wc -w docs/openclaw-technical-brief.md`
Expected: ~1100-1300 words

**Step 3: Commit**

```bash
scripts/committer "docs: add Section 4 performance results for brief" docs/openclaw-technical-brief.md
```

---

### Task 5: Review and polish EN document

**Files:**
- Modify: `docs/openclaw-technical-brief.md`

**Step 1: Read the complete document end-to-end**

Read `docs/openclaw-technical-brief.md` and check for:
- Word count is in the 1100-1300 range
- No duplicate content between sections
- ASCII diagram renders correctly in Markdown
- Tables are properly formatted
- Flow reads naturally from tech → comparison → development → performance
- No code blocks or config examples (design says conceptual/mental-model style)
- Chinese ecosystem references (Feishu, Qwen, DeepSeek, Ctrip) are present

**Step 2: Fix any issues found**

Apply targeted edits only. Do not rewrite sections that are already correct.

**Step 3: Commit if changes were made**

```bash
scripts/committer "docs: polish EN technical brief" docs/openclaw-technical-brief.md
```

---

### Task 6: Write Chinese translation

**Files:**
- Create: `docs/openclaw-technical-brief.zh-CN.md`

**Step 1: Translate the complete EN document to Chinese**

Create `docs/openclaw-technical-brief.zh-CN.md` — a full Chinese translation of the final EN document.

Translation guidelines:
- Keep technical terms in English where conventional: Agent, Gateway, LLM, API, Ollama, Peekaboo, Feishu, CLI, IMAP/SMTP, cron, webhook
- Translate section headings to Chinese
- Keep table structure identical
- Keep the ASCII diagram as-is (English labels are fine)
- Product names stay in English: OpenClaw, Auto-GPT, LangChain, Claude Code, Open Interpreter, Ctrip (add 携程旅行)
- "For developers:" → "**开发者注：**" (if present — design says minimal)
- "Our Localization and Development" → "我们的本地化开发工作"

**Step 2: Verify Chinese word/character count is proportional**

Run: `wc -m docs/openclaw-technical-brief.zh-CN.md`
(Chinese characters count differently; just verify the file looks complete)

**Step 3: Commit**

```bash
scripts/committer "docs: add Chinese translation of technical brief" docs/openclaw-technical-brief.zh-CN.md
```

---

### Task 7: Final review of both files

**Files:**
- Review: `docs/openclaw-technical-brief.md`
- Review: `docs/openclaw-technical-brief.zh-CN.md`

**Step 1: Read both files end-to-end**

Check:
- EN and zh-CN have identical structure (same sections, same tables, same diagram)
- No leftover English in the Chinese version (except technical terms)
- No leftover Chinese in the English version
- Both files have correct Markdown formatting
- Tables render correctly

**Step 2: Fix any issues**

**Step 3: Commit if changes were made**

```bash
scripts/committer "docs: final review fixes for technical brief" docs/openclaw-technical-brief.md docs/openclaw-technical-brief.zh-CN.md
```
