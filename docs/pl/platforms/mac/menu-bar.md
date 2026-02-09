---
summary: "Logika stanu paska menu i to, co jest prezentowane użytkownikom"
read_when:
  - Dostosowywanie interfejsu menu na macOS lub logiki stanu
title: "Pasek menu"
---

# Logika stanu paska menu

## Co jest wyświetlane

- Prezentujemy bieżący stan pracy agenta w ikonie paska menu oraz w pierwszym wierszu stanu menu.
- Stan zdrowia jest ukryty podczas aktywnej pracy; wraca, gdy wszystkie sesje są bezczynne.
- Blok „Nodes” w menu wyświetla wyłącznie **urządzenia** (sparowane węzły przez `node.list`), a nie wpisy klienta/obecności.
- Sekcja „Usage” pojawia się pod Kontekstem, gdy dostępne są migawki użycia dostawcy.

## Model stanu

- Sesje: zdarzenia przychodzą z `runId` (na uruchomienie) wraz z `sessionKey` w ładunku. „Główna” sesja ma klucz `main`; jeśli go brakuje, wracamy do ostatnio zaktualizowanej sesji.
- Priorytet: główna zawsze wygrywa. Jeśli główna jest aktywna, jej stan jest wyświetlany natychmiast. Jeśli główna jest bezczynna, wyświetlana jest ostatnio aktywna sesja niegłówna. Nie przełączamy się w trakcie aktywności; zmiana następuje tylko wtedy, gdy bieżąca sesja przechodzi w bezczynność lub gdy główna staje się aktywna.
- Rodzaje aktywności:
  - `job`: wysokopoziomowe wykonywanie poleceń (`state: started|streaming|done|error`).
  - `tool`: `phase: start|result` z `toolName` oraz `meta/args`.

## Enum IconState (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (nadpisanie debugowe)

### ActivityKind → glif

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- domyślnie → 🛠️

### Mapowanie wizualne

- `idle`: normalny stworek.
- `workingMain`: odznaka z glifem, pełne zabarwienie, animacja „pracy” nóg.
- `workingOther`: odznaka z glifem, stonowane zabarwienie, brak „biegania”.
- `overridden`: używa wybranego glifu/zabarwienia niezależnie od aktywności.

## Tekst wiersza stanu (menu)

- Gdy praca jest aktywna: `<Session role> · <activity label>`
  - Przykłady: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- Gdy bezczynne: powrót do podsumowania stanu zdrowia.

## Ingest zdarzeń

- Źródło: zdarzenia `agent` kanału kontrolnego (`ControlChannel.handleAgentEvent`).
- Parsowane pola:
  - `stream: "job"` z `data.state` dla start/stop.
  - `stream: "tool"` z `data.phase`, `name`, opcjonalnie `meta`/`args`.
- Etykiety:
  - `exec`: pierwsza linia `args.command`.
  - `read`/`write`: skrócona ścieżka.
  - `edit`: ścieżka plus wnioskowany rodzaj zmiany z `meta`/liczników diff.
  - rezerwowo: nazwa narzędzia.

## Nadpisanie debugowe

- Ustawienia ▸ Debug ▸ selektor „Icon override”:
  - `System (auto)` (domyślne)
  - `Working: main` (wg rodzaju narzędzia)
  - `Working: other` (wg rodzaju narzędzia)
  - `Idle`
- Przechowywane przez `@AppStorage("iconOverride")`; mapowane do `IconState.overridden`.

## Lista kontrolna testów

- Uruchom zadanie głównej sesji: sprawdź, czy ikona przełącza się natychmiast i wiersz stanu pokazuje etykietę główną.
- Uruchom zadanie sesji niegłównej, gdy główna jest bezczynna: ikona/stan pokazują niegłówną; pozostaje stabilne do zakończenia.
- Uruchom główną, gdy inna jest aktywna: ikona przełącza się na główną natychmiast.
- Szybkie serie narzędzi: upewnij się, że odznaka nie migocze (okres łaski TTL dla wyników narzędzi).
- Wiersz zdrowia pojawia się ponownie, gdy wszystkie sesje są bezczynne.
