---
summary: "Gruppechat-adfærd på tværs af overflader (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Ændring af gruppechat-adfærd eller mention-gating
title: "Grupper"
---

# Grupper

OpenClaw behandler gruppechats ensartet på tværs af overflader: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams.

## Begynderintro (2 minutter)

OpenClaw “lives” på dine egne beskedkonti. Der er ingen separat WhatsApp bot bruger.
Hvis **du** er i en gruppe, kan OpenClaw se denne gruppe og svare der.

Standardadfærd:

- Grupper er begrænsede (`groupPolicy: "allowlist"`).
- Svar kræver en mention, medmindre du eksplicit deaktiverer mention-gating.

Oversættelse: autoriserede afsendere kan udløse OpenClaw ved at nævne den.

> TL;DR
>
> - **DM-adgang** styres af `*.allowFrom`.
> - **Gruppeadgang** styres af `*.groupPolicy` + tilladelseslister (`*.groups`, `*.groupAllowFrom`).
> - **Udløsning af svar** styres af mention-gating (`requireMention`, `/activation`).

Hurtigt flow (hvad der sker med en gruppemeddelelse):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Gruppebesked-flow](/images/groups-flow.svg)

Hvis du vil...

| Mål                                                        | Hvad der skal sættes                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| Tillad alle grupper men svar kun på @mentions | `groups: { "*": { requireMention: true } }`                                 |
| Deaktivér alle gruppesvar                                  | `groupPolicy: "disabled"`                                                   |
| Kun specifikke grupper                                     | `grupper: { "<group-id>": { ... } }` (ingen `"*"` nøgle) |
| Kun du kan udløse i grupper                                | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]`                  |

## Session-nøgler

- Gruppesessioner bruger `agent:<agentId>:<channel>:group:<id>`-sessionsnøgler (rum/kanaler bruger `agent:<agentId>:<channel>:channel:<id>`).
- Telegram-forumemner tilføjer `:topic:<threadId>` til gruppe-id’et, så hvert emne har sin egen session.
- Direkte chats bruger hovedsessionen (eller pr. afsender, hvis konfigureret).
- Heartbeats springes over for gruppesessioner.

## Mønster: personlige DM’er + offentlige grupper (single agent)

Ja — dette fungerer godt, hvis din “personlige” trafik er **DM’er**, og din “offentlige” trafik er **grupper**.

Hvorfor: I enkelt-agent tilstand, lander DMs typisk i **main** sessionsnøglen (`agent:main:main`), mens grupper altid bruger **ikke-main** sessionsnøgler (`agent:main:<channel>:group:<id>`). Hvis du aktiverer sandboxing med `tilstand: "non-main"`, kører disse gruppesessioner i Docker, mens din primære DM session forbliver på værten.

Det giver dig én agent-“hjerne” (delt arbejdsområde + hukommelse), men to udførelsespositioner:

- **DM’er**: fulde værktøjer (vært)
- **Grupper**: sandbox + begrænsede værktøjer (Docker)

> Hvis du virkelig har brug for separate arbejdsområder/personas (“personlige” og “offentlige” må aldrig blande), skal du bruge en anden agent + bindinger. Se [Multi-Agent Routing](/concepts/multi-agent).

Eksempel (DM’er på vært, grupper sandboxed + kun beskedværktøjer):

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

Vil du have “grupper kan kun se mappe X” i stedet for “ingen vært adgang”? Behold `workspaceAccess: "none"` og monter kun tilladte stier i sandkassen:

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

Relateret:

- Konfigurationsnøgler og standarder: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)
- Fejlfinding af hvorfor et værktøj er blokeret: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Detaljer om bind mounts: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## Visningsetiketter

- UI-etiketter bruger `displayName`, når det er tilgængeligt, formateret som `<channel>:<token>`.
- `#room` er reserveret til rum/kanaler; gruppechats bruger `g-<slug>` (små bogstaver, mellemrum -> `-`, behold `#@+._-`).

## Gruppepolitik

Styr hvordan gruppe-/rumbeskeder håndteres pr. kanal:

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

| Politik       | Adfærd                                                                                  |
| ------------- | --------------------------------------------------------------------------------------- |
| `"open"`      | Grupper omgår tilladelseslister; mention-gating gælder stadig.          |
| `"disabled"`  | Blokér alle gruppemeddelelser fuldstændigt.                             |
| `"allowlist"` | Tillad kun grupper/rum, der matcher den konfigurerede tilladelsesliste. |

Noter:

- `groupPolicy` er adskilt fra mention-gating (som kræver @mentions).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: brug `groupAllowFrom` (fallback: eksplicit `allowFrom`).
- Discord: allowlist uses `channels.discord.guilds.<id>.kanaler`.
- Slack: tilladelseslisten bruger `channels.slack.channels`.
- Matrix: allowlist bruger `channels.matrix.groups` (room IDs, aliaser eller navne). Brug `channels.matrix.groupAllowFrom` for at begrænse afsendere; per-room `users` tilladelser lister understøttes også.
- Gruppe-DM’er styres separat (`channels.discord.dm.*`, `channels.slack.dm.*`).
- Telegram-tilladelseslisten kan matche bruger-id’er (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) eller brugernavne (`"@alice"` eller `"alice"`); præfikser er ikke store/små-bogstavsfølsomme.
- Standard er `groupPolicy: "allowlist"`; hvis din gruppetilladelsesliste er tom, blokeres gruppemeddelelser.

