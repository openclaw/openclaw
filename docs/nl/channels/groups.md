---
summary: "Gedrag van groepschats over verschillende platforms (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Wijzigen van gedrag van groepschats of mention-gating
title: "Groepen"
---

# Groepen

OpenClaw behandelt groepschats consistent over verschillende platforms: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams.

## Beginnerintro (2 minuten)

OpenClaw “leeft” op je eigen messaging-accounts. Er is geen aparte WhatsApp-botgebruiker.
Als **jij** in een groep zit, kan OpenClaw die groep zien en daar reageren.

Standaardgedrag:

- Groepen zijn beperkt (`groupPolicy: "allowlist"`).
- Antwoorden vereisen een mention, tenzij je mention-gating expliciet uitschakelt.

Vertaling: geautoriseerde afzenders kunnen OpenClaw activeren door het te vermelden.

> TL;DR
>
> - **DM-toegang** wordt geregeld door `*.allowFrom`.
> - **Groepstoegang** wordt geregeld door `*.groupPolicy` + toegestane lijsten (`*.groups`, `*.groupAllowFrom`).
> - **Antwoordtriggering** wordt geregeld door mention-gating (`requireMention`, `/activation`).

Snelle flow (wat gebeurt er met een groepsbericht):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Flow van groepsbericht](/images/groups-flow.svg)

Als je wilt...

| Doel                                                                 | Wat instellen                                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Alle groepen toestaan maar alleen reageren op @mentions | `groups: { "*": { requireMention: true } }`                                 |
| Alle groepsreacties uitschakelen                                     | `groupPolicy: "disabled"`                                                   |
| Alleen specifieke groepen                                            | `groups: { "<group-id>": { ... } }` (geen sleutel `"*"`) |
| Alleen jij kunt in groepen triggeren                                 | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]`                  |

## Sessie­sleutels

- Groepssessies gebruiken `agent:<agentId>:<channel>:group:<id>` sessiesleutels (rooms/kanalen gebruiken `agent:<agentId>:<channel>:channel:<id>`).
- Telegram-forumtopics voegen `:topic:<threadId>` toe aan de groeps-id, zodat elk topic een eigen sessie heeft.
- Directe chats gebruiken de hoofdsessie (of per afzender indien geconfigureerd).
- Heartbeat-signalen worden overgeslagen voor groepssessies.

## Patroon: persoonlijke DM’s + publieke groepen (enkele agent)

Ja — dit werkt goed als je “persoonlijke” verkeer **DM’s** zijn en je “publieke” verkeer **groepen**.

Waarom: in de modus met één agent komen DM’s doorgaans terecht in de **hoofd**sessiesleutel (`agent:main:main`), terwijl groepen altijd **niet-hoofd**sessiesleutels gebruiken (`agent:main:<channel>:group:<id>`). Als je sandboxing inschakelt met `mode: "non-main"`, draaien die groepssessies in Docker terwijl je hoofd-DM-sessie op de host blijft.

Dit geeft je één agent-“brein” (gedeelde werkruimte + geheugen), maar twee uitvoeringshoudingen:

- **DM’s**: volledige tools (host)
- **Groepen**: sandbox + beperkte tools (Docker)

> Als je echt gescheiden werkruimtes/persona’s nodig hebt (“persoonlijk” en “publiek” mogen nooit mengen), gebruik dan een tweede agent + bindings. Zie [Multi-Agent Routing](/concepts/multi-agent).

Voorbeeld (DM’s op host, groepen gesandboxed + alleen messaging-tools):

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

Wil je “groepen kunnen alleen map X zien” in plaats van “geen hosttoegang”? Behoud `workspaceAccess: "none"` en mount alleen toegestane paden in de sandbox:

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

Gerelateerd:

- Configuratiesleutels en standaardwaarden: [Gateway-configuratie](/gateway/configuration#agentsdefaultssandbox)
- Debuggen waarom een tool is geblokkeerd: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Details over bind mounts: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## Weergavelabels

- UI-labels gebruiken `displayName` wanneer beschikbaar, opgemaakt als `<channel>:<token>`.
- `#room` is gereserveerd voor rooms/kanalen; groepschats gebruiken `g-<slug>` (kleine letters, spaties -> `-`, behoud `#@+._-`).

## Groepsbeleid

Beheer hoe groeps-/roomberichten per kanaal worden afgehandeld:

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

| Beleid        | Gedrag                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `"open"`      | Groepen omzeilen toegestane lijsten; mention-gating blijft van toepassing.             |
| `"disabled"`  | Blokkeer alle groepsberichten volledig.                                                |
| `"allowlist"` | Sta alleen groepen/rooms toe die overeenkomen met de geconfigureerde toegestane lijst. |

Notities:

