---
title: "Przepływ pracy rozwoju Pi"
---

# Przepływ pracy rozwoju Pi

Ten przewodnik podsumowuje rozsądny przepływ pracy przy rozwijaniu integracji Pi w OpenClaw.

## Sprawdzanie typów i lintowanie

- Sprawdzenie typów i budowanie: `pnpm build`
- Lint: `pnpm lint`
- Sprawdzenie formatowania: `pnpm format`
- Pełna bramka przed wypchnięciem zmian: `pnpm lint && pnpm build && pnpm test`

## Uruchamianie testów Pi

Użyj dedykowanego skryptu dla zestawu testów integracji Pi:

```bash
scripts/pi/run-tests.sh
```

Aby dołączyć test na żywo, który sprawdza rzeczywiste zachowanie dostawcy:

```bash
scripts/pi/run-tests.sh --live
```

Skrypt uruchamia wszystkie testy jednostkowe związane z Pi za pomocą następujących globów:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Testy manualne

Zalecany przepływ:

- Uruchom gateway w trybie deweloperskim:
  - `pnpm gateway:dev`
- Wyzwól agenta bezpośrednio:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Użyj TUI do interaktywnego debugowania:
  - `pnpm tui`

Dla zachowania wywołań narzędzi poproś o akcję `read` lub `exec`, aby zobaczyć strumieniowanie narzędzi i obsługę ładunku.

## Reset do czystego stanu

Stan znajduje się w katalogu stanu OpenClaw. Domyślnie jest to `~/.openclaw`. Jeśli ustawiono `OPENCLAW_STATE_DIR`, użyj zamiast tego tego katalogu.

Aby zresetować wszystko:

- `openclaw.json` dla konfiguracji
- `credentials/` dla profili uwierzytelniania i tokenów
- `agents/<agentId>/sessions/` dla historii sesji agenta
- `agents/<agentId>/sessions.json` dla indeksu sesji
- `sessions/` jeśli istnieją ścieżki legacy
- `workspace/` jeśli chcesz pusty obszar roboczy

Jeśli chcesz zresetować tylko sesje, usuń `agents/<agentId>/sessions/` i `agents/<agentId>/sessions.json` dla tego agenta. Zachowaj `credentials/`, jeśli nie chcesz ponownie przechodzić uwierzytelniania.

## Odniesienia

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
