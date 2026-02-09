---
summary: "Referencja CLI dla `openclaw system` (zdarzenia systemowe, heartbeat, obecność)"
read_when:
  - Chcesz umieścić w kolejce zdarzenie systemowe bez tworzenia zadania cron
  - Musisz włączyć lub wyłączyć heartbeat
  - Chcesz sprawdzić wpisy obecności systemu
title: "system"
---

# `openclaw system`

Pomocniki na poziomie systemu dla Gateway: umieszczanie w kolejce zdarzeń systemowych, kontrola heartbeatów
oraz podgląd obecności.

## Typowe polecenia

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Umieszcza w kolejce zdarzenie systemowe w sesji **main**. Następny heartbeat wstrzyknie je
jako linię `System:` w prompt. Użyj `--mode now`, aby wyzwolić heartbeat
natychmiast; `next-heartbeat` czeka na następny zaplanowany takt.

Flagi:

- `--text <text>`: wymagany tekst zdarzenia systemowego.
- `--mode <mode>`: `now` lub `next-heartbeat` (domyślne).
- `--json`: wyjście w formacie do odczytu maszynowego.

## `system heartbeat last|enable|disable`

Sterowanie heartbeatami:

- `last`: pokazuje ostatnie zdarzenie heartbeat.
- `enable`: włącza ponownie heartbeaty (użyj, jeśli były wyłączone).
- `disable`: wstrzymuje heartbeaty.

Flagi:

- `--json`: wyjście w formacie do odczytu maszynowego.

## `system presence`

Wyświetla bieżące wpisy obecności systemu znane Gateway (węzły,
instancje i podobne linie stanu).

Flagi:

- `--json`: wyjście w formacie do odczytu maszynowego.

## Uwagi

- Wymaga działającego Gateway dostępnego zgodnie z bieżącą konfiguracją (lokalnie lub zdalnie).
- Zdarzenia systemowe są efemeryczne i nie są utrwalane pomiędzy restartami.
