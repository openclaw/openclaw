---
summary: "Obsługa Signal przez signal-cli (JSON-RPC + SSE), konfiguracja i model numeru"
read_when:
  - Konfigurowanie obsługi Signal
  - Debugowanie wysyłania/odbierania w Signal
title: "Signal"
---

# Signal (signal-cli)

Status: integracja zewnętrznego CLI. Gateway komunikuje się z `signal-cli` przez HTTP JSON-RPC + SSE.

## Szybka konfiguracja (dla początkujących)

1. Użyj **oddzielnego numeru Signal** dla bota (zalecane).
2. Zainstaluj `signal-cli` (wymagana Java).
3. Sparuj urządzenie bota i uruchom demona:
   - `signal-cli link -n "OpenClaw"`
4. Skonfiguruj OpenClaw i uruchom gateway.

Minimalna konfiguracja:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

## Czym to jest

- Kanał Signal przez `signal-cli` (nie wbudowana libsignal).
- Deterministyczne routowanie: odpowiedzi zawsze wracają do Signal.
- DM-y współdzielą główną sesję agenta; grupy są izolowane (`agent:<agentId>:signal:group:<groupId>`).

## Zapisy konfiguracji

Domyślnie Signal ma prawo zapisywać aktualizacje konfiguracji wyzwalane przez `/config set|unset` (wymaga `commands.config: true`).

Wyłącz za pomocą:

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## Model numeru (ważne)

- Gateway łączy się z **urządzeniem Signal** (konto `signal-cli`).
- Jeśli uruchamiasz bota na **swoim osobistym koncie Signal**, będzie on ignorował Twoje własne wiadomości (ochrona przed pętlą).
- Aby uzyskać scenariusz „piszę do bota i on odpowiada”, użyj **oddzielnego numeru bota**.

## Konfiguracja (szybka ścieżka)

1. Zainstaluj `signal-cli` (wymagana Java).
2. Sparuj konto bota:
   - `signal-cli link -n "OpenClaw"`, a następnie zeskanuj kod QR w Signal.
3. Skonfiguruj Signal i uruchom gateway.

Przykład:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

Obsługa wielu kont: użyj `channels.signal.accounts` z konfiguracją per konto oraz opcjonalnym `name`. Zobacz [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) dla wspólnego wzorca.

## Tryb zewnętrznego demona (httpUrl)

Jeśli chcesz samodzielnie zarządzać `signal-cli` (wolne zimne starty JVM, inicjalizacja kontenera lub współdzielone CPU), uruchom demona osobno i wskaż go w OpenClaw:

```json5
{
  channels: {
    signal: {
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
    },
  },
}
```

To pomija automatyczne uruchamianie oraz oczekiwanie na start wewnątrz OpenClaw. Przy wolnych startach podczas auto-spawn ustaw `channels.signal.startupTimeoutMs`.

## Kontrola dostępu (DM-y + grupy)

DM-y:

- Domyślnie: `channels.signal.dmPolicy = "pairing"`.
- Nieznani nadawcy otrzymują kod parowania; wiadomości są ignorowane do momentu zatwierdzenia (kody wygasają po 1 godzinie).
- Zatwierdzanie przez:
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- Parowanie jest domyślną wymianą tokenów dla DM-ów Signal. Szczegóły: [Pairing](/channels/pairing)
- Nadawcy tylko z UUID (z `sourceUuid`) są zapisywani jako `uuid:<id>` w `channels.signal.allowFrom`.

Grupy:

- `channels.signal.groupPolicy = open | allowlist | disabled`.
- `channels.signal.groupAllowFrom` kontroluje, kto może wyzwalać w grupach, gdy ustawione jest `allowlist`.

## Jak to działa (zachowanie)

- `signal-cli` działa jako demon; gateway odczytuje zdarzenia przez SSE.
- Wiadomości przychodzące są normalizowane do wspólnej koperty kanału.
- Odpowiedzi zawsze wracają do tego samego numeru lub grupy.

## Media i limity

- Tekst wychodzący jest dzielony na fragmenty do `channels.signal.textChunkLimit` (domyślnie 4000).
- Opcjonalne dzielenie po nowych liniach: ustaw `channels.signal.chunkMode="newline"`, aby dzielić po pustych liniach (granice akapitów) przed dzieleniem według długości.
- Obsługiwane są załączniki (base64 pobierane z `signal-cli`).
- Domyślny limit mediów: `channels.signal.mediaMaxMb` (domyślnie 8).
- Użyj `channels.signal.ignoreAttachments`, aby pominąć pobieranie mediów.
- Kontekst historii grup używa `channels.signal.historyLimit` (lub `channels.signal.accounts.*.historyLimit`), z przejściem awaryjnym do `messages.groupChat.historyLimit`. Ustaw `0`, aby wyłączyć (domyślnie 50).

