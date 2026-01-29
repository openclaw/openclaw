# Moltbot Evaluation for Calgary Pulse Council Pipeline

## Executive Summary

**Recommendation: Moltbot is overengineered for this use case.** It's a persistent messaging gateway (WhatsApp, Telegram, Discord, etc.) with an embedded AI agent — not a data processing pipeline tool. While it has useful components (RAG, scheduling, Telegram), the core architecture is designed for conversational AI assistants, not document processing pipelines.

**Simpler alternatives exist** and should be pursued first.

---

## Phase 1: Verified Claims About Moltbot Architecture

### Claim 1: "CLI over MCP approach avoids context bloat"
**❌ Inaccurate.** Moltbot does not use MCP (Model Context Protocol) at all. Tools are registered as TypeBox schemas and passed directly to the underlying `pi-coding-agent` SDK as function definitions — the same approach every other tool-use framework uses. There is no "CLI over MCP" pattern. Context management is handled via standard compaction (summarizing old turns) and pruning, with a configurable context window guard (hard min 16k tokens, warn below 32k).

### Claim 2: "Built-in RAG layer with sqlite-vec"
**✅ Accurate.** The `src/memory/` module uses `sqlite-vec` for vector storage with hybrid search (FTS + vector). Supports OpenAI embeddings (`text-embedding-3-small`), Gemini, and local llama-cpp. Markdown files are chunked by token count with overlap. Search is exposed via `memory_search` and `memory_get` tools.

**However:** The RAG is designed for `MEMORY.md` and `memory/*.md` files in a workspace — curated notes the agent writes about conversations. It is not a general-purpose document ingestion system. You'd need to manually convert council PDFs to markdown and place them in the memory directory. There's no PDF ingestion pipeline.

### Claim 3: "Persistent memory via user.md, soul.md, memory/"
**✅ Partially accurate.** Bootstrap files injected into system prompt per session:
- `SOUL.md` — agent persona/tone
- `USER.md` — user profile (name, timezone, context)
- `AGENTS.md` — workspace operating instructions
- `MEMORY.md` — curated long-term memory (main session only, not loaded in group chats for security)
- `HEARTBEAT.md` — periodic check reminders
- `IDENTITY.md`, `TOOLS.md`, `BOOTSTRAP.md`

These are injected as system prompt context, not dynamically retrieved. The agent can update them via file write tools. This is useful for domain knowledge accumulation over time.

### Claim 4: "Self-modifying configuration"
**✅ Accurate.** The agent has a `gateway` tool with actions: `config.get`, `config.patch`, `config.apply`, `config.schema`, `update.run`, `restart`. It can modify its own config, trigger gateway restarts, and even update itself. Some changes are hot-reloaded; others require full restart.

### Claim 5: "Invisible sub-agent orchestration"
**✅ Accurate.** Via `sessions_spawn` tool, the agent can create child sessions with their own session keys, run them with restricted tool policies and minimal system prompts, and receive completion announcements with metrics (duration, tokens, cost). Sub-agents only get `AGENTS.md` + `TOOLS.md` (not `SOUL.md` or `MEMORY.md`).

### Claim 6: "Skills/plugin system"
**✅ Accurate.** Two systems:
- **Skills**: `SKILL.md` files in workspace — instructions (not tools) that the agent follows. Loaded into system prompt.
- **Plugins**: Full extension system (`extensions/`) that can provide tools, hooks, channel extensions, and providers. Loaded from bundled extensions, HTTP registry, or local paths. Tool allowlists control activation.

---

## Phase 2: Use Case Evaluation

### Why Council Pipeline is a Poor Fit for Moltbot

1. **Moltbot is a messaging gateway**, not a data pipeline. Its core loop: receive message → run agent → reply. Adapting it for "ingest PDF → extract structured data → output JSON" means fighting the architecture.

2. **No PDF ingestion.** The RAG system only handles markdown files placed manually in the workspace. You'd need external tooling to convert PDFs anyway.

