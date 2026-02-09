---
summary: "Gebruik MiniMax M2.1 in OpenClaw"
read_when:
  - Je wilt MiniMax-modellen in OpenClaw gebruiken
  - Je hebt begeleiding nodig bij het instellen van MiniMax
title: "MiniMax"
---

# MiniMax

MiniMax is een AI-bedrijf dat de **M2/M2.1**-modelfamilie ontwikkelt. De huidige
op coderen gerichte release is **MiniMax M2.1** (23 december 2025), gebouwd voor
complexe taken uit de praktijk.

Bron: [MiniMax M2.1 release note](https://www.minimax.io/news/minimax-m21)

## Modeloverzicht (M2.1)

MiniMax benadrukt de volgende verbeteringen in M2.1:

- Sterkere **meertalige codeerprestaties** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Betere **web/app-ontwikkeling** en esthetische uitvoerkwaliteit (inclusief native mobile).
- Verbeterde verwerking van **samengestelde instructies** voor kantoorachtige workflows, voortbouwend op
  verweven denkprocessen en geïntegreerde uitvoering van beperkingen.
- **Compactere antwoorden** met lager tokengebruik en snellere iteratielussen.
- Sterkere **tool/agent-framework**-compatibiliteit en contextbeheer (Claude Code,
  Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Hoogwaardigere **dialoog- en technisch-schrijvende** uitvoer.

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **Snelheid:** Lightning is de “snelle” variant in de prijsdocumentatie van MiniMax.
- **Kosten:** De prijzen tonen dezelfde invoerkosten, maar Lightning heeft hogere uitvoerkosten.
- **Routing voor codeerabonnementen:** De Lightning back-end is niet rechtstreeks beschikbaar op het MiniMax
  coding plan. MiniMax routeert de meeste verzoeken automatisch naar Lightning, maar schakelt terug naar de
  reguliere M2.1 back-end tijdens piekbelasting.

## Kies een installatie

### MiniMax OAuth (Coding Plan) — aanbevolen

**Beste voor:** snelle installatie met MiniMax Coding Plan via OAuth, geen API-sleutel vereist.

Schakel de gebundelde OAuth-plugin in en authenticeer:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

Je wordt gevraagd een endpoint te selecteren:

- **Global** - Internationale gebruikers (`api.minimax.io`)
- **CN** - Gebruikers in China (`api.minimaxi.com`)

Zie de [MiniMax OAuth plugin README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) voor details.

### MiniMax M2.1 (API-sleutel)

**Beste voor:** gehoste MiniMax met een Anthropic-compatibele API.

Configureren via CLI:

- Voer `openclaw configure` uit
- Selecteer **Model/auth**
- Kies **MiniMax M2.1**

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

### MiniMax M2.1 als fallback (Opus primair)

**Beste voor:** Opus 4.6 als primair behouden en overschakelen naar MiniMax M2.1 bij uitval.

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

### Optioneel: Lokaal via LM Studio (handmatig)

**Beste voor:** lokale inferentie met LM Studio.
We hebben sterke resultaten gezien met MiniMax M2.1 op krachtige hardware (bijv. een
desktop/server) met de lokale server van LM Studio.

Configureer handmatig via `openclaw.json`:

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

## Configureren via `openclaw configure`

Gebruik de interactieve configuratiewizard om MiniMax in te stellen zonder JSON te bewerken:

1. Voer `openclaw configure` uit.
2. Selecteer **Model/auth**.
3. Kies **MiniMax M2.1**.
4. Kies je standaardmodel wanneer daarom wordt gevraagd.

## Configuratieopties

- `models.providers.minimax.baseUrl`: geef de voorkeur aan `https://api.minimax.io/anthropic` (Anthropic-compatibel); `https://api.minimax.io/v1` is optioneel voor OpenAI-compatibele payloads.
- `models.providers.minimax.api`: geef de voorkeur aan `anthropic-messages`; `openai-completions` is optioneel voor OpenAI-compatibele payloads.
- `models.providers.minimax.apiKey`: MiniMax API-sleutel (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: definieer `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: alias modellen die je in de toegestane lijst wilt opnemen.
- `models.mode`: behoud `merge` als je MiniMax naast ingebouwde modellen wilt toevoegen.

## Notities

- Modelreferenties zijn `minimax/<model>`.
- Coding Plan usage API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (vereist een coding plan-sleutel).
- Werk prijswaarden bij in `models.json` als je exacte kostenregistratie nodig hebt.
- Verwijslink voor MiniMax Coding Plan (10% korting): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- Zie [/concepts/model-providers](/concepts/model-providers) voor providerregels.
- Gebruik `openclaw models list` en `openclaw models set minimax/MiniMax-M2.1` om te wisselen.

## Problemen oplossen

### “Unknown model: minimax/MiniMax-M2.1”

Dit betekent meestal dat de **MiniMax-provider niet is geconfigureerd** (geen providervermelding
en geen MiniMax-authprofiel/omgevingssleutel gevonden). Een oplossing voor deze detectie zit in
**2026.1.12** (nog niet uitgebracht op het moment van schrijven). Oplossen door:

- Upgraden naar **2026.1.12** (of uitvoeren vanaf de bron `main`), en daarna de gateway herstarten.
- `openclaw configure` uitvoeren en **MiniMax M2.1** selecteren, of
- Het `models.providers.minimax`-blok handmatig toevoegen, of
- `MINIMAX_API_KEY` instellen (of een MiniMax-authprofiel) zodat de provider kan worden geïnjecteerd.

Zorg ervoor dat de model-id **hoofdlettergevoelig** is:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

Controleer daarna opnieuw met:

```bash
openclaw models list
```
