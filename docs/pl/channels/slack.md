---
summary: "Konfiguracja Slacka w trybie gniazda lub webhooka HTTP"
read_when: "Konfigurowanie Slacka lub debugowanie trybu gniazda/HTTP w Slacku"
title: "Slack"
---

# Slack

## Tryb gniazda (domyślny)

### Szybka konfiguracja (dla początkujących)

1. Utwórz aplikację Slack i włącz **Socket Mode**.
2. Utwórz **App Token** (`xapp-...`) oraz **Bot Token** (`xoxb-...`).
3. Ustaw tokeny dla OpenClaw i uruchom Gateway.

Minimalna konfiguracja:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Konfiguracja

1. Utwórz aplikację Slack (From scratch) na stronie [https://api.slack.com/apps](https://api.slack.com/apps).
2. **Socket Mode** → włącz. Następnie przejdź do **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** z zakresem `connections:write`. Skopiuj **App Token** (`xapp-...`).
3. **OAuth & Permissions** → dodaj zakresy tokena bota (użyj manifestu poniżej). Kliknij **Install to Workspace**. Skopiuj **Bot User OAuth Token** (`xoxb-...`).
4. Opcjonalnie: **OAuth & Permissions** → dodaj **User Token Scopes** (zobacz listę tylko do odczytu poniżej). Zainstaluj ponownie aplikację i skopiuj **User OAuth Token** (`xoxp-...`).
5. **Event Subscriptions** → włącz zdarzenia i zasubskrybuj:
   - `message.*` (obejmuje edycje/usunięcia/rozgłaszanie wątków)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. Zaproś bota do kanałów, które ma czytać.
7. Slash Commands → utwórz `/openclaw`, jeśli używasz `channels.slack.slashCommand`. Jeśli włączysz polecenia natywne, dodaj jedno polecenie slash na każde wbudowane polecenie (te same nazwy co `/help`). Natywne polecenia są domyślnie wyłączone dla Slacka, chyba że ustawisz `channels.slack.commands.native: true` (globalne `commands.native` ma wartość `"auto"`, co pozostawia Slack wyłączony).
8. App Home → włącz **Messages Tab**, aby użytkownicy mogli wysyłać DM-y do bota.

Użyj manifestu poniżej, aby zakresy i zdarzenia pozostały zsynchronizowane.

Obsługa wielu kont: użyj `channels.slack.accounts` z tokenami per konto oraz opcjonalnie `name`. Zobacz [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts), aby poznać wspólny wzorzec.

### Konfiguracja OpenClaw (tryb gniazda)

Ustaw tokeny przez zmienne środowiskowe (zalecane):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

Lub w konfiguracji:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Token użytkownika (opcjonalny)

OpenClaw może używać tokena użytkownika Slacka (`xoxp-...`) do operacji odczytu (historia,
przypięcia, reakcje, emoji, informacje o członkach). Domyślnie pozostaje on tylko do odczytu: odczyty
preferują token użytkownika, gdy jest dostępny, a zapisy nadal używają tokena bota, chyba że
jawnie się na to zdecydujesz. Nawet przy `userTokenReadOnly: false` token bota pozostaje
preferowany do zapisów, gdy jest dostępny.

Tokeny użytkownika konfiguruje się w pliku konfiguracyjnym (brak wsparcia dla zmiennych środowiskowych). Dla
wielu kont ustaw `channels.slack.accounts.<id>.userToken`.

Przykład z tokenami: bot + app + user:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

Przykład z jawnie ustawionym userTokenReadOnly (zezwolenie na zapisy tokenem użytkownika):

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### Użycie tokenów

- Operacje odczytu (historia, lista reakcji, lista przypięć, lista emoji, informacje o członkach,
  wyszukiwanie) preferują token użytkownika, jeśli jest skonfigurowany, w przeciwnym razie token bota.
- Operacje zapisu (wysyłanie/edycja/usuwanie wiadomości, dodawanie/usuwanie reakcji, przypinanie/odpinanie,
  przesyłanie plików) domyślnie używają tokena bota. Jeśli `userTokenReadOnly: false` i
  token bota nie jest dostępny, OpenClaw przełącza się na token użytkownika.

### Kontekst historii

- `channels.slack.historyLimit` (lub `channels.slack.accounts.*.historyLimit`) kontroluje, ile ostatnich wiadomości z kanału/grupy jest opakowywanych w prompt.
- W razie braku używa `messages.groupChat.historyLimit`. Ustaw `0`, aby wyłączyć (domyślnie 50).

## Tryb HTTP (Events API)

Użyj trybu webhooka HTTP, gdy Twój Gateway jest osiągalny dla Slacka przez HTTPS (typowe dla wdrożeń serwerowych).
Tryb HTTP korzysta z Events API + Interactivity + Slash Commands ze współdzielonym adresem URL żądań.

### Konfiguracja (tryb HTTP)

1. Utwórz aplikację Slack i **wyłącz Socket Mode** (opcjonalne, jeśli używasz tylko HTTP).
2. **Basic Information** → skopiuj **Signing Secret**.
3. **OAuth & Permissions** → zainstaluj aplikację i skopiuj **Bot User OAuth Token** (`xoxb-...`).
4. **Event Subscriptions** → włącz zdarzenia i ustaw **Request URL** na ścieżkę webhooka Gateway (domyślnie `/slack/events`).
5. **Interactivity & Shortcuts** → włącz i ustaw ten sam **Request URL**.
6. **Slash Commands** → ustaw ten sam **Request URL** dla poleceń.

Przykładowy adres URL żądania:
`https://gateway-host/slack/events`

### Konfiguracja OpenClaw (minimalna)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

Tryb HTTP dla wielu kont: ustaw `channels.slack.accounts.<id>.mode = "http"` i zapewnij unikalny
`webhookPath` dla każdego konta, aby każda aplikacja Slack mogła wskazywać własny adres URL.

### Manifest (opcjonalnie)

Użyj tego manifestu aplikacji Slack, aby szybko utworzyć aplikację (w razie potrzeby dostosuj nazwę/polecenie). Dołącz
zakresy użytkownika, jeśli planujesz skonfigurować token użytkownika.

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

Jeśli włączysz polecenia natywne, dodaj jeden wpis `slash_commands` na każde polecenie, które chcesz udostępnić (zgodnie z listą `/help`). Nadpisz przez `channels.slack.commands.native`.

## Zakresy (aktualne vs opcjonalne)

API Conversations Slacka jest typowane zakresem: potrzebujesz tylko zakresów dla
typów konwersacji, z których faktycznie korzystasz (channels, groups, im, mpim). Zobacz
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) – przegląd.

