---
summary: "Starsza obsługa iMessage przez imsg (JSON-RPC przez stdio). Dla nowych konfiguracji należy używać BlueBubbles."
read_when:
  - Konfigurowanie obsługi iMessage
  - Debugowanie wysyłania/odbierania iMessage
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:17Z
---

# iMessage (legacy: imsg)

> **Zalecane:** Do nowych konfiguracji iMessage używaj [BlueBubbles](/channels/bluebubbles).
>
> Kanał `imsg` jest starszą integracją zewnętrznego CLI i może zostać usunięty w przyszłej wersji.

Status: starsza integracja zewnętrznego CLI. Gateway uruchamia `imsg rpc` (JSON-RPC przez stdio).

## Szybka konfiguracja (dla początkujących)

1. Upewnij się, że aplikacja Messages jest zalogowana na tym Macu.
2. Zainstaluj `imsg`:
   - `brew install steipete/tap/imsg`
3. Skonfiguruj OpenClaw z `channels.imessage.cliPath` i `channels.imessage.dbPath`.
4. Uruchom gateway i zatwierdź wszystkie monity macOS (Automatyzacja + Pełny dostęp do dysku).

Minimalna konfiguracja:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## Czym to jest

- Kanał iMessage oparty na `imsg` w systemie macOS.
- Deterministyczne routowanie: odpowiedzi zawsze wracają do iMessage.
- DM-y współdzielą główną sesję agenta; grupy są izolowane (`agent:<agentId>:imessage:group:<chat_id>`).
- Jeśli wątek z wieloma uczestnikami dotrze z `is_group=false`, nadal możesz go izolować, `chat_id` używając `channels.imessage.groups` (zobacz „Wątki typu grupowego” poniżej).

## Zapisy konfiguracji

Domyślnie iMessage może zapisywać aktualizacje konfiguracji wyzwalane przez `/config set|unset` (wymaga `commands.config: true`).

Wyłącz za pomocą:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## Wymagania

- macOS z zalogowaną aplikacją Messages.
- Pełny dostęp do dysku dla OpenClaw + `imsg` (dostęp do bazy danych Messages).
- Uprawnienie Automatyzacji podczas wysyłania.
- `channels.imessage.cliPath` może wskazywać dowolne polecenie, które pośredniczy stdin/stdout (na przykład skrypt opakowujący, który łączy się przez SSH z innym Makiem i uruchamia `imsg rpc`).

## Rozwiązywanie problemów z macOS Privacy and Security TCC

Jeśli wysyłanie/odbieranie nie działa (na przykład `imsg rpc` kończy się kodem niezerowym, przekracza limit czasu lub gateway sprawia wrażenie zawieszonego), częstą przyczyną jest monit o uprawnienia macOS, który nigdy nie został zatwierdzony.

macOS przyznaje uprawnienia TCC na aplikację/kontekst procesu. Zatwierdzaj monity w tym samym kontekście, który uruchamia `imsg` (na przykład Terminal/iTerm, sesja LaunchAgent lub proces uruchomiony przez SSH).

Lista kontrolna:

- **Pełny dostęp do dysku**: zezwól na dostęp procesowi uruchamiającemu OpenClaw (oraz wszelkim powłokom/opakowaniom SSH, które wykonują `imsg`). Jest to wymagane do odczytu bazy danych Messages (`chat.db`).
- **Automatyzacja → Messages**: zezwól procesowi uruchamiającemu OpenClaw (i/lub terminalowi) na kontrolowanie **Messages.app** w celu wysyłania wychodzących.
- **Stan zdrowia CLI `imsg`**: sprawdź, czy `imsg` jest zainstalowane i obsługuje RPC (`imsg rpc --help`).

Wskazówka: Jeśli OpenClaw działa bez interfejsu (LaunchAgent/systemd/SSH), monit macOS łatwo przeoczyć. Uruchom jednorazowe polecenie interaktywne w terminalu GUI, aby wymusić monit, a następnie spróbuj ponownie:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

Powiązane uprawnienia folderów macOS (Biurko/Dokumenty/Pobrane): [/platforms/mac/permissions](/platforms/mac/permissions).

## Konfiguracja (szybka ścieżka)

1. Upewnij się, że aplikacja Messages jest zalogowana na tym Macu.
2. Skonfiguruj iMessage i uruchom gateway.

### Dedykowany użytkownik macOS dla bota (dla izolowanej tożsamości)

Jeśli chcesz, aby bot wysyłał z **oddzielnej tożsamości iMessage** (i zachować porządek w osobistych Wiadomościach), użyj dedykowanego Apple ID + dedykowanego użytkownika macOS.

