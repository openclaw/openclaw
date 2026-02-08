---
summary: "Overblik over Feishu-bot, funktioner og konfiguration"
read_when:
  - Du vil forbinde en Feishu/Lark-bot
  - Du konfigurerer Feishu-kanalen
title: Feishu
x-i18n:
  source_path: channels/feishu.md
  source_hash: c9349983562d1a98
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:11Z
---

# Feishu-bot

Feishu (Lark) er en teamchatplatform, som virksomheder bruger til beskeder og samarbejde. Dette plugin forbinder OpenClaw til en Feishu/Lark-bot ved hjælp af platformens WebSocket-begivenhedsabonnement, så beskeder kan modtages uden at eksponere en offentlig webhook-URL.

---

## Påkrævet plugin

Installér Feishu-pluginet:

```bash
openclaw plugins install @openclaw/feishu
```

Lokalt checkout (når du kører fra et git-repo):

```bash
openclaw plugins install ./extensions/feishu
```

---

## Hurtig start

Der er to måder at tilføje Feishu-kanalen på:

### Metode 1: introduktionsguide (anbefalet)

Hvis du lige har installeret OpenClaw, så kør guiden:

```bash
openclaw onboard
```

Guiden fører dig igennem:

1. Oprettelse af en Feishu-app og indsamling af legitimationsoplysninger
2. Konfiguration af app-legitimationsoplysninger i OpenClaw
3. Start af gateway

✅ **Efter konfiguration**, tjek gateway-status:

- `openclaw gateway status`
- `openclaw logs --follow`

### Metode 2: CLI-opsætning

Hvis du allerede har gennemført den indledende installation, kan du tilføje kanalen via CLI:

```bash
openclaw channels add
```

Vælg **Feishu**, og indtast derefter App ID og App Secret.

✅ **Efter konfiguration**, administrér gatewayen:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Trin 1: Opret en Feishu-app

### 1. Åbn Feishu Open Platform

