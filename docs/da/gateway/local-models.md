---
summary: "Kør OpenClaw på lokale LLM’er (LM Studio, vLLM, LiteLLM, brugerdefinerede OpenAI-endpoints)"
read_when:
  - Du vil servere modeller fra din egen GPU-boks
  - Du kobler LM Studio eller en OpenAI-kompatibel proxy
  - Du har brug for den sikreste vejledning til lokale modeller
title: "Lokale modeller"
---

# Lokale modeller

Lokal er doable, men OpenClaw forventer stor kontekst + stærke forsvar mod hurtig injektion. Små kort afkortet kontekst og lækage sikkerhed. Mål høj: **≥2 maxed-out Mac Studios eller tilsvarende GPU rig (~$30k+)**. En enkelt **24 GB** GPU virker kun for lettere prompter med højere latenstid. Brug den \*\*største / fuld størrelse model variant, du kan køre \*\*; aggressivt kvantiseret eller “små” checkpoints hæve prompt-injektion risiko (se [Security](/gateway/security)).

## Anbefalet: LM Studio + MiniMax M2.1 (Responses API, fuld-størrelse)

Bedste nuværende lokale stak. Indlæs MiniMax M2.1 i LM Studio, aktivér den lokale server (standard `http://127.0.0.1:1234`), og brug Svar API til at holde ræsonnementet adskilt fra den endelige tekst.

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

**Opsætningscheckliste**

- Installér LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- I LM Studio: download den **største tilgængelige MiniMax M2.1-build** (undgå “small”/kraftigt kvantiserede varianter), start serveren, og bekræft, at `http://127.0.0.1:1234/v1/models` viser den.
- Hold modellen indlæst; kold indlæsning giver opstartslatenstid.
- Justér `contextWindow`/`maxTokens`, hvis din LM Studio-build afviger.
- Til WhatsApp: hold dig til Responses API, så kun den endelige tekst sendes.

Behold hosted-modeller konfigureret, selv når du kører lokalt; brug `models.mode: "merge"`, så fallback-muligheder forbliver tilgængelige.

### Hybrid-konfiguration: hosted primær, lokal fallback

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

### Lokal først med hosted sikkerhedsnet

Byt rundt på primær- og fallback-rækkefølgen; behold den samme providers-blok og `models.mode: "merge"`, så du kan falde tilbage til Sonnet eller Opus, når den lokale boks er nede.

### Regional hosting / datarouting

- Hosted MiniMax/Kimi/GLM varianter findes også på OpenRouter med regionsfastgjorte endepunkter (f.eks. US-hosted). Vælg den regionale variant der for at holde trafikken i din valgte jurisdiktion, mens du stadig bruger `models.mode: "merge"` for Anthropic/OpenAI fallbacks.
- Lokal-only er fortsat den stærkeste privatlivsvej; hosted regional routing er mellemvejen, når du har brug for udbyderfunktioner, men vil have kontrol over dataflowet.

## Andre OpenAI-kompatible lokale proxier

vLLM, LiteLLM, OAI-proxy eller brugerdefinerede gateways virker, hvis de udsætter et OpenAI-style `/v1` endepunkt. Erstat udbyderblokken ovenfor med dit endepunkt og model-ID:

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

Behold `models.mode: "merge"`, så hosted-modeller forbliver tilgængelige som fallbacks.

## Fejlfinding

- Gateway kan nå proxy? `curl http://127.0.0.1:1234/v1/models`.
- LM Studio model ulæst? Genindlæsning; kold start er en almindelig ”hængende årsag”.
- Fejl i kontekst? Lavere `contextWindow` eller hæve din servergrænse.
- Sikkerhed: lokale modeller springer udbyderfiltre over; hold agenter snævre og kompaktering slået til for at begrænse blast radius for prompt injection.
