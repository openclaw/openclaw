---
summary: "Översikt, funktioner och konfiguration för Feishu-bot"
read_when:
  - Du vill ansluta en Feishu/Lark-bot
  - Du konfigurerar Feishu-kanalen
title: Feishu
---

# Feishu-bot

Feishu (Lark) är en teamchattplattform som används av företag för meddelanden och samarbete. Denna plugin ansluter OpenClaw till en Feishu/Lark bot med hjälp av plattformens WebSocket event prenumeration så att meddelanden kan tas emot utan att exponera en publik webhook-URL.

---

## Plugin krävs

Installera Feishu-pluginet:

```bash
openclaw plugins install @openclaw/feishu
```

Lokal checkout (när du kör från ett git-repo):

```bash
openclaw plugins install ./extensions/feishu
```

---

## Snabbstart

Det finns två sätt att lägga till Feishu-kanalen:

### Metod 1: introduktionsguide (rekommenderas)

Om du just har installerat OpenClaw, kör guiden:

```bash
openclaw onboard
```

Guiden leder dig genom:

1. Skapa en Feishu-app och samla in autentiseringsuppgifter
2. Konfigurera appuppgifter i OpenClaw
3. Starta gateway

✅ **Efter konfiguration**, kontrollera gateway-status:

- `openclaw gateway status`
- `openclaw logs --follow`

### Metod 2: CLI-konfigurering

Om du redan har slutfört den initiala installationen, lägg till kanalen via CLI:

```bash
openclaw channels add
```

Välj **Feishu** och ange sedan App ID och App Secret.

✅ **Efter konfiguration**, hantera gateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Steg 1: Skapa en Feishu-app

### 1. Öppna Feishu Öppen plattform

