---
summary: "Audit what can spend money, which keys are used, and how to view usage"
read_when:
  - You want to understand which features may call paid APIs
  - You need to audit keys, costs, and usage visibility
  - You’re explaining /status or /usage cost reporting
title: "API Usage and Costs"
---

# API usage & costs

This doc lists **features that can invoke API keys** and where their costs show up. It focuses on
OpenClaw features that can generate provider usage or paid API calls.

## Where costs show up (chat + CLI)

**Per-session cost snapshot**

- `/status` shows the current session model, context usage, and last response tokens.
- If the model uses **API-key auth**, `/status` also shows **estimated cost** for the last reply.

**Per-message cost footer**

- `/usage full` appends a usage footer to every reply, including **estimated cost** (API-key only).
- `/usage tokens` shows tokens only; subscription-style OAuth, legacy token, and CLI flows hide dollar cost.
- Gemini CLI note: when the CLI returns JSON output, OpenClaw reads usage from
  `stats`, normalizes `stats.cached` into `cacheRead`, and derives input tokens
  from `stats.input_tokens - stats.cached` when needed.

Anthropic note: starting **April 4, 2026 at 12:00 PM PT / 8:00 PM BST**,
Anthropic says OpenClaw no longer uses included Claude subscription limits.
Anthropic subscription-auth traffic in OpenClaw now requires **Extra Usage**
billed separately from the subscription, but Anthropic does not expose a
per-message dollar estimate that OpenClaw can show in `/usage full`.

**CLI usage windows (provider quotas)**

- `openclaw status --usage` and `openclaw channels list` show provider **usage windows**
  (quota snapshots, not per-message costs).
- Human output is normalized to `X% left` across providers.
- MiniMax note: its raw `usage_percent` / `usagePercent` fields mean remaining
  quota, so OpenClaw inverts them before display. Count-based fields still win
  when present.

See [Token use & costs](/reference/token-use) for details and examples.

## How keys are discovered

OpenClaw can pick up credentials from:

- **Auth profiles** (per-agent, stored in `auth-profiles.json`).
- **Environment variables** (e.g. `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Config** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.providers.*.apiKey`).
- **Skills** (`skills.entries.<name>.apiKey`) which may export keys to the skill process env.

## Features that can spend keys

### 1) Core model responses (chat + tools)

Every reply or tool call uses the **current model provider** (OpenAI, Anthropic, etc). This is the
primary source of usage and cost.

This also includes subscription-style hosted providers that still bill outside
OpenClaw's local UI, such as **OpenAI Codex**, **Alibaba Cloud Model Studio
Coding Plan**, **MiniMax Coding Plan**, **Z.AI / GLM Coding Plan**, and
Anthropic subscription auth with **Extra Usage** enabled.

See [Models](/providers/models) for pricing config and [Token use & costs](/reference/token-use) for display.

### 2) Media understanding (audio/image/video)

Inbound media can be summarized/transcribed before the reply runs. This uses model/provider APIs.

- Audio: OpenAI / Groq / Deepgram (now **auto-enabled** when keys exist).
- Image: OpenAI / Anthropic / Google.
- Video: Google.

See [Media understanding](/nodes/media-understanding).

### 3) Memory embeddings + semantic search

Semantic memory search uses **embedding APIs** when configured for remote providers:

- `memorySearch.provider = "openai"` → OpenAI embeddings
- `memorySearch.provider = "gemini"` → Gemini embeddings
- `memorySearch.provider = "voyage"` → Voyage embeddings
- `memorySearch.provider = "mistral"` → Mistral embeddings
- `memorySearch.provider = "ollama"` → Ollama embeddings (local/self-hosted; typically no hosted API billing)
- Optional fallback to a remote provider if local embeddings fail

You can keep it local with `memorySearch.provider = "local"` (no API usage).

See [Memory](/concepts/memory).

### 4) Web search tool

`web_search` may incur usage charges depending on your provider:

- **Brave Search API**: `BRAVE_API_KEY` or `plugins.entries.brave.config.webSearch.apiKey`
- **Exa**: `EXA_API_KEY` or `plugins.entries.exa.config.webSearch.apiKey`
- **Firecrawl**: `FIRECRAWL_API_KEY` or `plugins.entries.firecrawl.config.webSearch.apiKey`
- **Gemini (Google Search)**: `GEMINI_API_KEY` or `plugins.entries.google.config.webSearch.apiKey`
- **Grok (xAI)**: `XAI_API_KEY` or `plugins.entries.xai.config.webSearch.apiKey`
- **Kimi (Moonshot)**: `KIMI_API_KEY`, `MOONSHOT_API_KEY`, or `plugins.entries.moonshot.config.webSearch.apiKey`
- **MiniMax Search**: `MINIMAX_CODE_PLAN_KEY`, `MINIMAX_CODING_API_KEY`, `MINIMAX_API_KEY`, or `plugins.entries.minimax.config.webSearch.apiKey`
- **Ollama Web Search**: key-free by default, but requires a reachable Ollama host plus `ollama signin`; can also reuse normal Ollama provider bearer auth when the host requires it
- **Perplexity Search API**: `PERPLEXITY_API_KEY`, `OPENROUTER_API_KEY`, or `plugins.entries.perplexity.config.webSearch.apiKey`
- **Tavily**: `TAVILY_API_KEY` or `plugins.entries.tavily.config.webSearch.apiKey`
- **DuckDuckGo**: key-free fallback (no API billing, but unofficial and HTML-based)
- **SearXNG**: `SEARXNG_BASE_URL` or `plugins.entries.searxng.config.webSearch.baseUrl` (key-free/self-hosted; no hosted API billing)

Legacy `tools.web.search.*` provider paths still load through the temporary compatibility shim, but they are no longer the recommended config surface.

**Brave Search free credit:** Each Brave plan includes \$5/month in renewing
free credit. The Search plan costs \$5 per 1,000 requests, so the credit covers
1,000 requests/month at no charge. Set your usage limit in the Brave dashboard
to avoid unexpected charges.

See [Web tools](/tools/web).

### 5) Web fetch tool (Firecrawl)

`web_fetch` can call **Firecrawl** when an API key is present:

- `FIRECRAWL_API_KEY` or `tools.web.fetch.firecrawl.apiKey`

If Firecrawl isn’t configured, the tool falls back to direct fetch + readability (no paid API).

See [Web tools](/tools/web).

### 6) Provider usage snapshots (status/health)

Some status commands call **provider usage endpoints** to display quota windows or auth health.
These are typically low-volume calls but still hit provider APIs:

- `openclaw status --usage`
- `openclaw models status --json`

See [Models CLI](/cli/models).

### 7) Compaction safeguard summarization

The compaction safeguard can summarize session history using the **current model**, which
invokes provider APIs when it runs.

See [Session management + compaction](/reference/session-management-compaction).

### 8) Model scan / probe

`openclaw models scan` can probe OpenRouter models and uses `OPENROUTER_API_KEY` when
probing is enabled.

See [Models CLI](/cli/models).

### 9) Talk (speech)

Talk mode can invoke **ElevenLabs** when configured:

- `ELEVENLABS_API_KEY` or `talk.providers.elevenlabs.apiKey`

See [Talk mode](/nodes/talk).

### 10) Skills (third-party APIs)

Skills can store `apiKey` in `skills.entries.<name>.apiKey`. If a skill uses that key for external
APIs, it can incur costs according to the skill’s provider.

See [Skills](/tools/skills).
