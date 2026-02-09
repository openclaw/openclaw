---
summary: "Draai OpenClaw op lokale LLM’s (LM Studio, vLLM, LiteLLM, aangepaste OpenAI-endpoints)"
read_when:
  - Je wilt modellen serveren vanaf je eigen GPU-box
  - Je LM Studio of een OpenAI-compatibele proxy aansluit
  - Je de veiligste richtlijnen voor lokale modellen nodig hebt
title: "Lokale modellen"
---

# Lokale modellen

Lokaal is mogelijk, maar OpenClaw verwacht een grote context + sterke verdediging tegen prompt-injectie. Kleine kaarten kappen de context af en laten veiligheidslekken ontstaan. Streef hoog: **≥2 volledig uitgeruste Mac Studios of een gelijkwaardige GPU-rig (~$30k+)**. Een enkele **24 GB** GPU werkt alleen voor lichtere prompts met hogere latentie. Gebruik de **grootste / full-size modelvariant die je kunt draaien**; sterk gequantiseerde of “kleine” checkpoints verhogen het risico op prompt-injectie (zie [Security](/gateway/security)).

## Aanbevolen: LM Studio + MiniMax M2.1 (Responses API, full-size)

Beste huidige lokale stack. Laad MiniMax M2.1 in LM Studio, schakel de lokale server in (standaard `http://127.0.0.1:1234`), en gebruik de Responses API om redenering gescheiden te houden van de uiteindelijke tekst.

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
      },
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

**Installatiechecklist**

- Installeer LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- Download in LM Studio de **grootste beschikbare MiniMax M2.1-build** (vermijd “small”/sterk gequantiseerde varianten), start de server en bevestig dat `http://127.0.0.1:1234/v1/models` deze vermeldt.
- Houd het model geladen; cold-load voegt opstartlatentie toe.
- Pas `contextWindow`/`maxTokens` aan als je LM Studio-build afwijkt.
- Voor WhatsApp: houd vast aan de Responses API zodat alleen de definitieve tekst wordt verzonden.

Houd gehoste modellen geconfigureerd, ook wanneer je lokaal draait; gebruik `models.mode: "merge"` zodat terugvalopties beschikbaar blijven.

### Hybride config: gehoste primaire, lokale fallback

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
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

### Lokaal-eerst met gehoste veiligheidsnet

Wissel de volgorde van primaire en fallback; behoud hetzelfde providerblok en `models.mode: "merge"` zodat je kunt terugvallen op Sonnet of Opus wanneer de lokale box uitvalt.

### Regionale hosting / datarouting

- Gehoste MiniMax/Kimi/GLM-varianten bestaan ook op OpenRouter met regio-gebonden endpoints (bijv. in de VS gehost). Kies daar de regionale variant om verkeer binnen je gekozen jurisdictie te houden, terwijl je `models.mode: "merge"` blijft gebruiken voor Anthropic/OpenAI-fallbacks.
- Alleen lokaal blijft het sterkste privacy-pad; gehoste regionale routing is de middenweg wanneer je providerfeatures nodig hebt maar controle over datastromen wilt.

## Andere OpenAI-compatibele lokale proxies

vLLM, LiteLLM, OAI-proxy of aangepaste gateways werken als ze een OpenAI-achtige `/v1`-endpoint blootstellen. Vervang het providerblok hierboven door je endpoint en model-ID:

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Houd `models.mode: "merge"` zodat gehoste modellen beschikbaar blijven als fallbacks.

## Problemen oplossen

- Kan de Gateway de proxy bereiken? `curl http://127.0.0.1:1234/v1/models`.
- LM Studio-model ontladen? Opnieuw laden; cold start is een veelvoorkomende oorzaak van “hangen”.
- Contextfouten? Verlaag `contextWindow` of verhoog je serverlimiet.
- Veiligheid: lokale modellen slaan provider-side filters over; houd agents smal en compaction ingeschakeld om de impact van prompt-injectie te beperken.
