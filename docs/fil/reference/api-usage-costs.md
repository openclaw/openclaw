---
summary: "I-audit kung ano ang maaaring gumastos ng pera, aling mga key ang ginagamit, at kung paano tingnan ang usage"
read_when:
  - Gusto mong maunawaan kung aling mga feature ang maaaring tumawag sa mga paid API
  - Kailangan mong i-audit ang mga key, gastos, at visibility ng usage
  - Ipinapaliwanag mo ang /status o /usage na pag-uulat ng gastos
title: "API Usage at Mga Gastos"
x-i18n:
  source_path: reference/api-usage-costs.md
  source_hash: 908bfc17811b8f4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:57Z
---

# API usage at mga gastos

Inililista ng doc na ito ang **mga feature na maaaring mag-invoke ng API keys** at kung saan lumalabas ang kanilang mga gastos. Nakatuon ito sa
mga feature ng OpenClaw na maaaring lumikha ng provider usage o mga bayad na API call.

## Saan lumalabas ang mga gastos (chat + CLI)

**Per-session cost snapshot**

- Ipinapakita ng `/status` ang kasalukuyang session model, paggamit ng context, at mga token ng huling tugon.
- Kung gumagamit ang model ng **API-key auth**, ipinapakita rin ng `/status` ang **tinatayang gastos** para sa huling reply.

**Per-message cost footer**

- Nagdaragdag ang `/usage full` ng usage footer sa bawat reply, kabilang ang **tinatayang gastos** (API-key lang).
- Ipinapakita ng `/usage tokens` ang mga token lamang; itinatago ng OAuth flows ang dollar cost.

**CLI usage windows (provider quotas)**

- Ipinapakita ng `openclaw status --usage` at `openclaw channels list` ang **usage windows** ng provider
  (mga snapshot ng quota, hindi per-message na gastos).

Tingnan ang [Token use & costs](/reference/token-use) para sa mga detalye at halimbawa.

## Paano natutuklasan ang mga key

Maaaring makuha ng OpenClaw ang mga credential mula sa:

- **Auth profiles** (per-agent, naka-store sa `auth-profiles.json`).
- **Mga environment variable** (hal. `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Config** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Skills** (`skills.entries.<name>.apiKey`) na maaaring mag-export ng mga key sa skill process env.

## Mga feature na maaaring gumastos ng mga key

### 1) Mga core model response (chat + tools)

Bawat reply o tool call ay gumagamit ng **kasalukuyang model provider** (OpenAI, Anthropic, atbp.). Ito ang
pangunahing pinagmumulan ng usage at gastos.

Tingnan ang [Models](/providers/models) para sa pricing config at [Token use & costs](/reference/token-use) para sa display.

### 2) Media understanding (audio/image/video)

Maaaring i-summarize o i-transcribe ang inbound media bago tumakbo ang reply. Gumagamit ito ng mga model/provider API.

- Audio: OpenAI / Groq / Deepgram (ngayon ay **auto-enabled** kapag may mga key).
- Image: OpenAI / Anthropic / Google.
- Video: Google.

Tingnan ang [Media understanding](/nodes/media-understanding).

### 3) Memory embeddings + semantic search

Gumagamit ang semantic memory search ng **embedding API** kapag naka-configure para sa mga remote provider:

- `memorySearch.provider = "openai"` → OpenAI embeddings
- `memorySearch.provider = "gemini"` → Gemini embeddings
- `memorySearch.provider = "voyage"` → Voyage embeddings
- Opsyonal na fallback sa isang remote provider kung pumalya ang local embeddings

Maaari mo itong panatilihing local gamit ang `memorySearch.provider = "local"` (walang API usage).

Tingnan ang [Memory](/concepts/memory).

### 4) Web search tool (Brave / Perplexity via OpenRouter)

Gumagamit ang `web_search` ng mga API key at maaaring magkaroon ng usage charges:

- **Brave Search API**: `BRAVE_API_KEY` o `tools.web.search.apiKey`
- **Perplexity** (via OpenRouter): `PERPLEXITY_API_KEY` o `OPENROUTER_API_KEY`

**Brave free tier (mapagbigay):**

- **2,000 request/buwan**
- **1 request/segundo**
- **Kinakailangan ang credit card** para sa beripikasyon (walang singil maliban kung mag-upgrade ka)

Tingnan ang [Web tools](/tools/web).

### 5) Web fetch tool (Firecrawl)

Maaaring tawagin ng `web_fetch` ang **Firecrawl** kapag may API key:

- `FIRECRAWL_API_KEY` o `tools.web.fetch.firecrawl.apiKey`

Kung hindi naka-configure ang Firecrawl, babalik ang tool sa direct fetch + readability (walang bayad na API).

Tingnan ang [Web tools](/tools/web).

### 6) Provider usage snapshots (status/health)

May ilang status command na tumatawag sa **provider usage endpoints** para ipakita ang mga quota window o kalusugan ng auth.
Karaniwan ay mababa ang volume ng mga tawag na ito ngunit tumatama pa rin sa mga provider API:

- `openclaw status --usage`
- `openclaw models status --json`

Tingnan ang [Models CLI](/cli/models).

### 7) Compaction safeguard summarization

Maaaring i-summarize ng compaction safeguard ang session history gamit ang **kasalukuyang model**, na
nag-iinvoke ng mga provider API kapag tumatakbo ito.

Tingnan ang [Session management + compaction](/reference/session-management-compaction).

### 8) Model scan / probe

Maaaring i-probe ng `openclaw models scan` ang mga OpenRouter model at gumagamit ng `OPENROUTER_API_KEY` kapag
naka-enable ang probing.

Tingnan ang [Models CLI](/cli/models).

### 9) Talk (speech)

Maaaring i-invoke ng Talk mode ang **ElevenLabs** kapag naka-configure:

- `ELEVENLABS_API_KEY` o `talk.apiKey`

Tingnan ang [Talk mode](/nodes/talk).

### 10) Skills (third-party APIs)

Maaaring mag-store ang Skills ng `apiKey` sa `skills.entries.<name>.apiKey`. Kung ginagamit ng isang skill ang key na iyon para sa mga external
API, maaari itong magdulot ng mga gastos ayon sa provider ng skill.

Tingnan ang [Skills](/tools/skills).