### Zakresy tokenów bota (wymagane)

- `chat:write` (wysyłanie/aktualizacja/usuwanie wiadomości przez `chat.postMessage`)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (otwieranie DM-ów przez `conversations.open` dla DM-ów użytkowników)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (wyszukiwanie użytkowników)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (przesyłanie przez `files.uploadV2`)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### Zakresy tokena użytkownika (opcjonalne, domyślnie tylko do odczytu)

Dodaj je w **User Token Scopes**, jeśli konfigurujesz `channels.slack.userToken`.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### Dziś niepotrzebne (ale prawdopodobna przyszłość)

- `mpim:write` (tylko jeśli dodamy otwieranie DM-ów grupowych/rozpoczynanie DM przez `conversations.open`)
- `groups:write` (tylko jeśli dodamy zarządzanie kanałami prywatnymi: tworzenie/zmiana nazwy/zapraszanie/archiwizacja)
- `chat:write.public` (tylko jeśli chcemy publikować w kanałach, w których bot nie jest)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (tylko jeśli potrzebujemy pól e-mail z `users.info`)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (tylko jeśli zaczniemy listować/czytać metadane plików)

## Konfiguracja

Slack używa wyłącznie trybu gniazda (brak serwera webhooków HTTP). Podaj oba tokeny:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

Tokeny można również przekazać przez zmienne środowiskowe:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Reakcje potwierdzeń są kontrolowane globalnie przez `messages.ackReaction` +
`messages.ackReactionScope`. Użyj `messages.removeAckAfterReply`, aby wyczyścić
reakcję potwierdzenia po odpowiedzi bota.

## Limity

- Wychodzący tekst jest dzielony na fragmenty do `channels.slack.textChunkLimit` (domyślnie 4000).
- Opcjonalne dzielenie po nowych liniach: ustaw `channels.slack.chunkMode="newline"`, aby dzielić po pustych liniach (granice akapitów) przed dzieleniem wg długości.
- Przesyłanie mediów jest ograniczone przez `channels.slack.mediaMaxMb` (domyślnie 20).

## Wątkowanie odpowiedzi

Domyślnie OpenClaw odpowiada w głównym kanale. Użyj `channels.slack.replyToMode`, aby kontrolować automatyczne wątkowanie:

| Tryb    | Zachowanie                                                                                                                                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | **Domyślny.** Odpowiedź w głównym kanale. Wątek tylko wtedy, gdy wiadomość wyzwalająca była już w wątku.                                                                            |
| `first` | Pierwsza odpowiedź trafia do wątku (pod wiadomością wyzwalającą), kolejne odpowiedzi do głównego kanału. Przydatne do zachowania kontekstu przy ograniczaniu bałaganu w wątkach. |
| `all`   | Wszystkie odpowiedzi trafiają do wątku. Utrzymuje rozmowy w jednym miejscu, ale może zmniejszać widoczność.                                                                                         |

