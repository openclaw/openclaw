---
summary: "Revidér hvad der kan bruge penge, hvilke nøgler der anvendes, og hvordan du ser forbrug"
read_when:
  - Du vil forstå hvilke funktioner der kan kalde betalte API’er
  - Du skal revidere nøgler, omkostninger og synlighed af forbrug
  - Du forklarer /status eller /usage-omkostningsrapportering
title: "API-brug og omkostninger"
x-i18n:
  source_path: reference/api-usage-costs.md
  source_hash: 908bfc17811b8f4b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:39Z
---

# API-brug og omkostninger

Dette dokument oplister **funktioner der kan aktivere API-nøgler**, og hvor deres omkostninger vises. Det fokuserer på
OpenClaw-funktioner, der kan generere udbyderforbrug eller betalte API-kald.

## Hvor omkostninger vises (chat + CLI)

**Omkostningssnapshot pr. session**

- `/status` viser den aktuelle sessionsmodel, kontekstforbrug og tokens for det seneste svar.
- Hvis modellen bruger **API-nøgle-autentificering**, viser `/status` også **estimeret omkostning** for det seneste svar.

**Omkostningsfodnote pr. besked**

- `/usage full` tilføjer en forbrugsfodnote til hvert svar, inkl. **estimeret omkostning** (kun API-nøgle).
- `/usage tokens` viser kun tokens; OAuth-flows skjuler dollaromkostninger.

**CLI-forbrugsvinduer (udbyderkvoter)**

- `openclaw status --usage` og `openclaw channels list` viser udbyderens **forbrugsvinduer**
  (kvote-snapshots, ikke pr.-besked-omkostninger).

Se [Token use & costs](/reference/token-use) for detaljer og eksempler.

## Hvordan nøgler opdages

OpenClaw kan hente legitimationsoplysninger fra:

- **Autentificeringsprofiler** (pr. agent, gemt i `auth-profiles.json`).
- **Miljøvariabler** (f.eks. `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Konfiguration** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Skills** (`skills.entries.<name>.apiKey`), som kan eksportere nøgler til skill-processens miljø.

## Funktioner der kan bruge nøgler

### 1) Kerne-modelsvar (chat + værktøjer)

Hvert svar eller værktøjskald bruger den **aktuelle modeludbyder** (OpenAI, Anthropic osv.). Dette er den
primære kilde til forbrug og omkostninger.

Se [Models](/providers/models) for prisopsætning og [Token use & costs](/reference/token-use) for visning.

### 2) Medieforståelse (lyd/billede/video)

Indgående medier kan opsummeres/transskriberes, før svaret køres. Dette bruger model-/udbyder-API’er.

- Lyd: OpenAI / Groq / Deepgram (nu **automatisk aktiveret**, når nøgler findes).
- Billede: OpenAI / Anthropic / Google.
- Video: Google.

Se [Media understanding](/nodes/media-understanding).

### 3) Hukommelses-embeddings + semantisk søgning

Semantisk hukommelsessøgning bruger **embedding-API’er**, når den er konfigureret til fjernudbydere:

- `memorySearch.provider = "openai"` → OpenAI-embeddings
- `memorySearch.provider = "gemini"` → Gemini-embeddings
- `memorySearch.provider = "voyage"` → Voyage-embeddings
- Valgfri fallback til en fjernudbyder, hvis lokale embeddings fejler

Du kan holde det lokalt med `memorySearch.provider = "local"` (ingen API-brug).

Se [Memory](/concepts/memory).

### 4) Websøgeværktøj (Brave / Perplexity via OpenRouter)

`web_search` bruger API-nøgler og kan medføre forbrugsomkostninger:

- **Brave Search API**: `BRAVE_API_KEY` eller `tools.web.search.apiKey`
- **Perplexity** (via OpenRouter): `PERPLEXITY_API_KEY` eller `OPENROUTER_API_KEY`

**Brave gratis niveau (generøst):**

- **2.000 forespørgsler/måned**
- **1 forespørgsel/sekund**
- **Kreditkort krævet** til verifikation (ingen opkrævning, medmindre du opgraderer)

Se [Web tools](/tools/web).

### 5) Web-fetch-værktøj (Firecrawl)

`web_fetch` kan kalde **Firecrawl**, når en API-nøgle er til stede:

- `FIRECRAWL_API_KEY` eller `tools.web.fetch.firecrawl.apiKey`

Hvis Firecrawl ikke er konfigureret, falder værktøjet tilbage til direkte fetch + readability (ingen betalt API).

Se [Web tools](/tools/web).

### 6) Udbyder-forbrugssnapshots (status/helbred)

Nogle statuskommandoer kalder **udbyderens forbrugsendepunkter** for at vise kvotevinduer eller autentificeringsstatus.
Disse er typisk lav-volumen-kald, men rammer stadig udbyder-API’er:

- `openclaw status --usage`
- `openclaw models status --json`

Se [Models CLI](/cli/models).

### 7) Komprimerings-sikringsopsummering

Komprimerings-sikringen kan opsummere sessionshistorik ved hjælp af den **aktuelle model**, hvilket
aktiverer udbyder-API’er, når den kører.

Se [Session management + compaction](/reference/session-management-compaction).

### 8) Modelscan / probe

`openclaw models scan` kan probe OpenRouter-modeller og bruger `OPENROUTER_API_KEY`, når
probing er aktiveret.

Se [Models CLI](/cli/models).

### 9) Talk (tale)

Talk-tilstand kan aktivere **ElevenLabs**, når den er konfigureret:

- `ELEVENLABS_API_KEY` eller `talk.apiKey`

Se [Talk mode](/nodes/talk).

### 10) Skills (tredjeparts-API’er)

Skills kan gemme `apiKey` i `skills.entries.<name>.apiKey`. Hvis en skill bruger den nøgle til eksterne
API’er, kan det medføre omkostninger i henhold til skillens udbyder.

Se [Skills](/tools/skills).
