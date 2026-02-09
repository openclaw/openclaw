---
summary: "Gruppchattbeteende över ytor (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Ändrar gruppchattbeteende eller nämningsstyrning
title: "Grupper"
---

# Grupper

OpenClaw behandlar gruppchattar konsekvent över ytor: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams.

## Nybörjarintro (2 minuter)

OpenClaw “lever” på dina egna meddelandekonton. Det finns ingen separat WhatsApp bot användare.
Om **du** är i en grupp, kan OpenClaw se den gruppen och svara där.

Standardbeteende:

- Grupper är begränsade (`groupPolicy: "allowlist"`).
- Svar kräver en nämning om du inte uttryckligen inaktiverar nämningsstyrning.

Översättning: avsändare på tillåtelselistan kan trigga OpenClaw genom att nämna den.

> TL;DR
>
> - **DM-åtkomst** styrs av `*.allowFrom`.
> - **Gruppåtkomst** styrs av `*.groupPolicy` + tillåtelselistor (`*.groups`, `*.groupAllowFrom`).
> - **Utlösning av svar** styrs av nämningsstyrning (`requireMention`, `/activation`).

Snabbt flöde (vad som händer med ett gruppmeddelande):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Gruppmeddelandeflöde](/images/groups-flow.svg)

Om du vill…

| Mål                                                            | Vad som ska ställas in                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Tillåt alla grupper men svara bara på @-nämningar | `groups: { "*": { requireMention: true } }`                                  |
| Inaktivera alla gruppsvar                                      | `groupPolicy: "disabled"`                                                    |
| Endast specifika grupper                                       | `grupper: { "<group-id>": { ... } }` (ingen `"*"` nyckel) |
| Endast du kan trigga i grupper                                 | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]`                   |

## Sessionsnycklar

- Gruppsessioner använder sessionsnycklar `agent:<agentId>:<channel>:group:<id>` (rum/kanaler använder `agent:<agentId>:<channel>:channel:<id>`).
- Telegram-forumämnen lägger till `:topic:<threadId>` till grupp-ID:t så att varje ämne får sin egen session.
- Direktchattar använder huvudsessionen (eller per avsändare om konfigurerat).
- Heartbeats hoppas över för gruppsessioner.

## Mönster: personliga DM + offentliga grupper (single agent)

Ja — detta fungerar bra om din ”personliga” trafik är **DM** och din ”offentliga” trafik är **grupper**.

Varför: I enagent-läge landar DMs vanligtvis i **main** sessionsnyckeln (`agent:main:main`), medan grupper alltid använder **icke-main** sessionsnycklar (`agent:main:<channel>:group:<id>`). Om du aktiverar sandboxning med `mode: "non-main"`, dessa gruppsessioner körs i Docker medan din huvudsakliga DM-session förblir on-host.

Detta ger dig ett agent-”hjärna” (delad arbetsyta + minne), men två exekveringslägen:

- **DM**: fulla verktyg (värd)
- **Grupper**: sandbox + begränsade verktyg (Docker)

> Om du verkligen behöver separata arbetsytor/personas ("personliga" och "offentliga" får aldrig blandas), använd en andra agent + bindningar. Se [Multi-Agent Routing](/concepts/multi-agent).

Exempel (DM på värd, grupper sandboxade + endast meddelandeverktyg):

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

Vill du ha “grupper kan bara se mapp X” istället för “ingen värdtillgång”? Behåll `workspaceAccess: "none"` och montera endast tillåtna sökvägar i sandlådan:

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

Relaterat:

- Konfigurationsnycklar och standardvärden: [Gateway-konfiguration](/gateway/configuration#agentsdefaultssandbox)
- Felsökning av varför ett verktyg blockeras: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Detaljer om bind-mounts: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## Visningsetiketter

- UI-etiketter använder `displayName` när tillgängligt, formaterat som `<channel>:<token>`.
- `#room` är reserverad för rum/kanaler; gruppchattar använder `g-<slug>` (gemener, mellanslag -> `-`, behåll `#@+._-`).

## Gruppolicy

Styr hur grupp-/rumsmeddelanden hanteras per kanal:

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

| Policy        | Beteende                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------- |
| `"open"`      | Grupper kringgår tillåtelselistor; nämningsstyrning gäller fortfarande.   |
| `"disabled"`  | Blockera alla gruppmeddelanden helt.                                      |
| `"allowlist"` | Tillåt endast grupper/rum som matchar den konfigurerade tillåtelselistan. |

Noteringar:

- `groupPolicy` är separat från nämningsstyrning (som kräver @-nämningar).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: använd `groupAllowFrom` (fallback: explicit `allowFrom`).
- Discord: allowlist använder `channels.discord.guilds.<id>.kanaler`.
- Slack: tillåtelselistan använder `channels.slack.channels`.
- Matrix: allowlist använder `channels.matrix.groups` (rumsnummer, alias eller namn). Använd `channels.matrix.groupAllowFrom` för att begränsa avsändare; per-rum-`users` allowlists stöds också.
- Grupp-DM styrs separat (`channels.discord.dm.*`, `channels.slack.dm.*`).
- Telegram-tillåtelselistan kan matcha användar-ID:n (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) eller användarnamn (`"@alice"` eller `"alice"`); prefix är skiftlägesokänsliga.
- Standard är `groupPolicy: "allowlist"`; om din grupp-tillåtelselista är tom blockeras gruppmeddelanden.

