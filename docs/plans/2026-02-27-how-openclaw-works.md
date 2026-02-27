# "How OpenClaw Works" Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Write a concise (~1.5 page) standalone overview document introducing OpenClaw's architecture to new users and evaluators.

**Architecture:** Single markdown file with five sections: intro, agent workflow (with ASCII diagram), memory system, LLM logic, and local computer interaction. No code, no internal paths, no config snippets.

**Tech Stack:** Markdown only.

---

### Task 1: Write the document

**Files:**
- Create: `docs/how-openclaw-works.md`

**Step 1: Write Section 1 — What is OpenClaw**

One paragraph. Cover:
- Personal AI assistant running locally as a single gateway daemon
- Connects to messaging channels (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, etc.) and companion apps (macOS, iOS, Android)
- You message it like a person; it thinks, uses tools on your computer, and replies
- All data stays on your machine

**Step 2: Write Section 2 — The Agent Workflow**

Two paragraphs plus an ASCII flow diagram. Cover:
- Message lifecycle: user sends via any channel → Gateway receives and routes to a session → session is serialized (one turn at a time, no races) → agent runtime loads workspace context and session history → LLM inference produces text and/or tool calls → tools execute locally → results feed back into the model loop → final reply streams back through the channel to the user
- The Gateway is a single long-lived daemon that owns all channel connections and session state
- Include this ASCII diagram (or a cleaner version):

```
  You
   |
   v
Channel (WhatsApp, Telegram, Slack, ...)
   |
   v
Gateway (routes + serializes)
   |
   v
Agent Runtime
   |
   v
LLM Inference  <──>  Tool Execution
   |                    (shell, files,
   v                     browser, ...)
Reply streams back
   |
   v
Channel → You
```

**Step 3: Write Section 3 — Memory and Context**

Two paragraphs. Cover three layers:
1. **Bootstrap files** — On each new session, the agent loads a set of plain-text files from its workspace: persona and tone (SOUL.md), operating instructions (AGENTS.md), user profile (USER.md), and curated long-term memory (MEMORY.md). These give the agent its identity and accumulated knowledge.
2. **Session history** — Each conversation is stored as a transcript. When the transcript grows too large for the model's context window, OpenClaw automatically compacts it — but first prompts the agent to save any important notes to its memory files, so nothing critical is lost.
3. **Semantic search** — Workspace files are indexed with vector embeddings, enabling the agent to recall information from past sessions via hybrid keyword + vector search. This means the agent's memory extends beyond what fits in a single conversation.

**Step 4: Write Section 4 — LLM Model-Driven Logic**

One paragraph. Cover:
- The agent runtime sends the assembled system prompt + conversation history to the configured LLM
- The model decides what to do: reply with text, call a tool, or both
- If a tool is called, its result is fed back and the model continues reasoning — this loop repeats until the model produces a final text reply
- Supports multiple providers (Anthropic, OpenAI, Google, Mistral, etc.) with automatic fallback on errors
- Thinking/reasoning levels can be adjusted for more deliberate responses

**Step 5: Write Section 5 — Local Computer Interaction**

Two paragraphs. Cover:
- **Built-in tools**: Run shell commands, read/write/edit files, send messages through channels. The agent's default working directory is its workspace folder.
- **Extended capabilities**: Browser automation, web search and fetching, media understanding (images, PDFs, video), scheduled tasks (cron), and webhooks.
- **Safety**: Tool policies control what the agent is allowed to do on each channel or session. Optional sandboxing isolates execution. The agent operates within configured boundaries — it doesn't have unchecked access to your system.

**Step 6: Commit**

```bash
scripts/committer "docs: add How OpenClaw Works overview" docs/how-openclaw-works.md
```

---

### Task 2: Review and polish

**Step 1: Read the document end-to-end**

Check for:
- Total length is ~1.5 pages (roughly 600-800 words)
- No internal file paths, code snippets, or config examples leaked in
- No personal device names or hostnames
- Flow diagram is readable
- Each section is self-contained but flows naturally into the next
- Language is accessible to non-technical readers who are tech-curious

**Step 2: Fix any issues found**

Edit inline. Keep it concise.

**Step 3: Commit if changes were made**

```bash
scripts/committer "docs: polish How OpenClaw Works overview" docs/how-openclaw-works.md
```
