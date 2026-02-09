---
summary: "Zachowanie czatów grupowych na różnych platformach (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Zmienianie zachowania czatów grupowych lub kontroli wzmianek
title: "Grupy"
---

# Grupy

OpenClaw traktuje czaty grupowe spójnie na różnych platformach: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams.

## Wprowadzenie dla początkujących (2 minuty)

OpenClaw „żyje” na Twoich własnych kontach komunikatorów. Nie ma osobnego użytkownika-bota WhatsApp.
Jeśli **Ty** jesteś w grupie, OpenClaw może widzieć tę grupę i tam odpowiadać.

Zachowanie domyślne:

- Grupy są ograniczone (`groupPolicy: "allowlist"`).
- Odpowiedzi wymagają wzmianki, chyba że jawnie wyłączysz kontrolę wzmianek.

Tłumaczenie: autoryzowani nadawcy mogą wywołać OpenClaw, wspominając go.

> TL;DR
>
> - **Dostęp do DM-ów** jest kontrolowany przez `*.allowFrom`.
> - **Dostęp do grup** jest kontrolowany przez `*.groupPolicy` + listy dozwolonych (`*.groups`, `*.groupAllowFrom`).
> - **Wyzwalanie odpowiedzi** jest kontrolowane przez kontrolę wzmianek (`requireMention`, `/activation`).

Szybki przebieg (co dzieje się z wiadomością grupową):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Przepływ wiadomości grupowej](/images/groups-flow.svg)

Jeśli chcesz...

| Cel                                                                         | Co ustawić                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Zezwolić na wszystkie grupy, ale odpowiadać tylko na @wzmianki | `groups: { "*": { requireMention: true } }`                               |
| Wyłączyć wszystkie odpowiedzi w grupach                                     | `groupPolicy: "disabled"`                                                 |
| Tylko określone grupy                                                       | `groups: { "<group-id>": { ... } }` (bez klucza `"*"`) |
| Tylko Ty możesz wyzwalać w grupach                                          | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]`                |

## Klucze sesji

- Sesje grupowe używają kluczy sesji `agent:<agentId>:<channel>:group:<id>` (pokoje/kanały używają `agent:<agentId>:<channel>:channel:<id>`).
- Tematy forum Telegrama dodają `:topic:<threadId>` do identyfikatora grupy, aby każdy temat miał własną sesję.
- Czaty bezpośrednie używają sesji głównej (lub per-nadawca, jeśli skonfigurowano).
- Sygnały heartbeat są pomijane dla sesji grupowych.

## Wzorzec: osobiste DM-y + publiczne grupy (jeden agent)

Tak — to działa dobrze, jeśli Twój ruch „osobisty” to **DM-y**, a „publiczny” to **grupy**.

Dlaczego: w trybie jednego agenta DM-y zwykle trafiają do **głównego** klucza sesji (`agent:main:main`), podczas gdy grupy zawsze używają **nie-głównych** kluczy sesji (`agent:main:<channel>:group:<id>`). Jeśli włączysz sandboxing za pomocą `mode: "non-main"`, te sesje grupowe działają w Dockerze, a Twoja główna sesja DM pozostaje na hoście.

Daje to jeden „mózg” agenta (wspólny obszar roboczy + pamięć), ale dwie postawy wykonania:

- **DM-y**: pełne narzędzia (host)
- **Grupy**: sandbox + ograniczone narzędzia (Docker)

> Jeśli potrzebujesz naprawdę oddzielnych obszarów roboczych/person („osobiste” i „publiczne” nigdy nie mogą się mieszać), użyj drugiego agenta + powiązań. Zobacz [Multi-Agent Routing](/concepts/multi-agent).

Przykład (DM-y na hoście, grupy w sandboxie + narzędzia tylko do wiadomości):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

Chcesz „grupy widzą tylko folder X” zamiast „brak dostępu do hosta”? Zachowaj `workspaceAccess: "none"` i zamontuj do sandboxu tylko ścieżki z listy dozwolonych:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

Powiązane:

- Klucze konfiguracji i ustawienia domyślne: [Konfiguracja Gateway](/gateway/configuration#agentsdefaultssandbox)
- Debugowanie, dlaczego narzędzie jest zablokowane: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Szczegóły montowań bind: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## Etykiety wyświetlania

- Etykiety interfejsu używają `displayName`, gdy są dostępne, formatowane jako `<channel>:<token>`.
- `#room` jest zarezerwowane dla pokoi/kanałów; czaty grupowe używają `g-<slug>` (małe litery, spacje -> `-`, zachowaj `#@+._-`).

## Polityka grup

Kontroluj, jak wiadomości grupowe/pokojowe są obsługiwane per kanał:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| Polityka      | Zachowanie                                                                               |
| ------------- | ---------------------------------------------------------------------------------------- |
| `"open"`      | Grupy omijają listy dozwolonych; kontrola wzmianek nadal obowiązuje.     |
| `"disabled"`  | Całkowicie blokuje wszystkie wiadomości grupowe.                         |
| `"allowlist"` | Zezwala tylko na grupy/pokoje zgodne z skonfigurowaną listą dozwolonych. |

Uwagi:

- `groupPolicy` jest niezależne od kontroli wzmianek (która wymaga @wzmianek).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: użyj `groupAllowFrom` (fallback: jawne `allowFrom`).
- Discord: lista dozwolonych używa `channels.discord.guilds.<id>.channels`.
- Slack: lista dozwolonych używa `channels.slack.channels`.
- Matrix: lista dozwolonych używa `channels.matrix.groups` (identyfikatory pokoi, aliasy lub nazwy). Użyj `channels.matrix.groupAllowFrom`, aby ograniczyć nadawców; obsługiwane są także listy dozwolonych per-pokój `users`.
- Grupowe DM-y są kontrolowane osobno (`channels.discord.dm.*`, `channels.slack.dm.*`).
- Lista dozwolonych Telegrama może dopasowywać identyfikatory użytkowników (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) lub nazwy użytkowników (`"@alice"` lub `"alice"`); prefiksy są nieczułe na wielkość liter.
- Domyślnie obowiązuje `groupPolicy: "allowlist"`; jeśli lista dozwolonych grup jest pusta, wiadomości grupowe są blokowane.