Besök [Feishu Open Platform](https://open.feishu.cn/app) och logga in.

Lark‑tenants (globalt) ska använda [https://open.larksuite.com/app](https://open.larksuite.com/app) och ställa in `domain: "lark"` i Feishu-konfigen.

### 2. Skapa en app

1. Klicka på **Create enterprise app**
2. Fyll i appnamn + beskrivning
3. Välj en appikon

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. Kopiera inloggningsuppgifter

Från **Credentials & Basic Info**, kopiera:

- **App ID** (format: `cli_xxx`)
- **App Secret**

❗ **Viktigt:** håll App Secret privat.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. Konfigurera behörigheter

På **Permissions**, klicka på **Batch import** och klistra in:

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

### 5. Aktivera bot-funktion

I **App Capability** > **Bot**:

1. Aktivera bot-funktion
2. Ange botens namn

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. Konfigurera händelseprenumeration

⚠️ **Viktigt:** innan du ställer in händelseprenumeration, säkerställ att:

1. Du redan har kört `openclaw channels add` för Feishu
2. Gateway körs (`openclaw gateway status`)

I **Event Subscription**:

1. Välj **Use long connection to receive events** (WebSocket)
2. Lägg till händelsen: `im.message.receive_v1`

⚠️ Om gateway inte körs kan inställningen för lång anslutning misslyckas att sparas.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. Publicera appen

1. Skapa en version i **Version Management & Release**
2. Skicka in för granskning och publicera
3. Vänta på admin-godkännande (enterprise-appar godkänns vanligtvis automatiskt)

---

## Steg 2: Konfigurera OpenClaw

### Konfigurera med guiden (rekommenderas)

```bash
openclaw channels add
```

Välj **Feishu** och klistra in ditt App ID + App Secret.

### Konfigurera via konfigfil

Redigera `~/.openclaw/openclaw.json`:

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

### Konfigurera via miljövariabler

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark-domän (global)

Om din hyresgäst är på Lark (internationell), ange domänen till `lark` (eller en full domänsträng). Du kan ställa in den i `channels.feishu.domain` eller per konto (`channels.feishu.accounts.<id>.domain`).

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

## Steg 3: Starta + testa

### 1. Starta gatewayn

```bash
openclaw gateway
```

### 2. Skicka ett testmeddelande

I Feishu, hitta din bot och skicka ett meddelande.

### 3. Godkänn parkoppling

Som standard svarar botten med en parningskod. Godkänn det:

```bash
openclaw pairing approve feishu <CODE>
```

Efter godkännande kan du chatta normalt.

---

## Översikt

- **Feishu-botkanal**: Feishu-bot som hanteras av gateway
- **Deterministisk routning**: svar returnerar alltid till Feishu
- **Sessionsisolering**: DM delar en huvudsession; grupper är isolerade
- **WebSocket-anslutning**: lång anslutning via Feishu SDK, ingen publik URL behövs

---

## Åtkomstkontroll

### Direktmeddelanden

- **Standard**: `dmPolicy: "pairing"` (okända användare får en parningskod)

- **Godkänn parning**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Tillåtelselista**: ställ in `channels.feishu.allowFrom` med tillåtna Open IDs

### Gruppchattar

**1. Grupppolicy** (`channels.feishu.groupPolicy`):

- `"open"` = tillåt alla i grupper (standard)
- `"allowlist"` = tillåt endast `groupAllowFrom`
- `"disabled"` = inaktivera gruppmeddelanden

**2. Nämn krav** (`channels.feishu.groups.<chat_id>.requireNämna`):

- `true` = kräver @omnämnande (standard)
- `false` = svara utan omnämnanden

---

## Exempel på gruppkonfiguration

### Tillåt alla grupper, kräv @omnämnande (standard)

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

### Tillåt alla grupper, inget @omnämnande krävs

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

### Tillåt endast specifika användare i grupper

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

## Hämta grupp-/användar-ID:n

### Grupp-ID:n (chat_id)

Grupp-ID:n ser ut som `oc_xxx`.

**Metod 1 (rekommenderad)**

1. Starta gateway och @omnämn boten i gruppen
2. Kör `openclaw logs --follow` och leta efter `chat_id`

**Metod 2**

Använd Feishu API-debuggern för att lista gruppchattar.

### Användar-ID:n (open_id)

Användar-ID:n ser ut som `ou_xxx`.

**Metod 1 (rekommenderad)**

1. Starta gateway och skicka DM till boten
2. Kör `openclaw logs --follow` och leta efter `open_id`

**Metod 2**

Kontrollera parningsförfrågningar för användarens Open IDs:

```bash
openclaw pairing list feishu
```

---

## Vanliga kommandon

| Kommando  | Beskrivning       |
| --------- | ----------------- |
| `/status` | Visa botstatus    |
| `/reset`  | Återställ session |
| `/model`  | Visa/byta modell  |

> Obs: Feishu stöder ännu inte inbyggda kommandomenyer, så kommandon måste skickas som text.

## Gateway-hanteringskommandon

| Kommando                   | Beskrivning                      |
| -------------------------- | -------------------------------- |
| `openclaw gateway status`  | Visa gateway-status              |
| `openclaw gateway install` | Installera/starta gateway-tjänst |
| `openclaw gateway stop`    | Stoppa gateway-tjänst            |
| `openclaw gateway restart` | Starta om gateway-tjänst         |
| `openclaw logs --follow`   | Följ gateway-loggar              |

---

## Felsökning

### Boten svarar inte i gruppchattar

1. Säkerställ att boten är tillagd i gruppen
2. Säkerställ att du @omnämner boten (standardbeteende)
3. Kontrollera att `groupPolicy` inte är satt till `"disabled"`
4. Kontrollera loggar: `openclaw logs --follow`

### Boten tar inte emot meddelanden

1. Säkerställ att appen är publicerad och godkänd
2. Säkerställ att händelseprenumerationen inkluderar `im.message.receive_v1`
3. Säkerställ att **lång anslutning** är aktiverad
4. Säkerställ att appbehörigheterna är kompletta
5. Säkerställ att gateway körs: `openclaw gateway status`
6. Kontrollera loggar: `openclaw logs --follow`

### Läckage av App Secret

1. Återställ App Secret i Feishu Open Platform
2. Uppdatera App Secret i din konfig
3. Starta om gateway

### Misslyckade meddelandesändningar

1. Säkerställ att appen har behörigheten `im:message:send_as_bot`
2. Säkerställ att appen är publicerad
3. Kontrollera loggarna för detaljerade fel

---

## Avancerad konfiguration

### Flera konton

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

### Meddelandegränser

- `textChunkLimit`: storlek på utgående textsegment (standard: 2000 tecken)
- `mediaMaxMb`: gräns för mediauppladdning/-nedladdning (standard: 30 MB)

### Strömning

Feishu stöder strömmande svar via interaktiva kort. När den är aktiverad uppdaterar boten ett kort eftersom det genererar text.

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

Ställ in `streaming: false` för att vänta på hela svaret innan det skickas.

### Multi-agent-routning

Använd `bindings` för att routa Feishu-DM eller grupper till olika agenter.

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

Routningsfält:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` eller `"group"`
- `match.peer.id`: användarens Open ID (`ou_xxx`) eller grupp-ID (`oc_xxx`)

Se [Hämta grupp-/användar-ID:n](#get-groupuser-ids) för tips om uppslagning.

---

## Konfigurationsreferens

Fullständig konfiguration: [Gateway-konfiguration](/gateway/configuration)

Viktiga alternativ:

| Inställning                                       | Beskrivning                                                                | Standard  |
| ------------------------------------------------- | -------------------------------------------------------------------------- | --------- |
| `channels.feishu.enabled`                         | Aktivera/inaktivera kanal                                                  | `true`    |
| `channels.feishu.domain`                          | API-domän (`feishu` eller `lark`)                       | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                                                                     | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                                                                 | -         |
| `channels.feishu.accounts.<id>.domain`            | Åsidosättning av API-domän per konto                                       | `feishu`  |
| `channels.feishu.dmPolicy`                        | DM-policy                                                                  | `pairing` |
| `channels.feishu.allowFrom`                       | DM-tillåtelselista (open_id-lista) | -         |
| `channels.feishu.groupPolicy`                     | Grupppolicy                                                                | `open`    |
| `channels.feishu.groupAllowFrom`                  | Grupp-tillåtelselista                                                      | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | Kräv @omnämnande                                              | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | Aktivera grupp                                                             | `true`    |
| `channels.feishu.textChunkLimit`                  | Meddelandesegmentstorlek                                                   | `2000`    |
| `channels.feishu.mediaMaxMb`                      | Mediastorleksgräns                                                         | `30`      |
| `channels.feishu.streaming`                       | Aktivera strömmande kortutdata                                             | `true`    |
| `channels.feishu.blockStreaming`                  | Aktivera blockstreaming                                                    | `true`    |

---

## dmPolicy-referens

| Värde         | Beteende                                                                           |
| ------------- | ---------------------------------------------------------------------------------- |
| `"pairing"`   | **Standard.** Okända användare får en parningskod; måste godkännas |
| `"allowlist"` | Endast användare i `allowFrom` kan chatta                                          |
| `"open"`      | Tillåt alla användare (kräver `"*"` i allowFrom)                |
| `"disabled"`  | Inaktivera DM                                                                      |

---

## Meddelandetyper som stöds

### Ta emot

- ✅ Text
- ✅ Rik text (post)
- ✅ Bilder
- ✅ Filer
- ✅ Ljud
- ✅ Video
- ✅ Klistermärken

### Skicka

- ✅ Text
- ✅ Bilder
- ✅ Filer
- ✅ Ljud
- ⚠️ Rik text (begränsat stöd)
