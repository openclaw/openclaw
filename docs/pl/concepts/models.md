---
summary: "CLI modeli: lista, ustawianie, aliasy, fallbacki, skanowanie, status"
read_when:
  - Dodawanie lub modyfikowanie CLI modeli (models list/set/scan/aliases/fallbacks)
  - Zmiana zachowania fallbacków modeli lub UX wyboru
  - Aktualizacja sond skanowania modeli (narzędzia/obrazy)
title: "CLI modeli"
---

# CLI modeli

Zobacz [/concepts/model-failover](/concepts/model-failover) w sprawie rotacji profili uwierzytelniania,
cooldownów oraz tego, jak współdziała to z fallbackami.
Szybki przegląd dostawców + przykłady: [/concepts/model-providers](/concepts/model-providers).

## Jak działa wybór modelu

OpenClaw wybiera modele w następującej kolejności:

1. **Podstawowy** model (`agents.defaults.model.primary` lub `agents.defaults.model`).
2. **Fallbacki** w `agents.defaults.model.fallbacks` (w kolejności).
3. **Failover uwierzytelniania dostawcy** zachodzi wewnątrz dostawcy przed przejściem do
   następnego modelu.

Powiązane:

- `agents.defaults.models` to lista dozwolonych/katalog modeli, z których OpenClaw może korzystać (wraz z aliasami).
- `agents.defaults.imageModel` jest używany **wyłącznie wtedy**, gdy model podstawowy nie może przyjmować obrazów.
- Domyślne ustawienia per‑agent mogą nadpisywać `agents.defaults.model` przez `agents.list[].model` oraz powiązania (zob. [/concepts/multi-agent](/concepts/multi-agent)).

## Szybkie wybory modeli (anegdotycznie)

- **GLM**: nieco lepszy do kodowania/wywołań narzędzi.
- **MiniMax**: lepszy do pisania i „vibe’ów”.

## Kreator konfiguracji (zalecane)

Jeśli nie chcesz ręcznie edytować konfiguracji, uruchom kreator onboardingu:

```bash
openclaw onboard
```

Może on skonfigurować model + uwierzytelnianie dla popularnych dostawców, w tym **OpenAI Code (Codex)
subscription** (OAuth) oraz **Anthropic** (zalecany klucz API; obsługiwany jest także `claude
setup-token`).

## Klucze konfiguracji (przegląd)

