---
summary: "Brug MiniMax M2.1 i OpenClaw"
read_when:
  - Du vil have MiniMax-modeller i OpenClaw
  - Du har brug for vejledning til opsætning af MiniMax
title: "MiniMax"
---

# MiniMax

MiniMax er en AI virksomhed, der bygger **M2/M2.1** modelfamilien. Den nuværende
kodningfokuserede udgivelse er **MiniMax M2.1** (23. december 2025), bygget til
virkelige verden komplekse opgaver.

Kilde: [MiniMax M2.1 release note](https://www.minimax.io/news/minimax-m21)

## Modeloverblik (M2.1)

MiniMax fremhæver disse forbedringer i M2.1:

- Stærkere **flersproget kodning** (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Bedre **web/app-udvikling** og æstetisk outputkvalitet (inklusive native mobil).
- Forbedret håndtering af **sammensatte instruktioner** til kontoragtige arbejdsgange, bygget på
  sammenflettet tænkning og integreret udførelse af begrænsninger.
- **Mere concise svar** med lavere tokenforbrug og hurtigere iterationssløjfer.
- Stærkere kompatibilitet med **værktøjs-/agent-rammer** og kontekststyring (Claude Code,
  Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Output af højere kvalitet inden for **dialog og teknisk skrivning**.

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **Hastighed:** Lightning er den “hurtige” variant i MiniMax’ prisdokumentation.
- **Omkostning:** Priserne viser samme input-omkostning, men Lightning har højere output-omkostning.
- **Kodningsplan routing:** The Lightning back-end er ikke direkte tilgængelig på MiniMax
  kodningsplanen. MiniMax auto-ruter de fleste anmodninger til Lightning, men falder tilbage til
  almindelige M2.1 back-end under trafik pigge.

## Vælg en opsætning

### MiniMax OAuth (Coding Plan) — anbefalet

**Bedst til:** hurtig opsætning med MiniMax Coding Plan via OAuth, ingen API-nøgle påkrævet.

Aktivér det medfølgende OAuth-plugin og autentificér:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

Du bliver bedt om at vælge et endpoint:

- **Global** – Internationale brugere (`api.minimax.io`)
- **CN** – Brugere i Kina (`api.minimaxi.com`)

Se [MiniMax OAuth plugin README](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) for detaljer.

### MiniMax M2.1 (API-nøgle)

**Bedst til:** hostet MiniMax med Anthropic-kompatibelt API.

Konfigurér via CLI:

- Kør `openclaw configure`
- Vælg **Model/auth**
- Vælg **MiniMax M2.1**

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

### MiniMax M2.1 som fallback (Opus primær)

**Bedst til:** behold Opus 4.6 som primær, fail over til MiniMax M2.1.

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

### Valgfrit: Lokal via LM Studio (manuel)

**Bedst til:** lokal inferens med LM Studio.
Vi har set stærke resultater med MiniMax M2.1 på kraftfuld hardware (f.eks. en
desktop/server) ved hjælp af LM Studios lokale server.

Konfigurér manuelt via `openclaw.json`:

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

## Konfigurér via `openclaw configure`

Brug den interaktive konfigurationsguide til at sætte MiniMax op uden at redigere JSON:

1. Kør `openclaw configure`.
2. Vælg **Model/auth**.
3. Vælg **MiniMax M2.1**.
4. Vælg din standardmodel, når du bliver bedt om det.

## Konfigurationsmuligheder

- `models.providers.minimax.baseUrl`: foretræk `https://api.minimax.io/anthropic` (Anthropic-kompatibel); `https://api.minimax.io/v1` er valgfri for OpenAI-kompatible payloads.
- `models.providers.minimax.api`: foretræk `anthropic-messages`; `openai-completions` er valgfri for OpenAI-kompatible payloads.
- `models.providers.minimax.apiKey`: MiniMax API-nøgle (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: definér `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: aliasér modeller, du vil have i tilladelseslisten.
- `models.mode`: behold `merge`, hvis du vil tilføje MiniMax sammen med indbyggede.

## Noter

- Modelreferencer er `minimax/<model>`.
- Coding Plan usage API: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (kræver en coding plan-nøgle).
- Opdatér prisværdier i `models.json`, hvis du har brug for præcis omkostningssporing.
- Henvisningslink til MiniMax Coding Plan (10% rabat): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- Se [/concepts/model-providers](/concepts/model-providers) for udbyderregler.
- Brug `openclaw models list` og `openclaw models set minimax/MiniMax-M2.1` til at skifte.

## Fejlfinding

### “Unknown model: minimax/MiniMax-M2.1”

Dette betyder normalt, at **MiniMax udbyder ikke er konfigureret** (ingen udbyder post
og ingen MiniMax auth profil/env nøgle fundet). En rettelse til denne detektion er i
**2026.1.12** (ikke frigivet på skrivetidspunktet). Ret af:

- Opgradere til **2026.1.12** (eller kør fra kilde `main`), og genstart derefter gateway.
- Køre `openclaw configure` og vælge **MiniMax M2.1**, eller
- Tilføje `models.providers.minimax`-blokken manuelt, eller
- Sætte `MINIMAX_API_KEY` (eller en MiniMax auth-profil), så udbyderen kan injiceres.

Sørg for, at model-id’et er **casesensitivt**:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

Tjek derefter igen med:

```bash
openclaw models list
```