3. **No structured output mode.** The agent produces conversational text responses. Getting reliable JSON extraction requires prompt engineering and output parsing — the same work you'd do with a direct API call.

4. **Operational overhead.** Running a gateway daemon, WebSocket server, device pairing, channel authentication — all for a batch processing job that could be a simple script.

5. **The RAG is conversational**, not analytical. It's designed for "what did we discuss last week?" not "extract all motions from this 200-page council transcript."

### Better Approach: Direct Pipeline

For the council meetings pipeline, a direct approach is simpler and more reliable:

```
[Cron/Scheduler]
  → [Python/Node script]
    → Download council PDFs
    → Convert to text (pdf-parse, PyMuPDF, or marker)
    → Split into sections
    → Send to Claude API (Sonnet 4) with structured output schema
    → Validate JSON output
    → Write to staging directory
    → Send Telegram notification via bot API
```

**Advantages over Moltbot:**
- No gateway daemon to maintain
- No WebSocket protocol overhead
- Direct structured output via Claude API tool_use/JSON mode
- Simple error handling and retry logic
- Easy to test, debug, and modify
- No dependency on Moltbot project continuity
- 10x less code and configuration

### Where Moltbot Could Add Value (Later)

If you want a **conversational interface** to the council data after extraction — "ask questions about last week's council meeting" via Telegram — then Moltbot's RAG + Telegram integration becomes relevant. But this is a Phase 2 concern, after the extraction pipeline works.

---

## Risk Assessment

### Security Concerns

1. **Gateway exposure**: Default binds to `127.0.0.1:18789`. If misconfigured to bind to `0.0.0.0`, the full agent is exposed. The `--bind` flag controls this. Use `--bind loopback`.

2. **Tool policy defaults**: Without explicit tool policies, the agent has access to read/write/exec tools — it can run arbitrary shell commands. For an isolated VM this is acceptable; for shared infrastructure it's dangerous.

3. **Self-modification risk**: The agent can modify its own config and trigger updates. On an isolated VM this is a feature; in production it's a liability.

4. **Memory poisoning**: If the agent writes to `MEMORY.md` based on untrusted input (e.g., content from council documents), those memories persist and influence future sessions. Mitigate by reviewing memory files periodically.

5. **Credential storage**: API keys stored in `~/.clawdbot/.env`. Standard file permissions apply. No vault integration.

6. **No recent CVEs found in codebase**, but the project has had security advisories around exposed control panels (mentioned in docs).

### Reliability Concerns

1. **Project maturity**: Active development, frequent breaking changes (renamed from Clawdbot to Moltbot). APIs may shift.

2. **Dependency on pi-coding-agent**: Core agent loop delegates to `@mariozechner/pi-coding-agent` — an external dependency. If it breaks or changes, Moltbot breaks.

3. **Single maintainer risk**: Evaluate bus factor before depending on this for production workflows.

---

## Answers to Your Questions

### 1. Is Moltbot the right tool for this?
**No, not as the primary pipeline tool.** It's overengineered for document processing. Use direct Claude API calls for extraction, and consider Moltbot only for the conversational Q&A layer later.

### 2. Realistic effort to get Moltbot working for this?
- **Moltbot setup**: 4-8 hours (VM, install, configure, Telegram, model auth)
- **Custom skill for council docs**: 8-16 hours (PDF handling, extraction prompts, output formatting, testing)
- **RAG seeding**: 4-8 hours (convert docs to markdown, configure memory search)
- **End-to-end testing**: 8-16 hours
- **Total: 24-48 hours** for a fragile pipeline

**Direct pipeline alternative: 8-16 hours** for a robust, testable solution.

### 3. Ongoing maintenance?
- Moltbot updates (breaking changes, security patches)
- Gateway daemon monitoring
- Memory file review
- Model API key rotation
- Session cleanup

