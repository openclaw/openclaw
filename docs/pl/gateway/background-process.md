---
summary: "Wykonywanie exec w tle i zarządzanie procesami"
read_when:
  - Dodawanie lub modyfikowanie zachowania exec w tle
  - Debugowanie długotrwałych zadań exec
title: "Exec w tle i narzędzie procesów"
---

# Exec w tle + narzędzie procesów

OpenClaw uruchamia polecenia powłoki za pomocą narzędzia `exec` i przechowuje długotrwałe zadania w pamięci. Narzędzie `process` zarządza tymi sesjami w tle.

## narzędzie exec

Kluczowe parametry:

- `command` (wymagane)
- `yieldMs` (domyślnie 10000): automatyczne przejście do tła po tym opóźnieniu
- `background` (bool): natychmiastowe uruchomienie w tle
- `timeout` (sekundy, domyślnie 1800): zabicie procesu po tym czasie
- `elevated` (bool): uruchomienie na hoście, jeśli tryb podwyższonych uprawnień jest włączony/dozwolony
- Potrzebujesz prawdziwego TTY? Ustaw `pty: true`.
- `workdir`, `env`

Zachowanie:

- Uruchomienia na pierwszym planie zwracają wyjście bezpośrednio.
- Po uruchomieniu w tle (jawnie lub po przekroczeniu limitu czasu) narzędzie zwraca `status: "running"` + `sessionId` oraz krótki fragment końcówki.
- Wyjście jest przechowywane w pamięci do momentu odpytywania lub wyczyszczenia sesji.
- Jeśli narzędzie `process` jest niedozwolone, `exec` działa synchronicznie i ignoruje `yieldMs`/`background`.

## Mostkowanie procesów potomnych

Podczas uruchamiania długotrwałych procesów potomnych poza narzędziami exec/process (na przykład przy ponownych uruchomieniach CLI lub pomocnikach Gateway), dołącz pomocnik mostkowania procesów potomnych, aby sygnały zakończenia były przekazywane, a nasłuchiwacze odłączane przy wyjściu/błędzie. Zapobiega to osieroconym procesom w systemd i zapewnia spójne zachowanie zamykania na różnych platformach.

Nadpisania środowiska:

- `PI_BASH_YIELD_MS`: domyślne yield (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: limit wyjścia w pamięci (znaki)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: limit oczekującego stdout/stderr na strumień (znaki)
- `PI_BASH_JOB_TTL_MS`: TTL dla zakończonych sesji (ms, ograniczone do 1m–3h)

Konfiguracja (zalecane):

- `tools.exec.backgroundMs` (domyślnie 10000)
- `tools.exec.timeoutSec` (domyślnie 1800)
- `tools.exec.cleanupMs` (domyślnie 1800000)
- `tools.exec.notifyOnExit` (domyślnie true): dodaj zdarzenie systemowe do kolejki + zażądaj heartbeat, gdy exec uruchomiony w tle zakończy się.

## narzędzie process

Akcje:

- `list`: sesje uruchomione + zakończone
- `poll`: opróżnij nowe wyjście dla sesji (raportuje także status zakończenia)
- `log`: odczytaj zagregowane wyjście (obsługuje `offset` + `limit`)
- `write`: wyślij stdin (`data`, opcjonalnie `eof`)
- `kill`: zakończ sesję w tle
- `clear`: usuń zakończoną sesję z pamięci
- `remove`: zabij, jeśli działa; w przeciwnym razie wyczyść, jeśli zakończona

Uwagi:

- Tylko sesje uruchomione w tle są wyświetlane i utrwalane w pamięci.
- Sesje są tracone po ponownym uruchomieniu procesu (brak utrwalania na dysku).
- Dzienniki sesji są zapisywane do historii czatu tylko wtedy, gdy uruchomisz `process poll/log` i wynik narzędzia zostanie zarejestrowany.
- `process` jest ograniczone do agenta; widzi wyłącznie sesje uruchomione przez tego agenta.
- `process list` zawiera pochodny `name` (czasownik polecenia + cel) do szybkich przeglądów.
- `process log` używa opartego na liniach `offset`/`limit` (pomiń `offset`, aby pobrać ostatnie N linii).

## Przykłady

Uruchom długie zadanie i odpytaj później:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Uruchom natychmiast w tle:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Wyślij stdin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
