---
summary: "Granska vad som kan kosta pengar, vilka nycklar som används och hur du visar användning"
read_when:
  - Du vill förstå vilka funktioner som kan anropa betalda API:er
  - Du behöver granska nycklar, kostnader och synlighet för användning
  - Du förklarar rapportering för /status eller /usage
title: "API-användning och kostnader"
---

# API-användning och kostnader

Den här doc listar **funktioner som kan åberopa API-nycklar** och var deras kostnader dyker upp. Den fokuserar på
OpenClaw funktioner som kan generera leverantörsanvändning eller betalda API-samtal.

## Var kostnader visas (chatt + CLI)

**Kostnadsöversikt per session**

- `/status` visar aktuell sessionsmodell, kontextanvändning och tokens för senaste svaret.
- Om modellen använder **API-nyckelautentisering** visar `/status` även **uppskattad kostnad** för det senaste svaret.

**Kostnadsfot per meddelande**

- `/usage full` lägger till en användningsfot till varje svar, inklusive **uppskattad kostnad** (endast API-nyckel).
- `/usage tokens` visar endast tokens; OAuth-flöden döljer kostnad i valuta.

**CLI-användningsfönster (leverantörskvoter)**

- `openclaw status --usage` och `openclaw channels list` visar leverantörens **användningsfönster**
  (kvotögonblicksbilder, inte kostnader per meddelande).

Se [Tokenanvändning och kostnader](/reference/token-use) för detaljer och exempel.

## Hur nycklar upptäcks

OpenClaw kan hämta autentiseringsuppgifter från:

- **Autentiseringsprofiler** (per agent, lagras i `auth-profiles.json`).
- **Miljövariabler** (t.ex. `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Konfig** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Skickligheter** (`skills.entries.<name>.apiKey`) som kan exportera nycklar till färdighetsprocessen env.

## Funktioner som kan använda nycklar

### 1. Kärnmodellens svar (chatt + verktyg)

Varje svars- eller verktygssamtal använder **nuvarande modellleverantör** (OpenAI, Anthropic, etc). Detta är
primära källa till användning och kostnad.

Se [Modeller](/providers/models) för prisinställningar och [Tokenanvändning och kostnader](/reference/token-use) för visning.

### 2. Medieförståelse (ljud/bild/video)

Inkommande media kan sammanfattas/transkriberas innan svaret körs. Detta använder modell/leverantör API:er.

- Ljud: OpenAI / Groq / Deepgram (nu **autoaktiverat** när nycklar finns).
- Bild: OpenAI / Anthropic / Google.
- Video: Google.

Se [Medieförståelse](/nodes/media-understanding).

### 3. Minnesinbäddningar + semantisk sökning

Semantisk minnessökning använder **inbäddnings-API:er** när den är konfigurerad för fjärrleverantörer:

- `memorySearch.provider = "openai"` → OpenAI-inbäddningar
- `memorySearch.provider = "gemini"` → Gemini-inbäddningar
- `memorySearch.provider = "voyage"` → Voyage-inbäddningar
- Valfri reserv till en fjärrleverantör om lokala inbäddningar misslyckas

Du kan hålla det lokalt med `memorySearch.provider = "local"` (ingen API-användning).

Se [Minne](/concepts/memory).

### 4. Verktyg för webbsökning (Brave / Perplexity via OpenRouter)

`web_search` använder API-nycklar och kan medföra användningsavgifter:

- **Brave Search API**: `BRAVE_API_KEY` eller `tools.web.search.apiKey`
- **Perplexity** (via OpenRouter): `PERPLEXITY_API_KEY` eller `OPENROUTER_API_KEY`

**Braves gratisklass (generös):**

- **2 000 förfrågningar/månad**
- **1 förfrågan/sekund**
- **Kreditkort krävs** för verifiering (ingen debitering om du inte uppgraderar)

Se [Webbverktyg](/tools/web).

### 5. Verktyg för webbhämtning (Firecrawl)

`web_fetch` kan anropa **Firecrawl** när en API-nyckel finns:

- `FIRECRAWL_API_KEY` eller `tools.web.fetch.firecrawl.apiKey`

Om Firecrawl inte är konfigurerat faller verktyget tillbaka till direkt hämtning + läsbarhet (ingen betald API).

Se [Webbverktyg](/tools/web).

### 6. Ögonblicksbilder av leverantörsanvändning (status/hälsa)

Vissa statuskommandon anropa **leverantörs användnings slutpunkter** för att visa kvotfönster eller auth hälsa.
Dessa är typiskt låga volymer samtal men ändå slå leverantör API:

- `openclaw status --usage`
- `openclaw models status --json`

Se [Models CLI](/cli/models).

### 7. Sammanfattning för kompakteringsskydd

Kompakteringsskyddet kan sammanfatta sessionshistorik med **den aktuella modellen**, vilket
anropar leverantörs-API:er när det körs.

Se [Sessionshantering + kompaktering](/reference/session-management-compaction).

### 8. Modellskanning/probing

`openclaw models scan` kan sondera OpenRouter-modeller och använder `OPENROUTER_API_KEY` när
sondering är aktiverad.

Se [Models CLI](/cli/models).

### 9. Talk (tal)

Talk-läge kan anropa **ElevenLabs** när det är konfigurerat:

- `ELEVENLABS_API_KEY` eller `talk.apiKey`

Se [Talk-läge](/nodes/talk).

### 10. Skills (tredjeparts-API:er)

Färdigheter kan lagra `apiKey` i `skills.entries.<name>.apiKey`. Om en färdighet använder den nyckeln för externa
API:er, kan det medföra kostnader enligt kompetensleverantören.

Se [Skills](/tools/skills).
