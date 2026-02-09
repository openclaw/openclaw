---
summary: "Kör OpenClaw på lokala LLM:er (LM Studio, vLLM, LiteLLM, anpassade OpenAI-endpoints)"
read_when:
  - Du vill servera modeller från din egen GPU‑maskin
  - Du kopplar LM Studio eller en OpenAI‑kompatibel proxy
  - Du behöver den säkraste vägledningen för lokala modeller
title: "Lokala modeller"
---

# Lokala modeller

Lokal är genomförbar, men OpenClaw förväntar sig stort sammanhang + starka försvar mot snabb injektion. Små kort trunkerar sammanhang och läcker säkerhet. Sikta hög: **<unk> 2 maxed-out Mac Studios eller motsvarande GPU rigg (~$30k+)**. En enda **24 GB** GPU fungerar endast för lättare uppmaningar med högre latens. Använd **den största / fullstora modellvarianten du kan köra**; aggressivt kvantifierade eller "små" kontrollpunkter öka risken för snabb injektion (se [Security](/gateway/security)).

## Rekommenderat: LM Studio + MiniMax M2.1 (Responses API, fullstor)

Bästa nuvarande lokal stack. Ladda MiniMax M2.1 i LM Studio, aktivera den lokala servern (standard `http://127.0.1:1234`), och använd Responses API för att hålla resonemanget separat från slutlig text.

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

**Konfigureringschecklista**

- Installera LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- I LM Studio, ladda ner den **största tillgängliga MiniMax M2.1‑builden** (undvik ”small”/kraftigt kvantiserade varianter), starta servern och bekräfta att `http://127.0.0.1:1234/v1/models` listar den.
- Håll modellen laddad; kallstart lägger till startlatens.
- Justera `contextWindow`/`maxTokens` om din LM Studio‑build skiljer sig.
- För WhatsApp, håll dig till Responses API så att endast sluttext skickas.

Behåll hostade modeller konfigurerade även när du kör lokalt; använd `models.mode: "merge"` så att fallback‑alternativ finns kvar.

### Hybridkonfig: hostad primär, lokal fallback

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

### Lokalt först med hostat säkerhetsnät

Byt ordning på primär och fallback; behåll samma providers‑block och `models.mode: "merge"` så att du kan falla tillbaka till Sonnet eller Opus när den lokala maskinen är nere.

### Regional hosting / datarouting

- Hosted MiniMax/Kimi/GLM varianter finns också på OpenRouter med regionfästa ändpunkter (t.ex., US-hosted). Välj den regionala varianten där för att hålla trafiken i din valda jurisdiktion medan du fortfarande använder `models.mode: "merge"` för Anthropic/OpenAI fallbacks.
- Endast lokalt är den starkaste integritetsvägen; regional hostning är en mellanväg när du behöver leverantörsfunktioner men vill ha kontroll över dataflödet.

## Andra OpenAI‑kompatibla lokala proxylösningar

vLLM, LiteLLM, OAI-proxy, eller anpassade gateways fungerar om de exponerar en OpenAI-stil `/v1`-slutpunkt. Ersätt leverantörsblocket ovan med ditt slutpunkt och modell-ID:

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

Behåll `models.mode: "merge"` så att hostade modeller finns kvar som fallback.

## Felsökning

- Gateway kan nå proxy? `curl http://127.0.0.1:1234/v1/models`.
- LM Studio-modell olastad? Ladda om; kallstart är en vanlig “hängande” orsak.
- Kontextfel? Lägre `contextWindow` eller höja din servergräns.
- Säkerhet: lokala modeller hoppar över leverantörsfilter; håll agenter smala och komprimering påslagen för att begränsa sprängradien för prompt‑injektion.