### 4. Simpler alternatives?
Yes. A Node/Python script that:
1. Downloads council PDFs on a cron schedule
2. Converts to text
3. Sends sections to Claude API with a structured output schema
4. Validates and writes JSON
5. Sends Telegram notification via `@grammyjs/core` or `node-telegram-bot-api`

This is 200-400 lines of code, runs as a simple cron job, and has zero daemon overhead.

### 5. Failure mode if Moltbot stalls?
If Moltbot project stalls, you'd need to:
- Fork and maintain (significant effort — 73 source files for Telegram alone)
- Or migrate to the direct pipeline approach anyway

With the direct approach, you depend only on the Claude API (stable, commercial) and a Telegram bot library (mature ecosystem).

---

## Recommended Architecture

```
Phase 1: Direct Pipeline (Week 1-2)
├── council-pipeline/
│   ├── src/
│   │   ├── ingest.ts          # Download PDFs from city website
│   │   ├── extract.ts         # PDF → text conversion
│   │   ├── analyze.ts         # Claude API structured extraction
│   │   ├── validate.ts        # JSON schema validation
│   │   ├── notify.ts          # Telegram notifications
│   │   └── index.ts           # Orchestrator + cron
│   ├── schemas/
│   │   └── council-meeting.json  # Output schema
│   ├── output/                # Staging JSON
│   └── package.json
│
└── Deployment: Simple VM + cron + systemd service

Phase 2: Conversational Layer (Optional, Week 3-4)
├── Option A: Moltbot with RAG over extracted data
│   └── Feed Phase 1 JSON → markdown → Moltbot memory
│   └── Query via Telegram
│
├── Option B: Simple RAG bot (lighter weight)
│   └── sqlite-vec + Telegram bot + Claude API
│   └── 500 lines of code
```

---

## If You Still Want to Proceed with Moltbot

### VM Setup
- **OS**: Ubuntu 22.04+ or Debian 12
- **Node**: 22+ (required)
- **RAM**: 2GB minimum (4GB recommended for sqlite-vec)
- **Storage**: 20GB (documents + vector DB)
- **Install**: `sudo npm i -g moltbot@latest`
- **Onboard**: `moltbot onboard` (interactive wizard)

### Model Configuration
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
moltbot config set models.providers.anthropic.models '[{"id":"claude-sonnet-4-20250514"}]'
moltbot config set agents.defaults.model "anthropic/claude-sonnet-4-20250514"
```

### Telegram Setup
```bash
# Get bot token from @BotFather
moltbot config set telegram.accounts '[{"token":"BOT_TOKEN_HERE"}]'
```

### Security Hardening
```bash
moltbot config set gateway.bind loopback
moltbot config set gateway.auth.password "STRONG_PASSWORD"
moltbot config set tools.sandbox.enabled true
moltbot security audit --deep --fix
```

### Custom Skill (SKILL.md)
```markdown
---
name: council-extractor
description: Extract structured data from council meeting documents
---

# Council Meeting Extraction

When given a council meeting document:
1. Identify all motions (motion number, text, mover, seconder)
2. Record all votes (motion ref, for/against/abstain counts, result)
3. Extract bylaw references (number, title, reading stage, status)
4. Note any addresses or zoning changes mentioned
5. Generate a 3-paragraph summary suitable for newsletter

Output as JSON matching the schema in schemas/council-meeting.json
```

### Cron Setup
```bash
moltbot cron add \
  --name "council-check" \
  --schedule "0 6 * * *" \
  --message "Check for new council meeting documents and process them" \
  --session isolated
```

---

## Conclusion

**Use Moltbot for what it's good at** — persistent conversational AI with memory and messaging integration. **Don't use it as a data pipeline.** Build the extraction pipeline directly, then optionally layer Moltbot on top for the Q&A/notification interface.

The "Claude Code (Opus) supervises Moltbot (Sonnet)" architecture is sound in principle but premature for this use case. Get the extraction working first with a simple script, then evaluate whether the conversational layer justifies Moltbot's operational complexity.
