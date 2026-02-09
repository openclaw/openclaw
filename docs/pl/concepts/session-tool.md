---
summary: "Narzędzia sesji agenta do listowania sesji, pobierania historii oraz wysyłania wiadomości między sesjami"
read_when:
  - Dodawanie lub modyfikowanie narzędzi sesji
title: "Narzędzia sesji"
---

# Narzędzia sesji

Cel: mały, trudny do niewłaściwego użycia zestaw narzędzi, aby agenci mogli listować sesje, pobierać historię i wysyłać wiadomości do innej sesji.

## Nazwy narzędzi

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Model kluczy

- Główny koszyk bezpośredniego czatu to zawsze dosłowny klucz `"main"` (rozwiązywany do głównego klucza bieżącego agenta).
- Czaty grupowe używają `agent:<agentId>:<channel>:group:<id>` lub `agent:<agentId>:<channel>:channel:<id>` (przekaż pełny klucz).
- Zadania cron używają `cron:<job.id>`.
- Hooki używają `hook:<uuid>`, o ile nie ustawiono inaczej.
- Sesje węzłów używają `node-<nodeId>`, o ile nie ustawiono inaczej.

`global` i `unknown` są wartościami zarezerwowanymi i nigdy nie są listowane. Jeśli `session.scope = "global"`, aliasujemy to do `main` dla wszystkich narzędzi, aby wywołujący nigdy nie widzieli `global`.

## sessions_list

Listuje sesje jako tablicę wierszy.

Parametry:

- filtr `kinds?: string[]`: dowolny z `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` maks. liczba wierszy (domyślnie: domyślna wartość serwera, ograniczana np. do 200)
- `activeMinutes?: number` tylko sesje zaktualizowane w ciągu N minut
- `messageLimit?: number` 0 = brak wiadomości (domyślnie 0); >0 = dołącz ostatnie N wiadomości

Zachowanie:

- `messageLimit > 0` pobiera `chat.history` na sesję i dołącza ostatnie N wiadomości.
- Wyniki narzędzi są filtrowane z wyjścia listy; do wiadomości narzędzi użyj `sessions_history`.
- Przy uruchomieniu w **sandboxed** sesji agenta narzędzia sesji domyślnie mają **widoczność tylko sesji utworzonych** (zob. niżej).

Kształt wiersza (JSON):

- `key`: klucz sesji (string)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (etykieta wyświetlana grupy, jeśli dostępna)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (nadpisanie sesji, jeśli ustawione)
- `lastChannel`, `lastTo`
- `deliveryContext` (znormalizowane `{ channel, to, accountId }`, gdy dostępne)
- `transcriptPath` (ścieżka best‑effort wyprowadzona z katalogu magazynu + sessionId)
- `messages?` (tylko gdy `messageLimit > 0`)

## sessions_history

Pobiera transkrypt dla jednej sesji.

Parametry:

- `sessionKey` (wymagane; akceptuje klucz sesji lub `sessionId` z `sessions_list`)
- `limit?: number` maks. liczba wiadomości (ograniczana przez serwer)
- `includeTools?: boolean` (domyślnie false)

Zachowanie:

- `includeTools=false` filtruje wiadomości `role: "toolResult"`.
- Zwraca tablicę wiadomości w surowym formacie transkryptu.
- Po podaniu `sessionId` OpenClaw rozwiązuje go do odpowiadającego klucza sesji (błąd przy brakujących identyfikatorach).

## sessions_send

Wysyła wiadomość do innej sesji.

Parametry:

- `sessionKey` (wymagane; akceptuje klucz sesji lub `sessionId` z `sessions_list`)
- `message` (wymagane)
- `timeoutSeconds?: number` (domyślnie >0; 0 = wyślij i zapomnij)

Zachowanie:

- `timeoutSeconds = 0`: kolejkowanie i zwrot `{ runId, status: "accepted" }`.
- `timeoutSeconds > 0`: oczekiwanie do N sekund na zakończenie, następnie zwrot `{ runId, status: "ok", reply }`.
- Jeśli oczekiwanie przekroczy limit czasu: `{ runId, status: "timeout", error }`. Uruchomienie trwa dalej; wywołaj później `sessions_history`.
- Jeśli uruchomienie się nie powiedzie: `{ runId, status: "error", error }`.
- Uruchomienia ogłoszeń po dostarczeniu są anonsowane po zakończeniu uruchomienia głównego i mają charakter best‑effort; `status: "ok"` nie gwarantuje, że anons został dostarczony.
- Oczekiwanie odbywa się przez gateway `agent.wait` (po stronie serwera), więc ponowne połączenia nie przerywają oczekiwania.
- Kontekst wiadomości agent‑do‑agenta jest wstrzykiwany dla uruchomienia głównego.
- Po zakończeniu uruchomienia głównego OpenClaw uruchamia **pętlę odpowiedzi zwrotnej**:
  - Runda 2+ naprzemiennie przełącza się między agentem żądającym a docelowym.
  - Odpowiedz dokładnie `REPLY_SKIP`, aby zatrzymać ping‑pong.
  - Maksymalna liczba tur to `session.agentToAgent.maxPingPongTurns` (0–5, domyślnie 5).