Besøg [Feishu Open Platform](https://open.feishu.cn/app) og log ind.

Lark (global) tenants skal bruge [https://open.larksuite.com/app](https://open.larksuite.com/app) og sætte `domain: "lark"` i Feishu-konfigurationen.

### 2. Opret en app

1. Klik på **Create enterprise app**
2. Udfyld app-navn og beskrivelse
3. Vælg et app-ikon

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. Kopiér legitimationsoplysninger

Fra **Credentials & Basic Info**, kopiér:

- **App ID** (format: `cli_xxx`)
- **App Secret**

❗ **Vigtigt:** hold App Secret privat.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. Konfigurér tilladelser

På **Permissions**, klik **Batch import** og indsæt:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. Aktivér bot-funktionalitet

I **App Capability** > **Bot**:

1. Aktivér bot-funktionalitet
2. Sæt bot-navnet

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. Konfigurér event-abonnement

⚠️ **Vigtigt:** før du opsætter event-abonnement, skal du sikre:

1. At du allerede har kørt `openclaw channels add` for Feishu
2. At gatewayen kører (`openclaw gateway status`)

I **Event Subscription**:

1. Vælg **Use long connection to receive events** (WebSocket)
2. Tilføj eventet: `im.message.receive_v1`

⚠️ Hvis gatewayen ikke kører, kan opsætningen af long connection muligvis ikke gemmes.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. Udgiv appen

1. Opret en version i **Version Management & Release**
2. Indsend til gennemgang og udgiv
3. Vent på administratorgodkendelse (enterprise-apps bliver normalt auto-godkendt)

---

## Trin 2: Konfigurér OpenClaw

### Konfigurér med guiden (anbefalet)

```bash
openclaw channels add
```

Vælg **Feishu** og indsæt dit App ID og App Secret.

### Konfigurér via konfigurationsfil

Redigér `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### Konfigurér via miljøvariabler

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark (global) domæne

Hvis din tenant er på Lark (international), så sæt domænet til `lark` (eller en fuld domænestreng). Du kan sætte det i `channels.feishu.domain` eller pr. konto (`channels.feishu.accounts.<id>.domain`).

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## Trin 3: Start + test

### 1. Start gatewayen

```bash
openclaw gateway
```

### 2. Send en testbesked

I Feishu, find din bot og send en besked.

### 3. Godkend parring

Som standard svarer botten med en parringskode. Godkend den:

```bash
openclaw pairing approve feishu <CODE>
```

Efter godkendelse kan du chatte normalt.

---

## Overblik

- **Feishu-botkanal**: Feishu-bot administreret af gatewayen
- **Deterministisk routing**: svar returnerer altid til Feishu
- **Session-isolering**: DM’er deler en hovedsession; grupper er isolerede
- **WebSocket-forbindelse**: long connection via Feishu SDK, ingen offentlig URL nødvendig

---

## Adgangskontrol

### Direkte beskeder

- **Standard**: `dmPolicy: "pairing"` (ukendte brugere får en parringskode)
- **Godkend parring**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Tilladelsesliste-tilstand**: sæt `channels.feishu.allowFrom` med tilladte Open IDs

### Gruppechats

**1. Gruppepolitik** (`channels.feishu.groupPolicy`):

- `"open"` = tillad alle i grupper (standard)
- `"allowlist"` = tillad kun `groupAllowFrom`
- `"disabled"` = deaktivér gruppebeskeder

**2. Krav om omtale** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = kræv @mention (standard)
- `false` = svar uden omtaler

---

## Eksempler på gruppekonfiguration

### Tillad alle grupper, kræv @mention (standard)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### Tillad alle grupper, ingen @mention krævet

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### Tillad kun specifikke brugere i grupper

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## Hent gruppe-/bruger-ID’er

### Gruppe-ID’er (chat_id)

Gruppe-ID’er ser ud som `oc_xxx`.

**Metode 1 (anbefalet)**

1. Start gatewayen og @mention botten i gruppen
2. Kør `openclaw logs --follow` og kig efter `chat_id`

**Metode 2**

Brug Feishu API-debuggeren til at liste gruppechats.

### Bruger-ID’er (open_id)

Bruger-ID’er ser ud som `ou_xxx`.

**Metode 1 (anbefalet)**

1. Start gatewayen og send en DM til botten
2. Kør `openclaw logs --follow` og kig efter `open_id`

**Metode 2**

Tjek parringsanmodninger for bruger-Open IDs:

```bash
openclaw pairing list feishu
```

---

## Almindelige kommandoer

| Kommando  | Beskrivelse       |
| --------- | ----------------- |
| `/status` | Vis bot-status    |
| `/reset`  | Nulstil sessionen |
| `/model`  | Vis/skift model   |

> Note: Feishu understøtter endnu ikke indbyggede kommandomenupunkter, så kommandoer skal sendes som tekst.

## Gateway-administrationskommandoer

| Kommando                   | Beskrivelse                     |
| -------------------------- | ------------------------------- |
| `openclaw gateway status`  | Vis gateway-status              |
| `openclaw gateway install` | Installér/start gateway-service |
| `openclaw gateway stop`    | Stop gateway-service            |
| `openclaw gateway restart` | Genstart gateway-service        |
| `openclaw logs --follow`   | Følg gateway-logs               |

---

## Fejlfinding

### Botten svarer ikke i gruppechats

1. Sørg for, at botten er tilføjet gruppen
2. Sørg for, at du @mention botten (standardadfærd)
3. Tjek at `groupPolicy` ikke er sat til `"disabled"`
4. Tjek logs: `openclaw logs --follow`

### Botten modtager ikke beskeder

1. Sørg for, at appen er udgivet og godkendt
2. Sørg for, at event-abonnementet inkluderer `im.message.receive_v1`
3. Sørg for, at **long connection** er aktiveret
4. Sørg for, at app-tilladelserne er komplette
5. Sørg for, at gatewayen kører: `openclaw gateway status`
6. Tjek logs: `openclaw logs --follow`

### Læk af App Secret

1. Nulstil App Secret i Feishu Open Platform
2. Opdatér App Secret i din konfiguration
3. Genstart gatewayen

### Fejl ved afsendelse af beskeder

1. Sørg for, at appen har tilladelsen `im:message:send_as_bot`
2. Sørg for, at appen er udgivet
3. Tjek logs for detaljerede fejl

---

## Avanceret konfiguration

### Flere konti

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### Beskedgrænser

- `textChunkLimit`: udgående tekst-chunkstørrelse (standard: 2000 tegn)
- `mediaMaxMb`: grænse for upload/download af medier (standard: 30 MB)

### Streaming

Feishu understøtter streaming-svar via interaktive kort. Når det er aktiveret, opdaterer botten et kort, mens den genererer tekst.

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

Sæt `streaming: false` for at vente på det fulde svar, før der sendes.

### Multi-agent routing

Brug `bindings` til at route Feishu-DM’er eller -grupper til forskellige agenter.

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

Routing-felter:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` eller `"group"`
- `match.peer.id`: bruger-Open ID (`ou_xxx`) eller gruppe-ID (`oc_xxx`)

Se [Hent gruppe-/bruger-ID’er](#get-groupuser-ids) for opslagstips.

---

## Konfigurationsreference

Fuld konfiguration: [Gateway-konfiguration](/gateway/configuration)

Nøgleindstillinger:

| Indstilling                                       | Beskrivelse                             | Standard  |
| ------------------------------------------------- | --------------------------------------- | --------- |
| `channels.feishu.enabled`                         | Aktivér/deaktivér kanal                 | `true`    |
| `channels.feishu.domain`                          | API-domæne (`feishu` eller `lark`)      | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                                  | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                              | -         |
| `channels.feishu.accounts.<id>.domain`            | Tilsidesættelse af API-domæne pr. konto | `feishu`  |
| `channels.feishu.dmPolicy`                        | DM-politik                              | `pairing` |
| `channels.feishu.allowFrom`                       | DM-tilladelsesliste (open_id-liste)     | -         |
| `channels.feishu.groupPolicy`                     | Gruppepolitik                           | `open`    |
| `channels.feishu.groupAllowFrom`                  | Gruppens tilladelsesliste               | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | Kræv @mention                           | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | Aktivér gruppe                          | `true`    |
| `channels.feishu.textChunkLimit`                  | Besked-chunkstørrelse                   | `2000`    |
| `channels.feishu.mediaMaxMb`                      | Mediestørrelsesgrænse                   | `30`      |
| `channels.feishu.streaming`                       | Aktivér streaming-kortoutput            | `true`    |
| `channels.feishu.blockStreaming`                  | Aktivér blokstreaming                   | `true`    |

---

## dmPolicy-reference

| Værdi         | Adfærd                                                            |
| ------------- | ----------------------------------------------------------------- |
| `"pairing"`   | **Standard.** Ukendte brugere får en parringskode; skal godkendes |
| `"allowlist"` | Kun brugere i `allowFrom` kan chatte                              |
| `"open"`      | Tillad alle brugere (kræver `"*"` i allowFrom)                    |
| `"disabled"`  | Deaktivér DM’er                                                   |

---

## Understøttede beskedtyper

### Modtag

- ✅ Tekst
- ✅ Rich text (post)
- ✅ Billeder
- ✅ Filer
- ✅ Lyd
- ✅ Video
- ✅ Klistermærker

### Send

- ✅ Tekst
- ✅ Billeder
- ✅ Filer
- ✅ Lyd
- ⚠️ Rich text (delvis understøttelse)