- `agents.defaults.model.primary` i `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` i `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (lista dozwolonych + aliasy + parametry dostawców)
- `models.providers` (niestandardowi dostawcy zapisywani do `models.json`)

Odwołania do modeli są normalizowane do małych liter. Aliasy dostawców, takie jak `z.ai/*`,
normalizują się do `zai/*`.

Przykłady konfiguracji dostawców (w tym OpenCode Zen) znajdują się w
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## „Model nie jest dozwolony” (i dlaczego odpowiedzi się zatrzymują)

Jeśli ustawiono `agents.defaults.models`, staje się on **listą dozwolonych** dla `/model` oraz dla
nadpisań sesji. Gdy użytkownik wybierze model, którego nie ma na tej liście,
OpenClaw zwraca:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Dzieje się to **zanim** zostanie wygenerowana zwykła odpowiedź, więc komunikat może
sprawiać wrażenie, że „nie odpowiedział”. Rozwiązaniem jest:

- Dodanie modelu do `agents.defaults.models`, albo
- Wyczyszczenie listy dozwolonych (usunięcie `agents.defaults.models`), albo
- Wybranie modelu z `/model list`.

Przykładowa konfiguracja listy dozwolonych:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## Przełączanie modeli na czacie (`/model`)

Możesz zmienić model dla bieżącej sesji bez restartu:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Uwagi:

- `/model` (oraz `/model list`) to kompaktowy, numerowany selektor (rodzina modelu + dostępni dostawcy).
- `/model <#>` wybiera z tego selektora.
- `/model status` to widok szczegółowy (kandydaci uwierzytelniania oraz — gdy skonfigurowano — punkt końcowy dostawcy `baseUrl` + tryb `api`).
- Odwołania do modeli są parsowane przez podział po **pierwszym** `/`. Użyj `provider/model` podczas wpisywania `/model <ref>`.
- Jeśli sam identyfikator modelu zawiera `/` (styl OpenRouter), musisz podać prefiks dostawcy (przykład: `/model openrouter/moonshotai/kimi-k2`).
- Jeśli pominiesz dostawcę, OpenClaw traktuje dane wejściowe jako alias lub model dla **domyślnego dostawcy** (działa tylko wtedy, gdy w identyfikatorze modelu nie ma `/`).

Pełne zachowanie poleceń/konfiguracji: [Polecenia slash](/tools/slash-commands).

## Polecenia CLI

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (bez podpolecenia) jest skrótem dla `models status`.

### `models list`

Domyślnie pokazuje skonfigurowane modele. Przydatne flagi:

- `--all`: pełny katalog
- `--local`: tylko lokalni dostawcy
- `--provider <name>`: filtr według dostawcy
- `--plain`: jeden model na linię
- `--json`: wyjście czytelne maszynowo

### `models status`

Pokazuje rozstrzygnięty model podstawowy, fallbacki, model obrazów oraz przegląd uwierzytelniania
skonfigurowanych dostawców. Ujawnia także status wygaśnięcia OAuth dla profili znalezionych
w magazynie uwierzytelnień (domyślnie ostrzega w ciągu 24 h). `--plain` wypisuje wyłącznie
rozstrzygnięty model podstawowy.
Status OAuth jest zawsze wyświetlany (i uwzględniany w wyjściu `--json`). Jeśli skonfigurowany
dostawca nie ma poświadczeń, `models status` wypisuje sekcję **Missing auth**.
JSON zawiera `auth.oauth` (okno ostrzeżeń + profile) oraz `auth.providers`
(skuteczne uwierzytelnianie per dostawca).
Użyj `--check` do automatyzacji (kod wyjścia `1` przy brakujących/wygasłych, `2` przy wygasających).

Preferowanym uwierzytelnianiem Anthropic jest setup-token CLI Claude Code (uruchom w dowolnym miejscu; w razie potrzeby wklej na hoście Gateway):

```bash
claude setup-token
openclaw models status
```

## Skanowanie (bezpłatne modele OpenRouter)

`openclaw models scan` analizuje **bezpłatny katalog modeli** OpenRouter i może
opcjonalnie sondować modele pod kątem obsługi narzędzi i obrazów.

Kluczowe flagi:

- `--no-probe`: pomiń sondy na żywo (tylko metadane)
- `--min-params <b>`: minimalny rozmiar parametrów (miliardy)
- `--max-age-days <days>`: pomiń starsze modele
- `--provider <name>`: filtr prefiksu dostawcy
- `--max-candidates <n>`: rozmiar listy fallbacków
- `--set-default`: ustaw `agents.defaults.model.primary` na pierwszy wybór
- `--set-image`: ustaw `agents.defaults.imageModel.primary` na pierwszy wybór obrazu

Sondowanie wymaga klucza API OpenRouter (z profili uwierzytelniania lub
`OPENROUTER_API_KEY`). Bez klucza użyj `--no-probe`, aby wyświetlić wyłącznie kandydatów.

Wyniki skanowania są rangowane według:

1. Obsługi obrazów
2. Opóźnień narzędzi
3. Rozmiaru kontekstu
4. Liczby parametrów

Wejście

- Lista `/models` OpenRouter (filtr `:free`)
- Wymaga klucza API OpenRouter z profili uwierzytelniania lub `OPENROUTER_API_KEY` (zob. [/environment](/help/environment))
- Filtry opcjonalne: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Kontrole sondowania: `--timeout`, `--concurrency`

Po uruchomieniu w TTY można interaktywnie wybrać fallbacki. W trybie nieinteraktywnym
przekaż `--yes`, aby zaakceptować domyślne wartości.

## Rejestr modeli (`models.json`)

Niestandardowi dostawcy w `models.providers` są zapisywani do `models.json` w katalogu
agenta (domyślnie `~/.openclaw/agents/<agentId>/models.json`). Ten plik
jest domyślnie scalany, chyba że `models.mode` jest ustawione na `replace`.