Hurtig mental model (evalueringsrækkefølge for gruppemeddelelser):

1. `groupPolicy` (åben/deaktiveret/tilladelsesliste)
2. gruppetilladelseslister (`*.groups`, `*.groupAllowFrom`, kanalspecifik tilladelsesliste)
3. mention-gating (`requireMention`, `/activation`)

## Mention-gating (standard)

Gruppebeskeder kræver en nævnelse, medmindre tilsidesættes pr. gruppe. Standard live pr. delsystem under `*.groups."*"`.

Svar på en bot besked tæller som en implicit omtale (når kanalen understøtter svar metadata). Dette gælder for Telegram, WhatsApp, Slack, Discord, og Microsoft Teams.

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

Noter:

- `mentionPatterns` er ikke store/små-bogstavsfølsomme regex’er.
- Overflader, der leverer eksplicitte mentions, passerer stadig; mønstre er en fallback.
- Pr.-agent-override: `agents.list[].groupChat.mentionPatterns` (nyttigt når flere agenter deler en gruppe).
- Mention-gating håndhæves kun, når mention-detektion er mulig (native mentions eller `mentionPatterns` er konfigureret).
- Discord-standarder findes i `channels.discord.guilds."*"` (kan tilsidesættes pr. guild/kanal).
- Gruppehistorik kontekst er indpakket ensartet på tværs af kanaler og er **ventende kun** (meddelelser sprunget over grundet at nævne gating); brug `beskeder. roupChat.historyLimit` for den globale standard og `kanaler.<channel>.historyLimit` (eller 'kanaler).<channel>.accounts.\*.historyLimit`) for tilsidesættelser. Sæt `0\` til deaktiveret.

## Gruppe-/kanalværktøjsbegrænsninger (valgfrit)

Nogle kanalkonfigurationer understøtter begrænsning af, hvilke værktøjer der er tilgængelige **inde i en specifik gruppe/rum/kanal**.

- `tools`: tillad/afvis værktøjer for hele gruppen.
- `toolsBySender`: per-afsender tilsidesættelser i gruppen (nøgler er afsender-IDs/brugernavn/e-mails/telefonnumre afhængigt af kanalen). Brug `"*"` som et jokertegn.

Opløsningsrækkefølge (mest specifik vinder):

1. gruppe/kanal `toolsBySender`-match
2. gruppe/kanal `tools`
3. standard (`"*"`) `toolsBySender`-match
4. standard (`"*"`) `tools`

Eksempel (Telegram):

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

Noter:

- Gruppe-/kanalværktøjsbegrænsninger anvendes ud over global/agent-værktøjspolitik (afvisning vinder stadig).
- Nogle kanaler bruger forskellig indlejring for rum/kanaler (fx Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## Gruppetilladelseslister

Når `channels.whatsapp.groups`, `channels.telegram.groups`, eller `channels.imessage.groups` er konfigureret, så fungerer nøglerne som en gruppe allowlist. Brug `"*"` for at tillade alle grupper mens du stadig sætter standard omtale adfærd.

Almindelige intentioner (kopiér/indsæt):

1. Deaktivér alle gruppesvar

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. Tillad kun specifikke grupper (WhatsApp)

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

3. Tillad alle grupper men kræv mention (eksplicit)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. Kun ejeren kan udløse i grupper (WhatsApp)

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

## Aktivering (kun ejer)

Gruppeejere kan slå aktivering til/fra pr. gruppe:

- `/activation mention`
- `/activation always`

Ejer bestemmes af `channels.whatsapp.allowFrom` (eller bot’s self E.164 når fra). Send kommandoen som en standalone besked. Andre overflader ignorerer i øjeblikket `/aktivering`.

## Kontekstfelter

Indgående gruppepayloads sætter:

- `ChatType=group`
- `GroupSubject` (hvis kendt)
- `GroupMembers` (hvis kendt)
- `WasMentioned` (resultat af mention-gating)
- Telegram-forumemner inkluderer også `MessageThreadId` og `IsForum`.

Agent system prompt omfatter en gruppe intro på den første tur af en ny gruppe session. Det minder modellen om at reagere som et menneske, undgå Markdown tabeller, og undgå at skrive bogstavelige `\n` sekvenser.

## iMessage-specifikt

- Foretræk `chat_id:<id>` ved routing eller tilladelseslister.
- List chats: `imsg chats --limit 20`.
- Gruppesvar sendes altid tilbage til den samme `chat_id`.

## WhatsApp-specifikt

Se [Group messages](/channels/group-messages) for WhatsApp-specifik adfærd (historik-injektion, detaljer om mention-håndtering).
