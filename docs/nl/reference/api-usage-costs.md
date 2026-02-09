---
summary: "Controleer wat geld kan kosten, welke sleutels worden gebruikt en hoe je gebruik kunt bekijken"
read_when:
  - Je wilt begrijpen welke functies betaalde API’s kunnen aanroepen
  - Je moet sleutels, kosten en zichtbaarheid van gebruik auditen
  - Je legt /status- of /usage-kostenrapportage uit
title: "API-gebruik en kosten"
---

# API-gebruik & kosten

Dit document somt **functies op die API-sleutels kunnen aanroepen** en waar hun kosten zichtbaar zijn. Het richt zich op
OpenClaw-functies die providergebruik of betaalde API-aanroepen kunnen genereren.

## Waar kosten zichtbaar zijn (chat + CLI)

**Kostenoverzicht per sessie**

- `/status` toont het huidige sessiemodel, contextgebruik en tokens van de laatste reactie.
- Als het model **API-sleutel-authenticatie** gebruikt, toont `/status` ook **geschatte kosten** voor het laatste antwoord.

**Kostenvoetnoot per bericht**

- `/usage full` voegt aan elk antwoord een gebruiksvoetnoot toe, inclusief **geschatte kosten** (alleen API-sleutel).
- `/usage tokens` toont alleen tokens; OAuth-flows verbergen de dollarkosten.

**CLI-gebruiksvensters (providerquota)**

- `openclaw status --usage` en `openclaw channels list` tonen **gebruiksvensters** van providers
  (quota-snapshots, geen kosten per bericht).

Zie [Tokengebruik & kosten](/reference/token-use) voor details en voorbeelden.

## Hoe sleutels worden ontdekt

OpenClaw kan inloggegevens ophalen uit:

- **Auth-profielen** (per agent, opgeslagen in `auth-profiles.json`).
- **Omgevingsvariabelen** (bijv. `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Config** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Skills** (`skills.entries.<name>.apiKey`) die sleutels kunnen exporteren naar de process-env van de skill.

## Functies die sleutels kunnen verbruiken

### 1. Kernmodelreacties (chat + tools)

Elke reactie of tool-aanroep gebruikt de **huidige modelprovider** (OpenAI, Anthropic, enz.). Dit is de
primaire bron van gebruik en kosten.

Zie [Models](/providers/models) voor prijsconfiguratie en [Tokengebruik & kosten](/reference/token-use) voor weergave.

### 2. Media-understanding (audio/beeld/video)

Inkomende media kunnen worden samengevat/getranscribeerd voordat het antwoord wordt uitgevoerd. Dit gebruikt model-/provider-API’s.

- Audio: OpenAI / Groq / Deepgram (nu **automatisch ingeschakeld** wanneer sleutels aanwezig zijn).
- Beeld: OpenAI / Anthropic / Google.
- Video: Google.

Zie [Media understanding](/nodes/media-understanding).

### 3. Geheugen-embeddings + semantische zoekopdracht

Semantische geheugenzorg gebruikt **embedding-API’s** wanneer geconfigureerd voor externe providers:

- `memorySearch.provider = "openai"` → OpenAI-embeddings
- `memorySearch.provider = "gemini"` → Gemini-embeddings
- `memorySearch.provider = "voyage"` → Voyage-embeddings
- Optionele fallback naar een externe provider als lokale embeddings falen

Je kunt het lokaal houden met `memorySearch.provider = "local"` (geen API-gebruik).

Zie [Memory](/concepts/memory).

### 4. Webzoektool (Brave / Perplexity via OpenRouter)

`web_search` gebruikt API-sleutels en kan gebruikskosten veroorzaken:

- **Brave Search API**: `BRAVE_API_KEY` of `tools.web.search.apiKey`
- **Perplexity** (via OpenRouter): `PERPLEXITY_API_KEY` of `OPENROUTER_API_KEY`

**Brave gratis tier (royaal):**

- **2.000 verzoeken/maand**
- **1 verzoek/seconde**
- **Creditcard vereist** voor verificatie (geen kosten tenzij je upgrade)

Zie [Web tools](/tools/web).

### 5. Web-fetchtool (Firecrawl)

`web_fetch` kan **Firecrawl** aanroepen wanneer een API-sleutel aanwezig is:

- `FIRECRAWL_API_KEY` of `tools.web.fetch.firecrawl.apiKey`

Als Firecrawl niet is geconfigureerd, valt de tool terug op direct fetch + readability (geen betaalde API).

Zie [Web tools](/tools/web).

### 6. Provider-gebruikssnapshots (status/health)

Sommige statusopdrachten roepen **provider-gebruikseindpunten** aan om quotavensters of auth-status weer te geven.
Dit zijn doorgaans low-volume aanroepen, maar raken wel provider-API’s:

- `openclaw status --usage`
- `openclaw models status --json`

Zie [Models CLI](/cli/models).

### 7. Samenvatten door compactiebeveiliging

De compactiebeveiliging kan sessiegeschiedenis samenvatten met het **huidige model**, wat
provider-API’s aanroept wanneer het wordt uitgevoerd.

Zie [Sessiebeheer + compactie](/reference/session-management-compaction).

### 8. Modelscan / probe

`openclaw models scan` kan OpenRouter-modellen sonderen en gebruikt `OPENROUTER_API_KEY` wanneer
sonderen is ingeschakeld.

Zie [Models CLI](/cli/models).

### 9. Talk (spraak)

Talk-modus kan **ElevenLabs** aanroepen wanneer geconfigureerd:

- `ELEVENLABS_API_KEY` of `talk.apiKey`

Zie [Talk mode](/nodes/talk).

### 10. Skills (API’s van derden)

Skills kunnen `apiKey` opslaan in `skills.entries.<name>.apiKey`. Als een skill die sleutel gebruikt voor externe
API’s, kan dit kosten veroorzaken volgens de provider van de skill.

Zie [Skills](/tools/skills).