Tryb dotyczy zarówno automatycznych odpowiedzi, jak i wywołań narzędzi agenta (`slack sendMessage`).

### Wątkowanie per typ czatu

Możesz skonfigurować różne zachowania wątkowania dla poszczególnych typów czatu, ustawiając `channels.slack.replyToModeByChatType`:

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

Obsługiwane typy czatu:

- `direct`: DM-y 1:1 (Slack `im`)
- `group`: DM-y grupowe / MPIM (Slack `mpim`)
- `channel`: standardowe kanały (publiczne/prywatne)

Priorytet:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. Domyślne ustawienie dostawcy (`off`)

Starsze `channels.slack.dm.replyToMode` jest nadal akceptowane jako zapasowe dla `direct`, gdy nie ustawiono nadpisania per typ czatu.

Przykłady:

Wątkuj tylko DM-y:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

Wątkuj DM-y grupowe, ale pozostaw kanały w głównym widoku:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

Uczyń kanały wątkami, pozostaw DM-y w głównym widoku:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### Ręczne tagi wątkowania

Dla precyzyjnej kontroli użyj tych tagów w odpowiedziach agenta:

- `[[reply_to_current]]` — odpowiedź na wiadomość wyzwalającą (rozpocznij/kontynuuj wątek).
- `[[reply_to:<id>]]` — odpowiedź na konkretny identyfikator wiadomości.

## Sesje + routowanie

- DM-y współdzielą sesję `main` (jak WhatsApp/Telegram).
- Kanały mapują się na sesje `agent:<agentId>:slack:channel:<channelId>`.
- Polecenia slash używają sesji `agent:<agentId>:slack:slash:<userId>` (prefiks konfigurowalny przez `channels.slack.slashCommand.sessionPrefix`).
- Jeśli Slack nie dostarcza `channel_type`, OpenClaw wnioskuje go z prefiksu identyfikatora kanału (`D`, `C`, `G`) i domyślnie używa `channel`, aby zachować stabilność kluczy sesji.
- Rejestracja poleceń natywnych używa `commands.native` (globalna wartość domyślna `"auto"` → Slack wyłączony) i może być nadpisana per obszar roboczy przez `channels.slack.commands.native`. Polecenia tekstowe wymagają samodzielnych wiadomości `/...` i mogą być wyłączone przez `commands.text: false`. Polecenia slash Slacka są zarządzane w aplikacji Slack i nie są usuwane automatycznie. Użyj `commands.useAccessGroups: false`, aby pominąć sprawdzanie grup dostępu dla poleceń.
- Pełna lista poleceń + konfiguracja: [Polecenia slash](/tools/slash-commands)

## Bezpieczeństwo DM (parowanie)

- Domyślnie: `channels.slack.dm.policy="pairing"` — nieznani nadawcy DM otrzymują kod parowania (wygasa po 1 godzinie).
- Zatwierdzanie przez: `openclaw pairing approve slack <code>`.
- Aby zezwolić wszystkim: ustaw `channels.slack.dm.policy="open"` i `channels.slack.dm.allowFrom=["*"]`.
- `channels.slack.dm.allowFrom` akceptuje identyfikatory użytkowników, @handle lub adresy e-mail (rozwiązywane przy starcie, gdy tokeny na to pozwalają). Kreator akceptuje nazwy użytkowników i rozwiązuje je do identyfikatorów podczas konfiguracji, gdy tokeny na to pozwalają.

## Polityka grup

- `channels.slack.groupPolicy` kontroluje obsługę kanałów (`open|disabled|allowlist`).
- `allowlist` wymaga, aby kanały były wymienione w `channels.slack.channels`.
- Jeśli ustawisz tylko `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` i nigdy nie utworzysz sekcji `channels.slack`,
  środowisko uruchomieniowe domyślnie ustawia `groupPolicy` na `open`. Dodaj `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy` lub listę dozwolonych kanałów, aby to zablokować.
- Kreator konfiguracji akceptuje nazwy `#channel` i w miarę możliwości rozwiązuje je do identyfikatorów
  (publiczne + prywatne); jeśli istnieje wiele dopasowań, preferuje aktywny kanał.
- Przy starcie OpenClaw rozwiązuje nazwy kanałów/użytkowników w listach dozwolonych do identyfikatorów (gdy tokeny na to pozwalają)
  i loguje mapowanie; nierozwiązane wpisy są zachowywane w postaci wprowadzonej.
- Aby zezwolić na **brak kanałów**, ustaw `channels.slack.groupPolicy: "disabled"` (lub pozostaw pustą listę dozwolonych).