- Po zakończeniu pętli OpenClaw uruchamia **krok ogłoszenia agent‑do‑agenta** (tylko agent docelowy):
  - Odpowiedz dokładnie `ANNOUNCE_SKIP`, aby pozostać w ciszy.
  - Każda inna odpowiedź jest wysyłana do kanału docelowego.
  - Krok ogłoszenia zawiera oryginalne żądanie + odpowiedź z rundy 1 + najnowszą odpowiedź ping‑pong.

## Pole kanału

- Dla grup `channel` to kanał zapisany we wpisie sesji.
- Dla czatów bezpośrednich `channel` mapuje się z `lastChannel`.
- Dla cron/hook/node `channel` to `internal`.
- Jeśli brak, `channel` to `unknown`.

## Bezpieczeństwo / polityka wysyłania

Blokowanie oparte na politykach według kanału/typu czatu (nie według identyfikatora sesji).

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

Nadpisanie w czasie działania (na wpis sesji):

- `sendPolicy: "allow" | "deny"` (nieustawione = dziedziczenie konfiguracji)
- Ustawialne przez `sessions.patch` lub tylko dla właściciela `/send on|off|inherit` (samodzielna wiadomość).

Punkty egzekwowania:

- `chat.send` / `agent` (gateway)
- logika dostarczania auto‑odpowiedzi

## sessions_spawn

Uruchamia pod‑agenta w izolowanej sesji i ogłasza wynik z powrotem do kanału czatu żądającego.

Parametry:

- `task` (wymagane)
- `label?` (opcjonalne; używane do logów/UI)
- `agentId?` (opcjonalne; uruchom pod innym identyfikatorem agenta, jeśli dozwolone)
- `model?` (opcjonalne; nadpisuje model pod‑agenta; nieprawidłowe wartości powodują błąd)
- `runTimeoutSeconds?` (domyślnie 0; gdy ustawione, przerywa uruchomienie pod‑agenta po N sekundach)
- `cleanup?` (`delete|keep`, domyślnie `keep`)

Lista dozwolonych:

- `agents.list[].subagents.allowAgents`: lista identyfikatorów agentów dozwolonych przez `agentId` (`["*"]`, aby dopuścić dowolne). Domyślnie: tylko agent żądający.

Wykrywanie:

- Użyj `agents_list`, aby wykryć, które identyfikatory agentów są dozwolone dla `sessions_spawn`.

Zachowanie:

- Uruchamia nową sesję `agent:<agentId>:subagent:<uuid>` z `deliver: false`.
- Pod‑agenci domyślnie mają pełny zestaw narzędzi **z wyjątkiem narzędzi sesji** (konfigurowalne przez `tools.subagents.tools`).
- Pod‑agenci nie mogą wywoływać `sessions_spawn` (brak uruchamiania pod‑agent → pod‑agent).
- Zawsze nieblokujące: natychmiast zwraca `{ status: "accepted", runId, childSessionKey }`.
- Po zakończeniu OpenClaw uruchamia **krok ogłoszenia pod‑agenta** i publikuje wynik w kanale czatu żądającego.
- Odpowiedz dokładnie `ANNOUNCE_SKIP` podczas kroku ogłoszenia, aby pozostać w ciszy.
- Odpowiedzi ogłoszeń są normalizowane do `Status`/`Result`/`Notes`; `Status` pochodzi z wyniku wykonania (nie z tekstu modelu).
- Sesje pod‑agentów są automatycznie archiwizowane po `agents.defaults.subagents.archiveAfterMinutes` (domyślnie: 60).
- Odpowiedzi ogłoszeń zawierają wiersz statystyk (czas wykonania, tokeny, sessionKey/sessionId, ścieżkę transkryptu oraz opcjonalny koszt).

## Widoczność sesji sandbox

Sesje sandbox mogą używać narzędzi sesji, ale domyślnie widzą tylko sesje, które same utworzyły za pomocą `sessions_spawn`.

Konfiguracja:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
