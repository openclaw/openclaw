---
summary: "Referencja CLI dla `openclaw nodes` (list/status/approve/invoke, camera/canvas/screen)"
read_when:
  - Zarządzasz sparowanymi węzłami (kamery, ekran, płótno)
  - Musisz zatwierdzać żądania lub wywoływać polecenia węzłów
title: "węzły"
---

# `openclaw nodes`

Zarządzaj sparowanymi węzłami (urządzeniami) i wywołuj możliwości węzłów.

Powiązane:

- Przegląd węzłów: [Nodes](/nodes)
- Kamera: [Camera nodes](/nodes/camera)
- Obrazy: [Image nodes](/nodes/images)

Typowe opcje:

- `--url`, `--token`, `--timeout`, `--json`

## Typowe polecenia

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` wyświetla tabele oczekujących/sparowanych. Wiersze sparowane zawierają wiek ostatniego połączenia (Last Connect).
Użyj `--connected`, aby wyświetlić tylko aktualnie połączone węzły. Użyj `--last-connected <duration>`, aby
filtrować do węzłów, które połączyły się w określonym czasie (np. `24h`, `7d`).

## Wywołanie / uruchomienie

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Wywołaj flagi:

- `--params <json>`: ciąg obiektu JSON (domyślnie `{}`).
- `--invoke-timeout <ms>`: limit czasu wywołania węzła (domyślnie `15000`).
- `--idempotency-key <key>`: opcjonalny klucz idempotencji.

### Domyślne ustawienia w stylu exec

`nodes run` odzwierciedla zachowanie exec modelu (ustawienia domyślne + zatwierdzenia):

- Odczytuje `tools.exec.*` (plus nadpisania `agents.list[].tools.exec.*`).
- Używa zatwierdzeń exec (`exec.approval.request`) przed wywołaniem `system.run`.
- `--node` można pominąć, gdy ustawione jest `tools.exec.node`.
- Wymaga węzła, który ogłasza `system.run` (aplikacja towarzysząca na macOS lub bezgłowy host węzła).

Flagi:

- `--cwd <path>`: katalog roboczy.
- `--env <key=val>`: nadpisanie zmiennych środowiskowych (powtarzalne).
- `--command-timeout <ms>`: limit czasu polecenia.
- `--invoke-timeout <ms>`: limit czasu wywołania węzła (domyślnie `30000`).
- `--needs-screen-recording`: wymagaj uprawnienia do nagrywania ekranu.
- `--raw <command>`: uruchom ciąg powłoki (`/bin/sh -lc` lub `cmd.exe /c`).
- `--agent <id>`: zatwierdzenia/listy dozwolonych w zakresie agenta (domyślnie skonfigurowany agent).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: nadpisania.
