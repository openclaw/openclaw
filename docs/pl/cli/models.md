---
summary: "Referencja CLI dla `openclaw models` (status/list/set/scan, aliasy, mechanizmy zapasowe, uwierzytelnianie)"
read_when:
  - Chcesz zmienić domyślne modele lub wyświetlić stan uwierzytelniania dostawców
  - Chcesz przeskanować dostępne modele/dostawców i debugować profile uwierzytelniania
title: "modele"
---

# `openclaw models`

Wykrywanie modeli, skanowanie i konfiguracja (model domyślny, mechanizmy zapasowe, profile uwierzytelniania).

Powiązane:

- Dostawcy + modele: [Models](/providers/models)
- Konfiguracja uwierzytelniania dostawcy: [Getting started](/start/getting-started)

## Typowe polecenia

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` pokazuje rozstrzygnięty domyślny model/mechanizmy zapasowe oraz przegląd uwierzytelniania.
Gdy dostępne są migawki użycia dostawców, sekcja stanu OAuth/tokenów zawiera
nagłówki użycia dostawców.
Dodaj `--probe`, aby uruchomić aktywne sondy uwierzytelniania względem każdego skonfigurowanego profilu dostawcy.
Sondy to rzeczywiste żądania (mogą zużywać tokeny i wyzwalać limity szybkości).
Użyj `--agent <id>`, aby sprawdzić stan modelu/uwierzytelniania skonfigurowanego agenta. Gdy pominięte,
polecenie używa `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`, jeśli ustawione; w przeciwnym razie
skonfigurowanego domyślnego agenta.

Uwagi:

- `models set <model-or-alias>` akceptuje `provider/model` lub alias.
- Odwołania do modeli są parsowane przez podział po **pierwszym** `/`. Jeśli identyfikator modelu zawiera `/` (styl OpenRouter), dołącz prefiks dostawcy (przykład: `openrouter/moonshotai/kimi-k2`).
- Jeśli pominiesz dostawcę, OpenClaw traktuje dane wejściowe jako alias lub model dla **domyślnego dostawcy** (działa tylko wtedy, gdy w identyfikatorze modelu nie ma `/`).

### `models status`

Opcje:

- `--json`
- `--plain`
- `--check` (wyjście 1=przeterminowane/brakujące, 2=wygasające)
- `--probe` (aktywna sonda skonfigurowanych profili uwierzytelniania)
- `--probe-provider <name>` (sonduj jednego dostawcę)
- `--probe-profile <id>` (powtórzenia lub rozdzielone przecinkami identyfikatory profili)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (identyfikator skonfigurowanego agenta; nadpisuje `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## Aliasy + mechanizmy zapasowe

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Profile uwierzytelniania

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` uruchamia przepływ uwierzytelniania wtyczki dostawcy (OAuth/klucz API). Użyj
`openclaw plugins list`, aby sprawdzić, którzy dostawcy są zainstalowani.

Uwagi:

- `setup-token` prosi o wartość setup-token (wygeneruj ją za pomocą `claude setup-token` na dowolnej maszynie).
- `paste-token` akceptuje ciąg tokenu wygenerowany gdzie indziej lub z automatyzacji.