Opcje kanału (`channels.slack.channels.<id>` lub `channels.slack.channels.<name>`):

- `allow`: zezwól/zabroń kanału, gdy `groupPolicy="allowlist"`.
- `requireMention`: bramkowanie wzmianek dla kanału.
- `tools`: opcjonalne nadpisania polityk narzędzi per kanał (`allow`/`deny`/`alsoAllow`).
- `toolsBySender`: opcjonalne nadpisania polityk narzędzi per nadawca w obrębie kanału (klucze to identyfikatory nadawców/@handle/adresy e-mail; obsługiwany symbol wieloznaczny `"*"`).
- `allowBots`: zezwól na wiadomości autorstwa bota w tym kanale (domyślnie: false).
- `users`: opcjonalna lista dozwolonych użytkowników per kanał.
- `skills`: filtr Skills (brak = wszystkie Skills, puste = brak).
- `systemPrompt`: dodatkowy prompt systemowy dla kanału (łączony z tematem/celem).
- `enabled`: ustaw `false`, aby wyłączyć kanał.

## Cele dostarczania

Używaj ich przy wysyłkach cron/CLI:

- `user:<id>` dla DM-ów
- `channel:<id>` dla kanałów

## Akcje narzędzi

Akcje narzędzi Slacka można bramkować za pomocą `channels.slack.actions.*`:

| Grupa akcji | Domyślnie | Uwagi                            |
| ----------- | --------- | -------------------------------- |
| reactions   | włączone  | Reakcje + lista reakcji          |
| messages    | włączone  | Odczyt/wysyłanie/edycja/usuwanie |
| pins        | włączone  | Przypinanie/odpinanie/lista      |
| memberInfo  | włączone  | Informacje o członkach           |
| emojiList   | włączone  | Lista niestandardowych emoji     |

## Uwagi dotyczące bezpieczeństwa

- Zapisy domyślnie używają tokena bota, aby działania zmieniające stan pozostały
  w zakresie uprawnień i tożsamości bota aplikacji.
- Ustawienie `userTokenReadOnly: false` pozwala używać tokena użytkownika do operacji zapisu,
  gdy token bota jest niedostępny, co oznacza, że działania są wykonywane z
  uprawnieniami użytkownika instalującego. Traktuj token użytkownika jako
  wysoce uprzywilejowany i utrzymuj ścisłe bramkowanie akcji oraz listy dozwolonych.
- Jeśli włączysz zapisy tokenem użytkownika, upewnij się, że token użytkownika zawiera
  oczekiwane zakresy zapisu (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`), w przeciwnym razie operacje się nie powiodą.

## Rozwiązywanie problemów

Najpierw uruchom tę drabinę:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Następnie, w razie potrzeby, potwierdź stan parowania DM:

```bash
openclaw pairing list slack
```

Częste awarie:

- Połączenie jest nawiązane, ale brak odpowiedzi w kanałach: kanał zablokowany przez `groupPolicy` lub nie znajduje się na liście dozwolonych `channels.slack.channels`.
- DM-y ignorowane: nadawca niezatwierdzony, gdy `channels.slack.dm.policy="pairing"`.
- Błędy API (`missing_scope`, `not_in_channel`, błędy uwierzytelniania): tokeny bota/aplikacji lub zakresy Slacka są niekompletne.

Schemat triage: [/channels/troubleshooting](/channels/troubleshooting).

## Uwagi

- Bramkowanie wzmianek jest kontrolowane przez `channels.slack.channels` (ustaw `requireMention` na `true`); `agents.list[].groupChat.mentionPatterns` (lub `messages.groupChat.mentionPatterns`) również liczą się jako wzmianki.
- Nadpisanie wieloagentowe: ustaw wzorce per agent w `agents.list[].groupChat.mentionPatterns`.
- Powiadomienia o reakcjach podążają za `channels.slack.reactionNotifications` (użyj `reactionAllowlist` z trybem `allowlist`).
- Wiadomości autorstwa bota są domyślnie ignorowane; włącz przez `channels.slack.allowBots` lub `channels.slack.channels.<id>.allowBots`.
- Ostrzeżenie: jeśli zezwolisz na odpowiedzi do innych botów (`channels.slack.allowBots=true` lub `channels.slack.channels.<id>.allowBots=true`), zapobiegaj pętlom odpowiedzi bot–bot za pomocą list dozwolonych `requireMention`, `channels.slack.channels.<id>.users` i/lub wyraźnych barier w `AGENTS.md` oraz `SOUL.md`.
- Dla narzędzia Slack semantyka usuwania reakcji jest opisana w [/tools/reactions](/tools/reactions).
- Załączniki są pobierane do magazynu multimediów, gdy jest to dozwolone i mieszczą się w limicie rozmiaru.