- `groupPolicy` staat los van mention-gating (dat @mentions vereist).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: gebruik `groupAllowFrom` (fallback: expliciet `allowFrom`).
- Discord: toegestane lijst gebruikt `channels.discord.guilds.<id>.channels`.
- Slack: toegestane lijst gebruikt `channels.slack.channels`.
- Matrix: toegestane lijst gebruikt `channels.matrix.groups` (room-ID’s, aliassen of namen). Gebruik `channels.matrix.groupAllowFrom` om afzenders te beperken; per-room `users`-lijsten worden ook ondersteund.
- Groeps-DM’s worden afzonderlijk beheerd (`channels.discord.dm.*`, `channels.slack.dm.*`).
- Telegram-toegestane lijst kan user-ID’s matchen (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) of gebruikersnamen (`"@alice"` of `"alice"`); voorvoegsels zijn niet hoofdlettergevoelig.
- Standaard is `groupPolicy: "allowlist"`; als je groeps-allowlist leeg is, worden groepsberichten geblokkeerd.

Snel mentaal model (evaluatievolgorde voor groepsberichten):

1. `groupPolicy` (open/uitgeschakeld/allowlist)
2. groeps-allowlists (`*.groups`, `*.groupAllowFrom`, kanaalspecifieke allowlist)
3. mention-gating (`requireMention`, `/activation`)

## Mention-gating (standaard)

Groepsberichten vereisen een mention, tenzij per groep overschreven. Standaarden leven per subsysteem onder `*.groups."*"`.

Antwoorden op een botbericht tellen als een impliciete mention (wanneer het kanaal reply-metadata ondersteunt). Dit geldt voor Telegram, WhatsApp, Slack, Discord en Microsoft Teams.

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

Notities:

- `mentionPatterns` zijn niet-hoofdlettergevoelige regexen.
- Platforms die expliciete mentions bieden, blijven werken; patronen zijn een fallback.
- Per-agent override: `agents.list[].groupChat.mentionPatterns` (handig wanneer meerdere agents een groep delen).
- Mention-gating wordt alleen afgedwongen wanneer mention-detectie mogelijk is (native mentions of wanneer `mentionPatterns` is geconfigureerd).
- Discord-standaarden staan in `channels.discord.guilds."*"` (per guild/kanaal te overschrijven).
- Context van groepsgeschiedenis wordt uniform verpakt over kanalen en is **alleen pending** (berichten overgeslagen door mention-gating); gebruik `messages.groupChat.historyLimit` voor de globale standaard en `channels.<channel>.historyLimit` (of `channels.<channel>.accounts.*.historyLimit`) voor overrides. Stel `0` in om uit te schakelen.

## Groeps-/kanaaltoolbeperkingen (optioneel)

Sommige kanaalconfiguraties ondersteunen het beperken van welke tools beschikbaar zijn **binnen een specifieke groep/room/kanaal**.

- `tools`: tools toestaan/weigeren voor de hele groep.
- `toolsBySender`: per-afzender overrides binnen de groep (sleutels zijn afzender-ID’s/gebruiksnamen/e-mails/telefoonnummers, afhankelijk van het kanaal). Gebruik `"*"` als wildcard.

Resolutievolgorde (meest specifiek wint):

1. groep/kanaal `toolsBySender`-match
2. groep/kanaal `tools`
3. standaard (`"*"`) `toolsBySender`-match
4. standaard (`"*"`) `tools`

Voorbeeld (Telegram):

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

Notities:

- Groeps-/kanaaltoolbeperkingen worden toegepast bovenop het globale/agent toolbeleid (weigeren wint nog steeds).
- Sommige kanalen gebruiken een andere nesting voor rooms/kanalen (bijv. Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## Groeps-allowlists

Wanneer `channels.whatsapp.groups`, `channels.telegram.groups` of `channels.imessage.groups` is geconfigureerd, fungeren de sleutels als groeps-allowlist. Gebruik `"*"` om alle groepen toe te staan terwijl je toch standaard mention-gedrag instelt.

Veelvoorkomende intents (kopiëren/plakken):

1. Alle groepsreacties uitschakelen

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. Alleen specifieke groepen toestaan (WhatsApp)

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

3. Alle groepen toestaan maar mention vereisen (expliciet)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. Alleen de eigenaar kan in groepen triggeren (WhatsApp)

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

## Activatie (alleen eigenaar)

Groepseigenaren kunnen per groep activatie toggelen:

- `/activation mention`
- `/activation always`

De eigenaar wordt bepaald door `channels.whatsapp.allowFrom` (of de eigen E.164 van de bot wanneer niet ingesteld). Stuur het commando als een losstaand bericht. Andere platforms negeren momenteel `/activation`.

## Contextvelden

Inkomende payloads van groepen zetten:

- `ChatType=group`
- `GroupSubject` (indien bekend)
- `GroupMembers` (indien bekend)
- `WasMentioned` (resultaat van mention-gating)
- Telegram-forumtopics bevatten ook `MessageThreadId` en `IsForum`.

De agent-systeemprompt bevat bij de eerste beurt van een nieuwe groepssessie een groepsintro. Die herinnert het model eraan om als een mens te reageren, Markdown-tabellen te vermijden en het letterlijk typen van `\n`-reeksen te vermijden.

## iMessage-specifiek

- Geef de voorkeur aan `chat_id:<id>` bij routering of allowlisting.
- Chats weergeven: `imsg chats --limit 20`.
- Groepsantwoorden gaan altijd terug naar dezelfde `chat_id`.

## WhatsApp-specifiek

Zie [Groepsberichten](/channels/group-messages) voor WhatsApp-specifiek gedrag (geschiedenis-injectie, details van mention-afhandeling).
