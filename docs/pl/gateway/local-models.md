---
summary: "Uruchamianie OpenClaw na lokalnych LLM-ach (LM Studio, vLLM, LiteLLM, niestandardowe endpointy OpenAI)"
read_when:
  - Chcesz serwować modele z własnej maszyny GPU
  - Integrujesz LM Studio lub proxy zgodne z OpenAI
  - Potrzebujesz najbezpieczniejszych wytycznych dla modeli lokalnych
title: "Modele lokalne"
---

# Modele lokalne

Lokalnie da się to zrobić, ale OpenClaw oczekuje dużego kontekstu oraz silnych zabezpieczeń przed prompt injection. Małe karty obcinają kontekst i powodują wycieki bezpieczeństwa. Celuj wysoko: \*\*≥2 w pełni wyposażone Mac Studio lub równoważny zestaw GPU (~30 tys. Pojedynczy GPU **24 GB** działa tylko dla lżejszych promptów i z wyższymi opóźnieniami. Używaj **największego / pełnowymiarowego wariantu modelu, jaki możesz uruchomić**; agresywnie kwantyzowane lub „małe” checkpointy zwiększają ryzyko prompt injection (zob. [Security](/gateway/security)).

## Zalecane: LM Studio + MiniMax M2.1 (Responses API, pełny rozmiar)

Najlepszy obecnie lokalny stos. Załaduj MiniMax M2.1 w LM Studio, włącz lokalny serwer (domyślnie `http://127.0.0.1:1234`) i użyj Responses API, aby oddzielić rozumowanie od tekstu końcowego.

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

**Lista kontrolna konfiguracji**

- Zainstaluj LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- W LM Studio pobierz **największą dostępną wersję MiniMax M2.1** (unikaj wariantów „small”/mocno kwantyzowanych), uruchom serwer i potwierdź, że `http://127.0.0.1:1234/v1/models` go wyświetla.
- Trzymaj model załadowany; zimne ładowanie zwiększa opóźnienie startu.
- Dostosuj `contextWindow`/`maxTokens`, jeśli Twoja wersja LM Studio się różni.
- Dla WhatsApp trzymaj się Responses API, aby wysyłany był wyłącznie tekst końcowy.

Utrzymuj konfigurację modeli hostowanych nawet podczas pracy lokalnej; użyj `models.mode: "merge"`, aby mechanizmy zapasowe pozostały dostępne.

### Konfiguracja hybrydowa: hostowany jako główny, lokalny jako zapasowy

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

### Najpierw lokalnie z siatką bezpieczeństwa hostowaną

Zamień kolejność głównego i zapasowego; zachowaj ten sam blok dostawców oraz `models.mode: "merge"`, aby móc przełączyć się na Sonnet lub Opus, gdy lokalna maszyna jest niedostępna.

### Hosting regionalny / routowanie danych

- Hostowane warianty MiniMax/Kimi/GLM są także dostępne w OpenRouter z endpointami przypiętymi do regionu (np. hostowane w USA). Wybierz tam wariant regionalny, aby utrzymać ruch w wybranej jurysdykcji, jednocześnie używając `models.mode: "merge"` jako zapasów Anthropic/OpenAI.
- Tryb wyłącznie lokalny pozostaje najsilniejszą ścieżką prywatności; hostowane routowanie regionalne to rozwiązanie pośrednie, gdy potrzebujesz funkcji dostawcy, ale chcesz mieć kontrolę nad przepływem danych.

## Inne lokalne proxy zgodne z OpenAI

vLLM, LiteLLM, OAI-proxy lub niestandardowe gatewaye działają, jeśli wystawiają endpoint w stylu OpenAI `/v1`. Zastąp powyższy blok dostawcy swoim endpointem i identyfikatorem modelu:

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

Zachowaj `models.mode: "merge"`, aby modele hostowane pozostały dostępne jako zapasowe.

## Rozwiązywanie problemów

- Gateway ma dostęp do proxy? `curl http://127.0.0.1:1234/v1/models`.
- Model LM Studio rozładowany? Załaduj ponownie; zimny start to częsta przyczyna „zawieszania”.
- Błędy kontekstu? Obniż `contextWindow` lub zwiększ limit po stronie serwera.
- Bezpieczeństwo: modele lokalne pomijają filtry po stronie dostawcy; utrzymuj wąski zakres agentów i włączoną kompakcję, aby ograniczyć promień rażenia prompt injection.
