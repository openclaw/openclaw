---
summary: "„Jak uruchamiać testy lokalnie (vitest) oraz kiedy używać trybów force/coverage”"
read_when:
  - Uruchamianie lub naprawianie testów
title: "„Testy”"
---

# Testy

- Pełny zestaw testów (pakiety, tryb live, Docker): [Testing](/help/testing)

- `pnpm test:force`: Zamyka wszelkie pozostałe procesy gateway zajmujące domyślny port kontrolny, a następnie uruchamia pełny zestaw Vitest z odizolowanym portem gateway, aby testy serwera nie kolidowały z uruchomioną instancją. Użyj tego, gdy poprzednie uruchomienie gateway pozostawiło zajęty port 18789.

- `pnpm test:coverage`: Uruchamia Vitest z pokryciem V8. Globalne progi wynoszą 70% dla linii/gałęzi/funkcji/instrukcji. Pokrycie wyklucza punkty wejścia silnie integracyjne (okablowanie CLI, mosty gateway/Telegram, statyczny serwer webchat), aby utrzymać cel skupiony na logice możliwej do testowania jednostkowego.

- `pnpm test:e2e`: Uruchamia testy typu smoke end-to-end gateway (parowanie wielu instancji WS/HTTP/node).

- `pnpm test:live`: Uruchamia testy live dostawców (minimax/zai). Wymaga kluczy API oraz `LIVE=1` (lub specyficznego dla dostawcy `*_LIVE_TEST=1`), aby odblokować pomijane testy.

## Benchmark opóźnień modeli (klucze lokalne)

Skrypt: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Użycie:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Opcjonalne zmienne środowiskowe: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Domyślna treść promptu: „Odpowiedz jednym słowem: ok. Bez interpunkcji ani dodatkowego tekstu.”

Ostatnie uruchomienie (2025-12-31, 20 uruchomień):

- minimax — mediana 1279 ms (min. 1114, maks. 2431)
- opus — mediana 2454 ms (min. 1224, maks. 3170)

## Onboarding E2E (Docker)

Docker jest opcjonalny; jest potrzebny wyłącznie do kontenerowych testów typu smoke dla onboardingu.

Pełny przepływ „cold start” w czystym kontenerze Linux:

```bash
scripts/e2e/onboard-docker.sh
```

Ten skrypt steruje interaktywnym kreatorem przez pseudo-TTY, weryfikuje pliki konfiguracji/obszaru roboczego/sesji, a następnie uruchamia gateway i wykonuje `openclaw health`.

## Smoke importu QR (Docker)

Zapewnia, że `qrcode-terminal` ładuje się w Node 22+ w Dockerze:

```bash
pnpm test:docker:qr
```