Szybki model mentalny (kolejność ewaluacji dla wiadomości grupowych):

1. `groupPolicy` (open/disabled/allowlist)
2. listy dozwolonych grup (`*.groups`, `*.groupAllowFrom`, lista dozwolonych specyficzna dla kanału)
3. kontrola wzmianek (`requireMention`, `/activation`)

## Kontrola wzmianek (domyślnie)

Wiadomości grupowe wymagają wzmianki, chyba że zostanie to nadpisane per grupa. Domyślne wartości znajdują się per podsystem pod `*.groups."*"`.

Odpowiadanie na wiadomość bota liczy się jako domyślna wzmianka (gdy kanał obsługuje metadane odpowiedzi). Dotyczy to Telegrama, WhatsApp, Slacka, Discorda oraz Microsoft Teams.

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

Uwagi:

- `mentionPatterns` to wyrażenia regularne nieczułe na wielkość liter.
- Powierzchnie zawierające wyraźne wzmianki nadal są pozytywne; wzory są spadkiem.
- Nadpisanie per-agent: `agents.list[].groupChat.mentionPatterns` (przydatne, gdy wiele agentów współdzieli grupę).
- Kontrola wzmianek jest egzekwowana tylko wtedy, gdy wykrywanie wzmianek jest możliwe (natywne wzmianki lub skonfigurowane `mentionPatterns`).
- Domyślne ustawienia Discorda znajdują się w `channels.discord.guilds."*"` (z możliwością nadpisania per gildia/kanał).
- Kontekst historii grupy jest opakowany jednolicie we wszystkich kanałach i jest **tylko-oczekujący** (wiadomości pominięte z powodu kontroli wzmianek); użyj `messages.groupChat.historyLimit` dla globalnej wartości domyślnej oraz `channels.<channel>.historyLimit` (lub `channels.<channel>.accounts.*.historyLimit`) dla nadpisań. Ustaw `0`, aby wyłączyć.

## Ograniczenia narzędzi dla grup/kanałów (opcjonalne)

Niektóre konfiguracje kanałów obsługują ograniczanie, które narzędzia są dostępne **wewnątrz konkretnej grupy/pokoju/kanału**.

- `tools`: zezwalaj/zabraniaj narzędzi dla całej grupy.
- `toolsBySender`: nadpisania per-nadawca w obrębie grupy (klucze to identyfikatory nadawców/nazwy użytkowników/e-maile/numery telefonów w zależności od kanału). Użyj `"*"` jako symbolu wieloznacznego.

Kolejność rozstrzygania (najbardziej szczegółowe wygrywa):

1. dopasowanie `toolsBySender` dla grupy/kanału
2. `tools` dla grupy/kanału
3. domyślne (`"*"`) dopasowanie `toolsBySender`
4. domyślne (`"*"`) `tools`

Przykład (Telegram):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

Uwagi:

- Ograniczenia narzędzi dla grup/kanałów są stosowane dodatkowo do globalnej/per-agent polityki narzędzi (odmowa nadal wygrywa).
- Niektóre kanały używają innego zagnieżdżenia dla pokoi/kanałów (np. Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## Listy dozwolonych grup

Gdy skonfigurowane są `channels.whatsapp.groups`, `channels.telegram.groups` lub `channels.imessage.groups`, klucze działają jako lista dozwolonych grup. Użyj `"*"`, aby zezwolić na wszystkie grupy przy jednoczesnym ustawieniu domyślnego zachowania wzmianek.

Typowe intencje (kopiuj/wklej):

1. Wyłącz wszystkie odpowiedzi w grupach

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. Zezwól tylko na określone grupy (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. Zezwól na wszystkie grupy, ale wymagaj wzmianki (jawnie)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. Tylko właściciel może wyzwalać w grupach (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Aktywacja (tylko właściciel)

Właściciele grup mogą przełączać aktywację per grupa:

- `/activation mention`
- `/activation always`

Właściciel jest określany przez `channels.whatsapp.allowFrom` (lub własny E.164 bota, gdy nieustawione). Wyślij polecenie jako samodzielną wiadomość. Inne platformy obecnie ignorują `/activation`.

## Pola kontekstu

Przychodzące ładunki grupowe ustawiają:

- `ChatType=group`
- `GroupSubject` (jeśli znane)
- `GroupMembers` (jeśli znane)
- `WasMentioned` (wynik kontroli wzmianek)
- Tematy forum Telegrama zawierają także `MessageThreadId` i `IsForum`.

Systemowy prompt agenta zawiera wprowadzenie grupowe w pierwszej turze nowej sesji grupowej. Przypomina modelowi, aby odpowiadał jak człowiek, unikał tabel Markdown i unikał wpisywania dosłownych sekwencji `\n`.

## Specyfika iMessage

- Preferuj `chat_id:<id>` podczas routingu lub tworzenia list dozwolonych.
- Lista czatów: `imsg chats --limit 20`.
- Odpowiedzi grupowe zawsze wracają do tego samego `chat_id`.

## Specyfika WhatsApp

Zobacz [Wiadomości grupowe](/channels/group-messages) dla zachowania specyficznego dla WhatsApp (wstrzykiwanie historii, szczegóły obsługi wzmianek).
