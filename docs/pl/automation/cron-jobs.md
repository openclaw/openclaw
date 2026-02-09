---
summary: "Zadania cron + wybudzenia dla harmonogramu Gateway"
read_when:
  - Planowanie zadań w tle lub wybudzeń
  - Łączenie automatyzacji, które powinny działać z heartbeatami lub obok nich
  - Wybór między heartbeat a cron dla zadań harmonogramowanych
title: "Zadania Cron"
---

# Zadania crona (Gateway scheduler)

> **Cron czy Heartbeat?** Zobacz [Cron vs Heartbeat](/automation/cron-vs-heartbeat), aby uzyskać wskazówki, kiedy używać każdego z nich.

Cron to wbudowany harmonogram Gateway. Przechowuje zadania, wybudza agenta
we właściwym czasie i opcjonalnie może dostarczać wyjście z powrotem do czatu.

Jeśli chcesz _„uruchamiaj to każdego ranka”_ albo _„szturchnij agenta za 20 minut”_,
cron jest właściwym mechanizmem.

Rozwiązywanie problemów: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron działa **wewnątrz Gateway** (nie wewnątrz modelu).
- Zadania są przechowywane w `~/.openclaw/cron/`, więc restarty nie powodują utraty harmonogramów.
- Dwa style wykonania:
  - **Sesja główna**: dodanie zdarzenia systemowego do kolejki, a następnie uruchomienie przy następnym heartbeat.
  - **Izolowany**: uruchomienie dedykowanej tury agenta w `cron:<jobId>`, z dostarczaniem (domyślnie ogłoszenie lub brak).
- Wybudzenia są elementem pierwszej klasy: zadanie może zażądać „obudź teraz” zamiast „przy następnym heartbeat”.

## Szybki start (konkretne działania)

Utwórz jednorazowe przypomnienie, sprawdź, czy istnieje, i uruchom je natychmiast:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

Zaplanuj cykliczne zadanie izolowane z dostarczaniem:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## Odpowiedniki wywołań narzędzi (narzędzie cron Gateway)