## Pisanie + potwierdzenia odczytu

- **Wskaźniki pisania**: OpenClaw wysyła sygnały pisania przez `signal-cli sendTyping` i odświeża je podczas generowania odpowiedzi.
- **Potwierdzenia odczytu**: gdy `channels.signal.sendReadReceipts` jest true, OpenClaw przekazuje potwierdzenia odczytu dla dozwolonych DM-ów.
- Signal-cli nie udostępnia potwierdzeń odczytu dla grup.

## Reakcje (narzędzie wiadomości)

- Użyj `message action=react` z `channel=signal`.
- Cele: nadawca E.164 lub UUID (użyj `uuid:<id>` z wyjścia parowania; goły UUID też działa).
- `messageId` to znacznik czasu Signal dla wiadomości, na którą reagujesz.
- Reakcje w grupach wymagają `targetAuthor` lub `targetAuthorUuid`.

Przykłady:

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

Konfiguracja:

- `channels.signal.actions.reactions`: włącz/wyłącz akcje reakcji (domyślnie true).
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`.
  - `off`/`ack` wyłącza reakcje agenta (narzędzie wiadomości `react` zgłosi błąd).
  - `minimal`/`extensive` włącza reakcje agenta i ustawia poziom wskazówek.
- Nadpisania per konto: `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`.

## Cele dostarczania (CLI/cron)

- DM-y: `signal:+15551234567` (lub zwykły E.164).
- DM-y UUID: `uuid:<id>` (lub goły UUID).
- Grupy: `signal:group:<groupId>`.
- Nazwy użytkowników: `username:<name>` (jeśli obsługiwane przez Twoje konto Signal).

## Rozwiązywanie problemów

Najpierw uruchom tę drabinę:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Następnie, w razie potrzeby, potwierdź stan parowania DM-ów:

```bash
openclaw pairing list signal
```

Częste awarie:

- Demon osiągalny, ale brak odpowiedzi: zweryfikuj ustawienia konta/demona (`httpUrl`, `account`) oraz tryb odbioru.
- DM-y ignorowane: nadawca oczekuje na zatwierdzenie parowania.
- Wiadomości grupowe ignorowane: bramkowanie nadawcy/wzmianek w grupach blokuje dostarczenie.

Schemat triage: [/channels/troubleshooting](/channels/troubleshooting).

## Referencja konfiguracji (Signal)

Pełna konfiguracja: [Configuration](/gateway/configuration)

Opcje dostawcy:

- `channels.signal.enabled`: włącz/wyłącz uruchamianie kanału.
- `channels.signal.account`: E.164 dla konta bota.
- `channels.signal.cliPath`: ścieżka do `signal-cli`.
- `channels.signal.httpUrl`: pełny URL demona (nadpisuje host/port).
- `channels.signal.httpHost`, `channels.signal.httpPort`: powiązanie demona (domyślnie 127.0.0.1:8080).
- `channels.signal.autoStart`: automatyczne uruchamianie demona (domyślnie true, jeśli `httpUrl` nieustawione).
- `channels.signal.startupTimeoutMs`: limit czasu oczekiwania na start w ms (limit 120000).
- `channels.signal.receiveMode`: `on-start | manual`.
- `channels.signal.ignoreAttachments`: pomiń pobieranie załączników.
- `channels.signal.ignoreStories`: ignoruj relacje z demona.
- `channels.signal.sendReadReceipts`: przekazuj potwierdzenia odczytu.
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled` (domyślnie: parowanie).
- `channels.signal.allowFrom`: lista dozwolonych DM-ów (E.164 lub `uuid:<id>`). `open` wymaga `"*"`. Signal nie ma nazw użytkowników; użyj identyfikatorów telefonu/UUID.
- `channels.signal.groupPolicy`: `open | allowlist | disabled` (domyślnie: lista dozwolonych).
- `channels.signal.groupAllowFrom`: lista dozwolonych nadawców w grupach.
- `channels.signal.historyLimit`: maksymalna liczba wiadomości grupowych do uwzględnienia jako kontekst (0 wyłącza).
- `channels.signal.dmHistoryLimit`: limit historii DM-ów w turach użytkownika. Nadpisania per użytkownik: `channels.signal.dms["<phone_or_uuid>"].historyLimit`.
- `channels.signal.textChunkLimit`: rozmiar fragmentów wychodzących (znaki).
- `channels.signal.chunkMode`: `length` (domyślne) lub `newline`, aby dzielić po pustych liniach (granice akapitów) przed dzieleniem według długości.
- `channels.signal.mediaMaxMb`: limit mediów przychodzących/wychodzących (MB).

Powiązane opcje globalne:

- `agents.list[].groupChat.mentionPatterns` (Signal nie obsługuje natywnych wzmianek).
- `messages.groupChat.mentionPatterns` (globalny fallback).
- `messages.responsePrefix`.