Snabb mental modell (utvärderingsordning för gruppmeddelanden):

1. `groupPolicy` (öppen/inaktiverad/tillåtelselista)
2. grupp-tillåtelselistor (`*.groups`, `*.groupAllowFrom`, kanalspecifik tillåtelselista)
3. nämningsstyrning (`requireMention`, `/activation`)

## Nämningsstyrning (standard)

Gruppmeddelanden kräver ett omnämnande om de inte åsidosätts per grupp. Standard live per delsystem under `*.groups."*"`.

Svaret på en bot meddelande räknas som ett implicit omnämnande (när kanalen stöder svar metadata). Detta gäller Telegram, WhatsApp, Slack, Discord och Microsoft Teams.

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

Noteringar:

- `mentionPatterns` är skiftlägesokänsliga regexar.
- Ytor som tillhandahåller explicita nämningar släpps igenom; mönster är en fallback.
- Per-agent-åsidosättning: `agents.list[].groupChat.mentionPatterns` (användbart när flera agenter delar en grupp).
- Nämningsstyrning tillämpas endast när nämningsdetektion är möjlig (inbyggda nämningar eller när `mentionPatterns` är konfigurerade).
- Discord-standarder finns i `channels.discord.guilds."*"` (kan åsidosättas per guild/kanal).
- Grupphistorikkontext är insvept jämnt över kanaler och är **väntande** (meddelanden överhoppade på grund av omnämnande gating); använd `meddelanden. roupChat.historyLimit` för den globala standarden och `kanaler.<channel>.historyLimit` (eller `kanaler.<channel>.accounts.*.historyLimit`) för åsidosättningar. Sätt `0` till att inaktivera.

## Verktygsbegränsningar för grupp/kanal (valfritt)

Vissa kanal-konfigurer stöder begränsning av vilka verktyg som är tillgängliga **inom en specifik grupp/rum/kanal**.

- `tools`: tillåt/nekade verktyg för hela gruppen.
- `toolsBySender`: åsidosätter per avsändare inom gruppen (nycklar är avsändar-ID/användarnamn/e-post/telefonnummer beroende på kanal). Använd `"*"` som ett jokertecken.

Upplösningsordning (mest specifikt vinner):

1. grupp/kanal `toolsBySender`-match
2. grupp/kanal `tools`
3. standard (`"*"`) `toolsBySender`-match
4. standard (`"*"`) `tools`

Exempel (Telegram):

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

Noteringar:

- Verktygsbegränsningar för grupp/kanal tillämpas utöver global/agent-verktygspolicy (nekande vinner fortfarande).
- Vissa kanaler använder olika häckning för rum/kanaler (t.ex. Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## Grupp-tillåtelselistor

När `channels.whatsapp.groups`, `channels.telegram.groups`, eller `channels.imessage.groups` är konfigurerad, tangenterna fungerar som en grupptillåten lista. Använd `"*"` för att tillåta alla grupper medan du fortfarande anger standardbeteende.

Vanliga avsikter (kopiera/klistra in):

1. Inaktivera alla gruppsvar

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. Tillåt endast specifika grupper (WhatsApp)

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

3. Tillåt alla grupper men kräv nämning (explicit)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. Endast ägaren kan trigga i grupper (WhatsApp)

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

## Aktivering (endast ägare)

Gruppägare kan växla per-grupp-aktivering:

- `/activation mention`
- `/activation always`

Ägare bestäms av `channels.whatsapp.allowFrom` (eller botens själv E.164 när unset). Skicka kommandot som ett fristående meddelande. Andra ytor ignorerar för närvarande `/activation`.

## Kontextfält

Inkommande grupppayloads sätter:

- `ChatType=group`
- `GroupSubject` (om känt)
- `GroupMembers` (om känt)
- `WasMentioned` (resultat av nämningsstyrning)
- Telegram-forumämnen inkluderar även `MessageThreadId` och `IsForum`.

Agentsystemet prompten innehåller en grupp intro på den första vändningen av en ny grupp session. Den påminner modellen om att svara som en människa, undvika markdown tabeller och undvika att skriva bokstavliga `\n` sekvenser.

## iMessage-specifikt

- Föredra `chat_id:<id>` vid routing eller tillåtelselistor.
- Lista chattar: `imsg chats --limit 20`.
- Grupp­svar går alltid tillbaka till samma `chat_id`.

## WhatsApp-specifikt

Se [Gruppmeddelanden](/channels/group-messages) för WhatsApp-specifikt beteende (historikinjektion, detaljer om nämningshantering).