Kanoniczne kształty JSON i przykłady znajdziesz w [Schemacie JSON dla wywołań narzędzi](/automation/cron-jobs#json-schema-for-tool-calls).

## Gdzie przechowywane są zadania cron

Zadania cron są domyślnie zapisywane na hoście Gateway w `~/.openclaw/cron/jobs.json`.
Gateway ładuje plik do pamięci i zapisuje go ponownie przy zmianach, dlatego ręczne edycje
są bezpieczne tylko wtedy, gdy Gateway jest zatrzymany. Preferuj `openclaw cron add/edit` lub
API wywołań narzędzi cron do wprowadzania zmian.

## Przegląd przyjazny dla początkujących

Myśl o zadaniu cron jako o: **kiedy** uruchomić + **co** zrobić.

1. **Wybierz harmonogram**
   - Jednorazowe przypomnienie → `schedule.kind = "at"` (CLI: `--at`)
   - Zadanie cykliczne → `schedule.kind = "every"` lub `schedule.kind = "cron"`
   - Jeśli znacznik czasu ISO pomija strefę czasową, jest traktowany jako **UTC**.

2. **Wybierz miejsce wykonania**
   - `sessionTarget: "main"` → uruchomienie podczas następnego heartbeat z głównym kontekstem.
   - `sessionTarget: "isolated"` → uruchomienie dedykowanej tury agenta w `cron:<jobId>`.

3. **Wybierz ładunek**
   - Sesja główna → `payload.kind = "systemEvent"`
   - Sesja izolowana → `payload.kind = "agentTurn"`

Opcjonalnie: zadania jednorazowe (`schedule.kind = "at"`) są domyślnie usuwane po powodzeniu. Ustaw
`deleteAfterRun: false`, aby je zachować (zostaną wyłączone po powodzeniu).

## Pojęcia

### Zadania

Zadanie cron to zapisany rekord z:

- **harmonogramem** (kiedy ma się uruchomić),
- **ładunkiem** (co ma zrobić),
- opcjonalnym **trybem dostarczania** (ogłoszenie lub brak).
- opcjonalnym **powiązaniem z agentem** (`agentId`): uruchom zadanie pod konkretnym agentem; jeśli
  brak lub nieznany, gateway wraca do domyślnego agenta.

Zadania są identyfikowane przez stabilny `jobId` (używany przez CLI/API Gateway).
W wywołaniach narzędzi agenta `jobId` jest kanoniczne; starsze `id` jest akceptowane dla zgodności.
Zadania jednorazowe są domyślnie automatycznie usuwane po powodzeniu; ustaw `deleteAfterRun: false`, aby je zachować.

### Harmonogramy

Cron obsługuje trzy rodzaje harmonogramów:

- `at`: jednorazowy znacznik czasu przez `schedule.at` (ISO 8601).
- `every`: stały interwał (ms).
- `cron`: 5-polowe wyrażenie cron z opcjonalną strefą czasową IANA.

Wyrażenia cron używają `croner`. Jeśli strefa czasowa jest pominięta, używana jest
lokalna strefa czasowa hosta Gateway.

### Wykonanie główne vs izolowane

#### Zadania sesji głównej (zdarzenia systemowe)

Zadania główne dodają zdarzenie systemowe do kolejki i opcjonalnie wybudzają runner heartbeat.
Muszą używać `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (domyślnie): zdarzenie wyzwala natychmiastowe uruchomienie heartbeat.
- `wakeMode: "next-heartbeat"`: zdarzenie czeka na następny zaplanowany heartbeat.

To najlepszy wybór, gdy chcesz normalny prompt heartbeat + kontekst sesji głównej.
Zobacz [Heartbeat](/gateway/heartbeat).

#### Zadania izolowane (dedykowane sesje cron)

Zadania izolowane uruchamiają dedykowaną turę agenta w sesji `cron:<jobId>`.

Kluczowe zachowania:

- Prompt jest poprzedzony `[cron:<jobId> <job name>]` dla identyfikowalności.
- Każde uruchomienie rozpoczyna **świeże ID sesji** (bez przenoszenia wcześniejszej rozmowy).
- Domyślne zachowanie: jeśli `delivery` jest pominięte, zadania izolowane ogłaszają podsumowanie (`delivery.mode = "announce"`).
- `delivery.mode` (tylko izolowane) określa, co się dzieje:
  - `announce`: dostarcza podsumowanie do kanału docelowego i publikuje krótkie podsumowanie w sesji głównej.
  - `none`: tylko wewnętrznie (brak dostarczania, brak podsumowania sesji głównej).
- `wakeMode` kontroluje moment publikacji podsumowania sesji głównej:
  - `now`: natychmiastowy heartbeat.
  - `next-heartbeat`: czeka na następny zaplanowany heartbeat.

Używaj zadań izolowanych dla głośnych, częstych lub „zadań w tle”, które nie powinny
zaśmiecać historii głównego czatu.

### Kształty ładunków (co jest uruchamiane)

Obsługiwane są dwa rodzaje ładunków:

- `systemEvent`: tylko sesja główna, kierowane przez prompt heartbeat.
- `agentTurn`: tylko sesja izolowana, uruchamia dedykowaną turę agenta.

Wspólne pola `agentTurn`:

- `message`: wymagany tekst promptu.
- `model` / `thinking`: opcjonalne nadpisania (zobacz poniżej).
- `timeoutSeconds`: opcjonalne nadpisanie limitu czasu.

Konfiguracja dostarczania (tylko zadania izolowane):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` lub konkretny kanał.
- `delivery.to`: cel specyficzny dla kanału (telefon/czat/id kanału).
- `delivery.bestEffort`: unika niepowodzenia zadania, jeśli dostarczenie ogłoszenia się nie powiedzie.

Dostarczanie typu „announce” tłumi wysyłki narzędzia wiadomości dla danego uruchomienia; użyj `delivery.channel`/`delivery.to`,
aby skierować wiadomość bezpośrednio do czatu. Gdy `delivery.mode = "none"`, żadne podsumowanie nie jest publikowane w sesji głównej.

Jeśli `delivery` jest pominięte dla zadań izolowanych, OpenClaw domyślnie ustawia `announce`.

#### Przepływ dostarczania typu announce

Gdy `delivery.mode = "announce"`, cron dostarcza bezpośrednio przez adaptery kanałów wychodzących.
Główny agent nie jest uruchamiany, aby tworzyć lub przekazywać wiadomość.

Szczegóły zachowania:

- Treść: dostarczanie używa wychodzących ładunków (tekst/media) z uruchomienia izolowanego, z normalnym dzieleniem na fragmenty i
  formatowaniem kanału.
- Odpowiedzi tylko-heartbeat (`HEARTBEAT_OK` bez rzeczywistej treści) nie są dostarczane.
- Jeśli uruchomienie izolowane już wysłało wiadomość do tego samego celu przez narzędzie wiadomości, dostarczanie jest
  pomijane, aby uniknąć duplikatów.
- Brakujące lub nieprawidłowe cele dostarczania powodują niepowodzenie zadania, chyba że `delivery.bestEffort = true`.
- Krótkie podsumowanie jest publikowane w sesji głównej tylko gdy `delivery.mode = "announce"`.
- Podsumowanie sesji głównej respektuje `wakeMode`: `now` wyzwala natychmiastowy heartbeat, a
  `next-heartbeat` czeka na następny zaplanowany heartbeat.

### Nadpisania modelu i „thinking”

Zadania izolowane (`agentTurn`) mogą nadpisywać model i poziom myślenia:

- `model`: ciąg dostawca/model (np. `anthropic/claude-sonnet-4-20250514`) lub alias (np. `opus`)
- `thinking`: poziom myślenia (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; tylko modele GPT-5.2 + Codex)

Uwaga: Możesz ustawić `model` także dla zadań sesji głównej, ale zmienia to współdzielony model
sesji głównej. Zalecamy nadpisania modelu wyłącznie dla zadań izolowanych, aby uniknąć
nieoczekiwanych zmian kontekstu.

Priorytet rozstrzygania:

1. Nadpisanie w ładunku zadania (najwyższy)
2. Domyślne ustawienia specyficzne dla hooka (np. `hooks.gmail.model`)
3. Domyślna konfiguracja agenta

### Dostarczanie (kanał + cel)

Zadania izolowane mogą dostarczać wyjście do kanału poprzez konfigurację najwyższego poziomu `delivery`:

- `delivery.mode`: `announce` (dostarczenie podsumowania) lub `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (wtyczka) / `signal` / `imessage` / `last`.
- `delivery.to`: cel odbiorcy specyficzny dla kanału.

Konfiguracja dostarczania jest ważna tylko dla zadań izolowanych (`sessionTarget: "isolated"`).

Jeśli `delivery.channel` lub `delivery.to` jest pominięte, cron może wrócić do „ostatniej trasy”
sesji głównej (ostatniego miejsca, w którym agent odpowiedział).

Przypomnienia dot. formatu celów:

- Cele Slack/Discord/Mattermost (wtyczka) powinny używać jawnych prefiksów (np. `channel:<id>`, `user:<id>`), aby uniknąć niejednoznaczności.
- Tematy Telegrama powinny używać formy `:topic:` (zobacz poniżej).

#### Cele dostarczania Telegram (tematy / wątki forum)

Telegram obsługuje tematy forum poprzez `message_thread_id`. Dla dostarczania cron możesz zakodować
temat/wątek w polu `to`:

- `-1001234567890` (tylko id czatu)
- `-1001234567890:topic:123` (zalecane: jawny znacznik tematu)
- `-1001234567890:123` (skrót: numeryczny sufiks)

Prefiksowane cele, takie jak `telegram:...` / `telegram:group:...`, są również akceptowane:

- `telegram:group:-1001234567890:topic:123`

## Schemat JSON dla wywołań narzędzi

Używaj tych kształtów, wywołując bezpośrednio narzędzia Gateway `cron.*` (wywołania narzędzi agenta lub RPC).
Flagi CLI akceptują czytelne czasy trwania, takie jak `20m`, ale wywołania narzędzi powinny używać ciągu ISO 8601
dla `schedule.at` oraz milisekund dla `schedule.everyMs`.

### Parametry cron.add

Jednorazowe zadanie sesji głównej (zdarzenie systemowe):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

Cykliczne zadanie izolowane z dostarczaniem:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

Uwagi:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`) lub `cron` (`expr`, opcjonalnie `tz`).
- `schedule.at` akceptuje ISO 8601 (strefa czasowa opcjonalna; przy braku traktowana jako UTC).
- `everyMs` to milisekundy.
- `sessionTarget` musi być `"main"` lub `"isolated"` i musi odpowiadać `payload.kind`.
- Pola opcjonalne: `agentId`, `description`, `enabled`, `deleteAfterRun` (domyślnie true dla `at`),
  `delivery`.
