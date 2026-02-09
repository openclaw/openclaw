---
summary: "„Przegląd logowania: logi plikowe, wyjście konsoli, podgląd w CLI oraz interfejs Control UI”"
read_when:
  - Potrzebujesz przyjaznego dla początkujących przeglądu logowania
  - Chcesz skonfigurować poziomy lub formaty logów
  - Rozwiązujesz problemy i musisz szybko znaleźć logi
title: "Logowanie"
---

# Logowanie

OpenClaw zapisuje logi w dwóch miejscach:

- **Logi plikowe** (linie JSON) zapisywane przez Gateway.
- **Wyjście konsoli** wyświetlane w terminalach oraz w interfejsie Control UI.

Ta strona wyjaśnia, gdzie znajdują się logi, jak je czytać oraz jak konfigurować
poziomy i formaty logowania.

## Gdzie logi na żywo

Domyślnie Gateway zapisuje rotujący plik logów w:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

Data używa lokalnej strefy czasowej hosta gateway.

Możesz to nadpisać w `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## Jak czytać logi

### CLI: podgląd na żywo (zalecane)

Użyj CLI, aby śledzić plik logów gateway przez RPC:

```bash
openclaw logs --follow
```

Tryby wyjścia:

- **Sesje TTY**: estetyczne, kolorowe, ustrukturyzowane linie logów.
- **Sesje bez TTY**: zwykły tekst.
- `--json`: JSON rozdzielany liniami (jedno zdarzenie logu na linię).
- `--plain`: wymuś zwykły tekst w sesjach TTY.
- `--no-color`: wyłącz kolory ANSI.

W trybie JSON CLI emituje obiekty oznaczone tagiem `type`:

- `meta`: metadane strumienia (plik, kursor, rozmiar)
- `log`: sparsowany wpis logu
- `notice`: wskazówki dotyczące obcięcia / rotacji
- `raw`: niesparsowana linia logu

Jeśli Gateway jest nieosiągalny, CLI wyświetli krótką wskazówkę, aby uruchomić:

```bash
openclaw doctor
```

### Control UI (web)

Zakładka **Logs** w Control UI śledzi ten sam plik przy użyciu `logs.tail`.
Zobacz [/web/control-ui](/web/control-ui), aby dowiedzieć się, jak ją otworzyć.

### Logi tylko dla kanałów

Aby filtrować aktywność kanałów (WhatsApp/Telegram/etc), użyj:

```bash
openclaw channels logs --channel whatsapp
```

## Formaty logów

### Logi plikowe (JSONL)

Każda linia w pliku logów jest obiektem JSON. CLI i Control UI parsują te wpisy,
aby renderować ustrukturyzowane wyjście (czas, poziom, podsystem, komunikat).

### Wyjście konsoli

Logi konsoli są **świadome TTY** i sformatowane pod kątem czytelności:

- Prefiksy podsystemów (np. `gateway/channels/whatsapp`)
- Kolorowanie poziomów (info/warn/error)
- Opcjonalny tryb kompaktowy lub JSON

Formatowanie konsoli jest kontrolowane przez `logging.consoleStyle`.

## Konfigurowanie logowania

Cała konfiguracja logowania znajduje się pod `logging` w `~/.openclaw/openclaw.json`.

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### Poziomy logów

- `logging.level`: poziom **logów plikowych** (JSONL).
- `logging.consoleLevel`: poziom szczegółowości **konsoli**.

`--verbose` wpływa tylko na wyjście konsoli; nie zmienia poziomów logów plikowych.

### Style konsoli

`logging.consoleStyle`:

- `pretty`: przyjazny dla człowieka, kolorowy, z znacznikami czasu.
- `compact`: bardziej zwarty format (najlepszy dla długich sesji).
- `json`: JSON na linię (dla procesorów logów).

### Redakcja

Podsumowania narzędzi mogą redagować wrażliwe tokeny, zanim trafią do konsoli:

- `logging.redactSensitive`: `off` | `tools` (domyślnie: `tools`)
- `logging.redactPatterns`: lista wyrażeń regularnych do nadpisania zestawu domyślnego

Redakcja dotyczy **tylko wyjścia konsoli** i nie zmienia logów plikowych.

## Diagnostyka + OpenTelemetry

Diagnostyka to ustrukturyzowane, czytelne maszynowo zdarzenia dla uruchomień modeli **oraz**
telemetrii przepływu wiadomości (webhooki, kolejkowanie, stan sesji). **Nie**
zastępują one logów; istnieją po to, aby zasilać metryki, ślady (traces) i inne eksportery.

Zdarzenia diagnostyczne są emitowane w procesie, ale eksportery dołączają się tylko wtedy,
gdy włączone są diagnostyka **i** wtyczka eksportera.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**: model danych + SDK dla śladów, metryk i logów.
- **OTLP**: protokół transmisji używany do eksportu danych OTel do kolektora/backendu.
- OpenClaw eksportuje obecnie przez **OTLP/HTTP (protobuf)**.

### Eksportowane sygnały

- **Metryki**: liczniki + histogramy (użycie tokenów, przepływ wiadomości, kolejkowanie).
- **Ślady**: spany dla użycia modeli + przetwarzania webhooków/wiadomości.
- **Logi**: eksportowane przez OTLP, gdy włączone jest `diagnostics.otel.logs`. Wolumen
  logów może być wysoki; miej na uwadze `logging.level` oraz filtry eksportera.

### Katalog zdarzeń diagnostycznych

Użycie modelu:

- `model.usage`: tokeny, koszt, czas trwania, kontekst, dostawca/model/kanał, identyfikatory sesji.

Przepływ wiadomości:

- `webhook.received`: wejście webhooka na kanał.
- `webhook.processed`: obsłużony webhook + czas trwania.
- `webhook.error`: błędy obsługi webhooka.
- `message.queued`: wiadomość zakolejkowana do przetwarzania.
- `message.processed`: wynik + czas trwania + opcjonalny błąd.

Kolejki + sesje:

- `queue.lane.enqueue`: dodanie do pasa kolejki poleceń + głębokość.
- `queue.lane.dequeue`: zdjęcie z pasa kolejki poleceń + czas oczekiwania.
- `session.state`: przejście stanu sesji + powód.
- `session.stuck`: ostrzeżenie o zablokowanej sesji + wiek.
- `run.attempt`: metadane ponowień/prób uruchomienia.
- `diagnostic.heartbeat`: liczniki zbiorcze (webhooki/kolejka/sesja).

### Włączanie diagnostyki (bez eksportera)

Użyj tego, jeśli chcesz, aby zdarzenia diagnostyczne były dostępne dla wtyczek lub
niestandardowych ujść:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Flagi diagnostyczne (logi ukierunkowane)

Użyj flag, aby włączyć dodatkowe, ukierunkowane logi debug bez podnoszenia `logging.level`.
Flagi nie rozróżniają wielkości liter i obsługują symbole wieloznaczne (np. `telegram.*` lub `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Zastąpienie Env (jednorazowe):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Uwagi:

- Logi flag trafiają do standardowego pliku logów (takiego samego jak `logging.file`).
- Wyjście nadal podlega redakcji zgodnie z `logging.redactSensitive`.
- Pełny przewodnik: [/diagnostics/flags](/diagnostics/flags).

### Eksport do OpenTelemetry

Diagnostyka może być eksportowana przez wtyczkę `diagnostics-otel` (OTLP/HTTP). Działa to
z dowolnym kolektorem/backendem OpenTelemetry, który akceptuje OTLP/HTTP.

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

Uwagi:

- Wtyczkę można także włączyć za pomocą `openclaw plugins enable diagnostics-otel`.
- `protocol` obsługuje obecnie tylko `http/protobuf`. `grpc` jest ignorowane.
- Metryki obejmują użycie tokenów, koszt, rozmiar kontekstu, czas trwania uruchomienia oraz
  liczniki/histogramy przepływu wiadomości (webhooki, kolejkowanie, stan sesji, głębokość/czas oczekiwania kolejki).
- Ślady/metyki można przełączać za pomocą `traces` / `metrics` (domyślnie: włączone). Ślady
  obejmują spany użycia modelu oraz spany przetwarzania webhooków/wiadomości, gdy są włączone.
- Ustaw `headers`, gdy kolektor wymaga uwierzytelnienia.
- Obsługiwane zmienne środowiskowe: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Eksportowane metryki (nazwy + typy)

Użycie modelu:

- `openclaw.tokens` (licznik, atrybuty: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (licznik, atrybuty: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (histogram, atrybuty: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histogram, atrybuty: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Przepływ wiadomości:

- `openclaw.webhook.received` (licznik, atrybuty: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (licznik, atrybuty: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histogram, atrybuty: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (licznik, atrybuty: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (licznik, atrybuty: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (histogram, atrybuty: `openclaw.channel`,
  `openclaw.outcome`)

Kolejki + sesje:

- `openclaw.queue.lane.enqueue` (licznik, atrybuty: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (licznik, atrybuty: `openclaw.lane`)
- `openclaw.queue.depth` (histogram, atrybuty: `openclaw.lane` lub
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histogram, atrybuty: `openclaw.lane`)
- `openclaw.session.state` (licznik, atrybuty: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (licznik, atrybuty: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histogram, atrybuty: `openclaw.state`)
- `openclaw.run.attempt` (licznik, atrybuty: `openclaw.attempt`)

### Eksportowane spany (nazwy + kluczowe atrybuty)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`,
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`,
    `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`,
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`,
    `openclaw.sessionKey`, `openclaw.sessionId`

### Próbkowanie + opróżnianie

- Próbkowanie śladów: `diagnostics.otel.sampleRate` (0.0–1.0, tylko spany główne).
- Interwał eksportu metryk: `diagnostics.otel.flushIntervalMs` (min. 1000 ms).

### Uwagi dotyczące protokołu

- Punkty końcowe OTLP/HTTP można ustawić przez `diagnostics.otel.endpoint` lub
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Jeśli punkt końcowy zawiera już `/v1/traces` lub `/v1/metrics`, jest używany bez zmian.
- Jeśli punkt końcowy zawiera już `/v1/logs`, jest używany bez zmian dla logów.
- `diagnostics.otel.logs` włącza eksport logów OTLP dla głównego wyjścia loggera.

### Zachowanie eksportu logów

- Logi OTLP używają tych samych ustrukturyzowanych rekordów, które są zapisywane do `logging.file`.
- Respektują `logging.level` (poziom logów plikowych). Redakcja konsoli **nie** ma
  zastosowania do logów OTLP.
- Instalacje o dużym wolumenie powinny preferować próbkowanie/filtrowanie w kolektorze OTLP.

## Wskazówki dotyczące rozwiązywania problemów

- **Gateway nieosiągalny?** Najpierw uruchom `openclaw doctor`.
- **Logi puste?** Sprawdź, czy Gateway działa i zapisuje do ścieżki pliku
  w `logging.file`.
- **Potrzebujesz więcej szczegółów?** Ustaw `logging.level` na `debug` lub `trace` i spróbuj ponownie.
