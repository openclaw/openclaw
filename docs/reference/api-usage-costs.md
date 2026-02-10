---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Audit what can spend money, which keys are used, and how to view usage"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to understand which features may call paid APIs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to audit keys, costs, and usage visibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You’re explaining /status or /usage cost reporting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "API Usage and Costs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# API usage & costs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This doc lists **features that can invoke API keys** and where their costs show up. It focuses on（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw features that can generate provider usage or paid API calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Where costs show up (chat + CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Per-session cost snapshot**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/status` shows the current session model, context usage, and last response tokens.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the model uses **API-key auth**, `/status` also shows **estimated cost** for the last reply.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Per-message cost footer**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/usage full` appends a usage footer to every reply, including **estimated cost** (API-key only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/usage tokens` shows tokens only; OAuth flows hide dollar cost.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**CLI usage windows (provider quotas)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw status --usage` and `openclaw channels list` show provider **usage windows**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (quota snapshots, not per-message costs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Token use & costs](/reference/token-use) for details and examples.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How keys are discovered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can pick up credentials from:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Auth profiles** (per-agent, stored in `auth-profiles.json`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Environment variables** (e.g. `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Config** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `memorySearch.*`, `talk.apiKey`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Skills** (`skills.entries.<name>.apiKey`) which may export keys to the skill process env.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Features that can spend keys（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Core model responses (chat + tools)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Every reply or tool call uses the **current model provider** (OpenAI, Anthropic, etc). This is the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
primary source of usage and cost.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Models](/providers/models) for pricing config and [Token use & costs](/reference/token-use) for display.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Media understanding (audio/image/video)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inbound media can be summarized/transcribed before the reply runs. This uses model/provider APIs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Audio: OpenAI / Groq / Deepgram (now **auto-enabled** when keys exist).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Image: OpenAI / Anthropic / Google.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Video: Google.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Media understanding](/nodes/media-understanding).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) Memory embeddings + semantic search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Semantic memory search uses **embedding APIs** when configured for remote providers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memorySearch.provider = "openai"` → OpenAI embeddings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memorySearch.provider = "gemini"` → Gemini embeddings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memorySearch.provider = "voyage"` → Voyage embeddings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional fallback to a remote provider if local embeddings fail（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can keep it local with `memorySearch.provider = "local"` (no API usage).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Memory](/concepts/memory).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4) Web search tool (Brave / Perplexity via OpenRouter)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`web_search` uses API keys and may incur usage charges:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Brave Search API**: `BRAVE_API_KEY` or `tools.web.search.apiKey`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Perplexity** (via OpenRouter): `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Brave free tier (generous):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **2,000 requests/month**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **1 request/second**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Credit card required** for verification (no charge unless you upgrade)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Web tools](/tools/web).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5) Web fetch tool (Firecrawl)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`web_fetch` can call **Firecrawl** when an API key is present:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `FIRECRAWL_API_KEY` or `tools.web.fetch.firecrawl.apiKey`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If Firecrawl isn’t configured, the tool falls back to direct fetch + readability (no paid API).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Web tools](/tools/web).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 6) Provider usage snapshots (status/health)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Some status commands call **provider usage endpoints** to display quota windows or auth health.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These are typically low-volume calls but still hit provider APIs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw status --usage`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw models status --json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Models CLI](/cli/models).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 7) Compaction safeguard summarization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The compaction safeguard can summarize session history using the **current model**, which（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
invokes provider APIs when it runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Session management + compaction](/reference/session-management-compaction).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 8) Model scan / probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw models scan` can probe OpenRouter models and uses `OPENROUTER_API_KEY` when（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
probing is enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Models CLI](/cli/models).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 9) Talk (speech)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Talk mode can invoke **ElevenLabs** when configured:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ELEVENLABS_API_KEY` or `talk.apiKey`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Talk mode](/nodes/talk).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 10) Skills (third-party APIs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skills can store `apiKey` in `skills.entries.<name>.apiKey`. If a skill uses that key for external（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
APIs, it can incur costs according to the skill’s provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Skills](/tools/skills).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