- `wakeMode` domyślnie ma wartość `"now"`, gdy jest pominięte.

### Parametry cron.update

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

Uwagi:

- `jobId` jest kanoniczne; `id` jest akceptowane dla zgodności.
- Użyj `agentId: null` w patchu, aby wyczyścić powiązanie agenta.

### Parametry cron.run i cron.remove

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Przechowywanie i historia

- Magazyn zadań: `~/.openclaw/cron/jobs.json` (JSON zarządzany przez Gateway).
- Historia uruchomień: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, automatycznie przycinany).
- Nadpisanie ścieżki magazynu: `cron.store` w konfiguracji.

## Konfiguracja

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

Całkowite wyłączenie cron:

- `cron.enabled: false` (konfiguracja)
- `OPENCLAW_SKIP_CRON=1` (env)

## Szybki start CLI

Jednorazowe przypomnienie (UTC ISO, automatyczne usunięcie po powodzeniu):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

Jednorazowe przypomnienie (sesja główna, natychmiastowe wybudzenie):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Cykliczne zadanie izolowane (ogłoszenie do WhatsApp):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Cykliczne zadanie izolowane (dostarczenie do tematu Telegrama):

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

Zadanie izolowane z nadpisaniem modelu i poziomu myślenia:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Wybór agenta (konfiguracje wieloagentowe):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Ręczne uruchomienie (force jest domyślne, użyj `--due`, aby uruchamiać tylko, gdy należne):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

