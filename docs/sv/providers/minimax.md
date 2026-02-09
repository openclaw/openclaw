---
summary: "Använd MiniMax M2.1 i OpenClaw"
read_when:
  - Du vill använda MiniMax-modeller i OpenClaw
  - Du behöver vägledning för MiniMax-konfigurering
title: "MiniMax"
---

# MiniMax

MiniMax är ett AI-företag som bygger modellfamiljen **M2/M2.1** Den nuvarande
kodningsfokuserade utgåvan är **MiniMax M2.1** (23 december 2025), byggd för
verkliga komplexa uppgifter.

Källa: [MiniMax M2.1 release note](https://www.minimax.io/news/minimax-m21)

## Modellöversikt (M2.1)

MiniMax lyfter fram följande förbättringar i M2.1:

- Starkare **flerspråkig kodning** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Bättre **webb-/apputveckling** och estetisk kvalitet i utdata (inklusive native mobile).
- Förbättrad hantering av **sammansatta instruktioner** för kontorsliknande arbetsflöden, byggt vidare på
  interleaverat tänkande och integrerad exekvering av begränsningar.
- **Mer koncisa svar** med lägre tokenanvändning och snabbare iterationsloopar.
- Starkare kompatibilitet med **verktygs-/agentramverk** och kontexthantering (Claude Code,
  Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Högre kvalitet i **dialog och tekniskt skrivande**.

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **Hastighet:** Lightning är den ”snabba” varianten i MiniMax prisdokumentation.
- **Kostnad:** Prissättningen visar samma kostnad för indata, men Lightning har högre kostnad för utdata.
- **Kodningsplan routing:** Blixtnedslag back-end är inte direkt tillgänglig på MiniMax
  kodningsplan. MiniMax auto-rutter de flesta förfrågningar till Lightning, men faller tillbaka till
  vanliga M2.1 back-end under trafikspikar.

## Välj en konfigurering

### MiniMax OAuth (Coding Plan) — rekommenderas

**Bäst för:** snabb konfigurering med MiniMax Coding Plan via OAuth, ingen API-nyckel krävs.

Aktivera det medföljande OAuth-pluginet och autentisera:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

Du kommer att bli ombedd att välja en endpoint:

- **Global** – Internationella användare (`api.minimax.io`)
- **CN** – Användare i Kina (`api.minimaxi.com`)

Se [MiniMax OAuth plugin README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) för detaljer.

### MiniMax M2.1 (API-nyckel)

**Bäst för:** hostad MiniMax med Anthropic-kompatibelt API.

Konfigurera via CLI:

- Kör `openclaw configure`
- Välj **Model/auth**
- Välj **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 som fallback (Opus primär)

**Bäst för:** behåll Opus 4.6 som primär och fallera över till MiniMax M2.1.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### Valfritt: Lokalt via LM Studio (manuellt)

**Bäst för:** lokal slutledning med LM Studio.
Vi har sett starka resultat med MiniMax M2.1 på kraftfull hårdvara (t.ex. en
desktop/server) med LM Studios lokala server.

Konfigurera manuellt via `openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Konfigurera via `openclaw configure`

Använd den interaktiva konfigurationsguiden för att ställa in MiniMax utan att redigera JSON:

1. Kör `openclaw configure`.
2. Välj **Model/auth**.
3. Välj **MiniMax M2.1**.
4. Välj din standardmodell när du uppmanas.

## Konfigurationsalternativ

- `models.providers.minimax.baseUrl`: föredra `https://api.minimax.io/anthropic` (Anthropic-kompatibel); `https://api.minimax.io/v1` är valfritt för OpenAI-kompatibla payloads.
- `models.providers.minimax.api`: föredra `anthropic-messages`; `openai-completions` är valfritt för OpenAI-kompatibla payloads.
- `models.providers.minimax.apiKey`: MiniMax API-nyckel (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: definiera `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: aliasera modeller du vill ha i tillåtelselistan.
- `models.mode`: behåll `merge` om du vill lägga till MiniMax sida vid sida med inbyggda.

## Noteringar

- Modellreferenser är `minimax/<model>`.
- API för användning av Coding Plan: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (kräver en kodningsplansnyckel).
- Uppdatera prisvärden i `models.json` om du behöver exakt kostnadsspårning.
- Värvningslänk för MiniMax Coding Plan (10 % rabatt): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- Se [/concepts/model-providers](/concepts/model-providers) för regler för leverantörer.
- Använd `openclaw models list` och `openclaw models set minimax/MiniMax-M2.1` för att växla.

## Felsökning

### ”Unknown model: minimax/MiniMax-M2.1”

Detta innebär vanligtvis att **MiniMax leverantör inte är konfigurerad** (ingen leverantörspost
och ingen MiniMax auth profil / env nyckel hittades). En rättelse för denna detektion finns i
**2026.1.12** (outgiven vid skrivande tid). Fixa efter:

- Uppgradera till **2026.1.12** (eller kör från källkod `main`), och starta sedan om gatewayen.
- Köra `openclaw configure` och välja **MiniMax M2.1**, eller
- Lägga till `models.providers.minimax`-blocket manuellt, eller
- Ställa in `MINIMAX_API_KEY` (eller en MiniMax-autentiseringsprofil) så att leverantören kan injiceras.

Se till att modell-id är **skiftlägeskänsligt**:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

Kontrollera sedan igen med:

```bash
openclaw models list
```
