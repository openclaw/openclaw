---
summary: „Skąd OpenClaw ładuje zmienne środowiskowe i jaka jest kolejność pierwszeństwa”
read_when:
  - Musisz wiedzieć, które zmienne środowiskowe są ładowane i w jakiej kolejności
  - Debugujesz brakujące klucze API w Gateway
  - Dokumentujesz uwierzytelnianie dostawców lub środowiska wdrożeniowe
title: „Zmienne środowiskowe”
x-i18n:
  source_path: help/environment.md
  source_hash: b49ae50e5d306612
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:12Z
---

# Zmienne środowiskowe

OpenClaw pobiera zmienne środowiskowe z wielu źródeł. Zasada brzmi: **nigdy nie nadpisuj istniejących wartości**.

## Kolejność pierwszeństwa (od najwyższej → do najniższej)

1. **Środowisko procesu** (to, co proces Gateway już otrzymał z nadrzędnej powłoki/daemona).
2. **`.env` w bieżącym katalogu roboczym** (domyślne dotenv; nie nadpisuje).
3. **Globalny `.env`** w `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`; nie nadpisuje).
4. **Blok Config `env`** w `~/.openclaw/openclaw.json` (stosowany tylko, jeśli brakuje wartości).
5. **Opcjonalny import powłoki logowania** (`env.shellEnv.enabled` lub `OPENCLAW_LOAD_SHELL_ENV=1`), stosowany wyłącznie dla brakujących oczekiwanych kluczy.

Jeśli plik konfiguracji jest całkowicie nieobecny, krok 4 jest pomijany; import powłoki nadal jest wykonywany, jeśli jest włączony.

## Blok Config `env`

Dwa równoważne sposoby ustawiania wbudowanych zmiennych środowiskowych (oba nie nadpisują):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## Import zmiennych środowiskowych z powłoki

`env.shellEnv` uruchamia Twoją powłokę logowania i importuje tylko **brakujące** oczekiwane klucze:

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Odpowiedniki zmiennych środowiskowych:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Podstawianie zmiennych środowiskowych w konfiguracji

Możesz odwoływać się bezpośrednio do zmiennych środowiskowych w wartościach typu string w konfiguracji, używając składni `${VAR_NAME}`:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

Zobacz [Konfiguracja: podstawianie zmiennych środowiskowych](/gateway/configuration#env-var-substitution-in-config), aby poznać pełne szczegóły.

## Powiązane

- [Konfiguracja Gateway](/gateway/configuration)
- [FAQ: zmienne środowiskowe i ładowanie .env](/help/faq#env-vars-and-env-loading)
- [Przegląd modeli](/concepts/models)