Edycja istniejącego zadania (patch pól):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Historia uruchomień:

```bash
openclaw cron runs --id <jobId> --limit 50
```

Natychmiastowe zdarzenie systemowe bez tworzenia zadania:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Powierzchnia API Gateway

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force lub due), `cron.runs`
  Dla natychmiastowych zdarzeń systemowych bez zadania użyj [`openclaw system event`](/cli/system).

## Rozwiązywanie problemów

### „Nic się nie uruchamia”

- Sprawdź, czy cron jest włączony: `cron.enabled` oraz `OPENCLAW_SKIP_CRON`.
- Sprawdź, czy Gateway działa w sposób ciągły (cron działa wewnątrz procesu Gateway).
- Dla harmonogramów `cron`: potwierdź strefę czasową (`--tz`) względem strefy hosta.

### Powtarzające się zadanie opóźnia się po niepowodzeniach

- OpenClaw stosuje wykładnicze opóźnienie ponownych prób dla zadań cyklicznych po kolejnych błędach:
  30 s, 1 min, 5 min, 15 min, następnie 60 min między próbami.
- Opóźnienie resetuje się automatycznie po następnym udanym uruchomieniu.
- Zadania jednorazowe (`at`) są wyłączane po uruchomieniu terminalnym (`ok`, `error` lub `skipped`) i nie są ponawiane.

### Telegram dostarcza w złe miejsce

- Dla tematów forum użyj `-100…:topic:<id>`, aby było to jawne i jednoznaczne.
- Jeśli w logach lub zapisanych celach „ostatniej trasy” widzisz prefiksy `telegram:...`, to normalne;
  dostarczanie cron je akceptuje i nadal poprawnie parsuje identyfikatory tematów.