1. Utwórz dedykowane Apple ID (przykład: `my-cool-bot@icloud.com`).
   - Apple może wymagać numeru telefonu do weryfikacji / 2FA.
2. Utwórz użytkownika macOS (przykład: `openclawhome`) i zaloguj się do niego.
3. Otwórz Messages na tym użytkowniku macOS i zaloguj się do iMessage przy użyciu Apple ID bota.
4. Włącz Zdalne logowanie (Ustawienia systemowe → Ogólne → Udostępnianie → Zdalne logowanie).
5. Zainstaluj `imsg`:
   - `brew install steipete/tap/imsg`
6. Skonfiguruj SSH tak, aby `ssh <bot-macos-user>@localhost true` działało bez hasła.
7. Ustaw `channels.imessage.accounts.bot.cliPath` na opakowanie SSH, które uruchamia `imsg` jako użytkownik bota.

Uwaga przy pierwszym uruchomieniu: wysyłanie/odbieranie może wymagać zatwierdzeń GUI (Automatyzacja + Pełny dostęp do dysku) u _użytkownika macOS bota_. Jeśli `imsg rpc` wygląda na zawieszone lub kończy działanie, zaloguj się na tego użytkownika (pomaga Udostępnianie ekranu), uruchom jednorazowo `imsg chats --limit 1` / `imsg send ...`, zatwierdź monity, a następnie spróbuj ponownie. Zobacz [Rozwiązywanie problemów z macOS Privacy and Security TCC](#troubleshooting-macos-privacy-and-security-tcc).

Przykładowe opakowanie (`chmod +x`). Zastąp `<bot-macos-user>` rzeczywistą nazwą użytkownika macOS:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

Przykładowa konfiguracja:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

Dla konfiguracji z jednym kontem użyj opcji płaskich (`channels.imessage.cliPath`, `channels.imessage.dbPath`) zamiast mapy `accounts`.

### Wariant zdalny/SSH (opcjonalny)

Jeśli chcesz używać iMessage na innym Macu, ustaw `channels.imessage.cliPath` na opakowanie, które uruchamia `imsg` na zdalnym hoście macOS przez SSH. OpenClaw potrzebuje tylko stdio.

Przykładowe opakowanie:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**Zdalne załączniki:** Gdy `cliPath` wskazuje zdalny host przez SSH, ścieżki załączników w bazie danych Messages odnoszą się do plików na zdalnej maszynie. OpenClaw może automatycznie pobierać je przez SCP, ustawiając `channels.imessage.remoteHost`:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

Jeśli `remoteHost` nie jest ustawione, OpenClaw próbuje wykryć je automatycznie, parsując polecenie SSH w skrypcie opakowującym. Dla niezawodności zalecana jest jawna konfiguracja.

#### Zdalny Mac przez Tailscale (przykład)

Jeśli Gateway działa na hoście/VM z Linuxem, ale iMessage musi działać na Macu, Tailscale jest najprostszym mostem: Gateway komunikuje się z Makiem przez tailnet, uruchamia `imsg` przez SSH i pobiera załączniki przez SCP.

Architektura:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

Konkretny przykład konfiguracji (nazwa hosta Tailscale):

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

Przykładowe opakowanie (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

Uwagi:

- Upewnij się, że Mac jest zalogowany do Messages, a Zdalne logowanie jest włączone.
- Użyj kluczy SSH, aby `ssh bot@mac-mini.tailnet-1234.ts.net` działało bez monitów.
- `remoteHost` powinno odpowiadać celowi SSH, aby SCP mogło pobierać załączniki.

Obsługa wielu kont: użyj `channels.imessage.accounts` z konfiguracją per konto i opcjonalnym `name`. Zobacz [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) dla wspólnego wzorca. Nie commituj `~/.openclaw/openclaw.json` (często zawiera tokeny).

## Kontrola dostępu (DM-y + grupy)

DM-y:

- Domyślnie: `channels.imessage.dmPolicy = "pairing"`.
- Nieznani nadawcy otrzymują kod parowania; wiadomości są ignorowane do czasu zatwierdzenia (kody wygasają po 1 godzinie).
- Zatwierdzanie przez:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- Parowanie jest domyślną wymianą tokenów dla DM-ów iMessage. Szczegóły: [Parowanie](/channels/pairing)

Grupy:

- `channels.imessage.groupPolicy = open | allowlist | disabled`.
- `channels.imessage.groupAllowFrom` kontroluje, kto może wyzwalać w grupach, gdy ustawione jest `allowlist`.
- Bramka wzmianek używa `agents.list[].groupChat.mentionPatterns` (lub `messages.groupChat.mentionPatterns`), ponieważ iMessage nie ma natywnych metadanych wzmianek.
- Nadpisanie wieloagentowe: ustaw wzorce per agent w `agents.list[].groupChat.mentionPatterns`.

## Jak to działa (zachowanie)

- `imsg` strumieniuje zdarzenia wiadomości; gateway normalizuje je do wspólnej koperty kanału.
- Odpowiedzi zawsze wracają do tego samego identyfikatora czatu lub uchwytu.

## Wątki typu grupowego (`is_group=false`)

Niektóre wątki iMessage mogą mieć wielu uczestników, ale nadal docierać z `is_group=false`, w zależności od tego, jak Messages przechowuje identyfikator czatu.

Jeśli jawnie skonfigurujesz `chat_id` w `channels.imessage.groups`, OpenClaw traktuje ten wątek jako „grupę” dla:

- izolacji sesji (oddzielny klucz sesji `agent:<agentId>:imessage:group:<chat_id>`)
- list dozwolonych dla grup / zachowania bramkowania wzmianek

Przykład:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

Jest to przydatne, gdy chcesz mieć izolowaną osobowość/model dla konkretnego wątku (zobacz [Routing wieloagentowy](/concepts/multi-agent)). W zakresie izolacji systemu plików zobacz [Sandboxing](/gateway/sandboxing).

## Media + limity

- Opcjonalne wczytywanie załączników przez `channels.imessage.includeAttachments`.
- Limit mediów przez `channels.imessage.mediaMaxMb`.

## Limity

- Tekst wychodzący jest dzielony na fragmenty do `channels.imessage.textChunkLimit` (domyślnie 4000).
- Opcjonalne dzielenie po nowych liniach: ustaw `channels.imessage.chunkMode="newline"`, aby dzielić po pustych liniach (granice akapitów) przed dzieleniem według długości.
- Wysyłanie mediów jest ograniczone przez `channels.imessage.mediaMaxMb` (domyślnie 16).

## Adresowanie / cele dostarczania

Preferuj `chat_id` dla stabilnego routowania:

- `chat_id:123` (preferowane)
- `chat_guid:...`
- `chat_identifier:...`
- bezpośrednie uchwyty: `imessage:+1555` / `sms:+1555` / `user@example.com`

Lista czatów:

```
imsg chats --limit 20
```

## Referencja konfiguracji (iMessage)

Pełna konfiguracja: [Konfiguracja](/gateway/configuration)

Opcje dostawcy:

- `channels.imessage.enabled`: włącz/wyłącz uruchamianie kanału.
- `channels.imessage.cliPath`: ścieżka do `imsg`.
- `channels.imessage.dbPath`: ścieżka bazy danych Messages.
- `channels.imessage.remoteHost`: host SSH dla transferu załączników przez SCP, gdy `cliPath` wskazuje zdalnego Maca (np. `user@gateway-host`). Automatycznie wykrywane z opakowania SSH, jeśli nie ustawione.
- `channels.imessage.service`: `imessage | sms | auto`.
- `channels.imessage.region`: region SMS.
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (domyślnie: parowanie).
- `channels.imessage.allowFrom`: lista dozwolonych DM-ów (uchwyty, e-maile, numery E.164 lub `chat_id:*`). `open` wymaga `"*"`. iMessage nie ma nazw użytkowników; używaj uchwytów lub celów czatu.
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (domyślnie: lista dozwolonych).
- `channels.imessage.groupAllowFrom`: lista dozwolonych nadawców w grupach.
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: maksymalna liczba wiadomości grupowych do włączenia jako kontekst (0 wyłącza).
- `channels.imessage.dmHistoryLimit`: limit historii DM w turach użytkownika. Nadpisania per użytkownik: `channels.imessage.dms["<handle>"].historyLimit`.
- `channels.imessage.groups`: domyślne ustawienia per grupa + lista dozwolonych (użyj `"*"` dla globalnych domyślnych).
- `channels.imessage.includeAttachments`: wczytywanie załączników do kontekstu.
- `channels.imessage.mediaMaxMb`: limit mediów przychodzących/wychodzących (MB).
- `channels.imessage.textChunkLimit`: rozmiar fragmentu wychodzącego (znaki).
- `channels.imessage.chunkMode`: `length` (domyślne) lub `newline` do dzielenia po pustych liniach (granice akapitów) przed dzieleniem według długości.

Powiązane opcje globalne:

- `agents.list[].groupChat.mentionPatterns` (lub `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
