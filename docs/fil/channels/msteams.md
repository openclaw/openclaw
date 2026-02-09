---
summary: "Katayuan ng suporta, mga kakayahan, at konpigurasyon ng Microsoft Teams bot"
read_when:
  - Gumagawa sa mga feature ng MS Teams channel
title: "Microsoft Teams"
---

# Microsoft Teams (plugin)

> "Iwan ang lahat ng pag-asa, kayong pumapasok dito."

Na-update: 2026-01-21

Status: text + DM attachments are supported; channel/group file sending requires `sharePointSiteId` + Graph permissions (see [Sending files in group chats](#sending-files-in-group-chats)). Polls are sent via Adaptive Cards.

## Kinakailangang plugin

Ang Microsoft Teams ay dumarating bilang plugin at hindi kasama sa core install.

**Breaking change (2026.1.15):** MS Teams moved out of core. If you use it, you must install the plugin.

Maipapaliwanag: pinananatiling magaan ang mga core install at hinahayaang mag-update nang hiwalay ang mga dependency ng MS Teams.

I-install sa pamamagitan ng CLI (npm registry):

```bash
openclaw plugins install @openclaw/msteams
```

Local checkout (kapag tumatakbo mula sa git repo):

```bash
openclaw plugins install ./extensions/msteams
```

Kung pipiliin mo ang Teams sa panahon ng configure/onboarding at may na-detect na git checkout,
awtomatikong iaalok ng OpenClaw ang local install path.

Mga detalye: [Plugins](/tools/plugin)

## Mabilis na setup (baguhan)

1. I-install ang Microsoft Teams plugin.
2. Gumawa ng **Azure Bot** (App ID + client secret + tenant ID).
3. I-configure ang OpenClaw gamit ang mga kredensyal na iyon.
4. I-expose ang `/api/messages` (port 3978 bilang default) sa pamamagitan ng public URL o tunnel.
5. I-install ang Teams app package at simulan ang gateway.

Minimal na config:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Note: group chats are blocked by default (`channels.msteams.groupPolicy: "allowlist"`). To allow group replies, set `channels.msteams.groupAllowFrom` (or use `groupPolicy: "open"` to allow any member, mention-gated).

## Mga layunin

- Makipag-usap sa OpenClaw sa pamamagitan ng Teams DMs, group chats, o channels.
- Panatilihing deterministiko ang routing: ang mga sagot ay laging bumabalik sa channel kung saan sila dumating.
- Mag-default sa ligtas na pag-uugali ng channel (kinakailangan ang mga mention maliban kung iba ang naka-configure).

## Mga write sa config

Bilang default, pinapayagan ang Microsoft Teams na magsulat ng mga update sa config na na-trigger ng `/config set|unset` (nangangailangan ng `commands.config: true`).

I-disable gamit ang:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Kontrol sa access (DMs + groups)

**DM access**

- Default: `channels.msteams.dmPolicy = "pairing"`. Unknown senders are ignored until approved.
- `channels.msteams.allowFrom` accepts AAD object IDs, UPNs, or display names. The wizard resolves names to IDs via Microsoft Graph when credentials allow.

**Group access**

- Default: `channels.msteams.groupPolicy = "allowlist"` (blocked unless you add `groupAllowFrom`). Use `channels.defaults.groupPolicy` to override the default when unset.
- Kinokontrol ng `channels.msteams.groupAllowFrom` kung aling mga sender ang maaaring mag-trigger sa group chats/channels (bumabagsak sa `channels.msteams.allowFrom`).
- Itakda ang `groupPolicy: "open"` para payagan ang sinumang miyembro (may mention‑gating pa rin bilang default).
- Para payagan ang **walang channels**, itakda ang `channels.msteams.groupPolicy: "disabled"`.

Halimbawa:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Teams + channel allowlist**

- I-scope ang mga reply sa group/channel sa pamamagitan ng paglista ng mga team at channel sa ilalim ng `channels.msteams.teams`.
- Ang mga key ay maaaring team ID o pangalan; ang mga channel key ay maaaring conversation ID o pangalan.
- Kapag `groupPolicy="allowlist"` at may teams allowlist, tanging ang mga nakalistang team/channel lang ang tinatanggap (may mention‑gating).
- Tumatanggap ang configure wizard ng mga entry na `Team/Channel` at iniimbak ang mga ito para sa iyo.
- Sa startup, nireresolba ng OpenClaw ang mga pangalan ng team/channel at user allowlist patungo sa mga ID (kapag pinapayagan ng mga pahintulot ng Graph)
  at inilolog ang mapping; ang mga hindi maresolbang entry ay pinananatili kung paano sila tinype.

Halimbawa:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## Paano ito gumagana

1. I-install ang Microsoft Teams plugin.
2. Gumawa ng **Azure Bot** (App ID + secret + tenant ID).
3. Bumuo ng **Teams app package** na tumutukoy sa bot at kasama ang mga pahintulot ng RSC sa ibaba.
4. I-upload/i-install ang Teams app sa isang team (o personal scope para sa DMs).
5. I-configure ang `msteams` sa `~/.openclaw/openclaw.json` (o env vars) at simulan ang gateway.
6. Nakikinig ang gateway para sa Bot Framework webhook traffic sa `/api/messages` bilang default.

## Azure Bot Setup (Mga paunang kinakailangan)

Bago i-configure ang OpenClaw, kailangan mong gumawa ng Azure Bot resource.

### Hakbang 1: Gumawa ng Azure Bot

1. Pumunta sa [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Punan ang tab na **Basics**:

   | Field              | Value                                                                                             |
   | ------------------ | ------------------------------------------------------------------------------------------------- |
   | **Bot handle**     | Pangalan ng iyong bot, hal., `openclaw-msteams` (dapat unique) |
   | **Subscription**   | Piliin ang iyong Azure subscription                                                               |
   | **Resource group** | Gumawa ng bago o gumamit ng umiiral                                                               |
   | **Pricing tier**   | **Free** para sa dev/testing                                                                      |
   | **Type of App**    | **Single Tenant** (inirerekomenda - tingnan ang tala sa ibaba)                 |
   | **Creation type**  | **Create new Microsoft App ID**                                                                   |

> **Abiso ng pagkaluma:** Ang paglikha ng mga bagong multi-tenant bot ay dineprecate pagkatapos ng 2025-07-31. Gamitin ang **Single Tenant** para sa mga bagong bot.

3. I-click ang **Review + create** → **Create** (maghintay ~1-2 minuto)

### Hakbang 2: Kunin ang mga Kredensyal

1. Pumunta sa iyong Azure Bot resource → **Configuration**
2. Kopyahin ang **Microsoft App ID** → ito ang iyong `appId`
3. I-click ang **Manage Password** → pumunta sa App Registration
4. Sa ilalim ng **Certificates & secrets** → **New client secret** → kopyahin ang **Value** → ito ang iyong `appPassword`
5. Pumunta sa **Overview** → kopyahin ang **Directory (tenant) ID** → ito ang iyong `tenantId`

### Hakbang 3: I-configure ang Messaging Endpoint

1. Sa Azure Bot → **Configuration**
2. Itakda ang **Messaging endpoint** sa iyong webhook URL:
   - Production: `https://your-domain.com/api/messages`
   - Local dev: Gumamit ng tunnel (tingnan ang [Local Development](#local-development-tunneling) sa ibaba)

### Hakbang 4: I-enable ang Teams Channel

1. Sa Azure Bot → **Channels**
2. I-click ang **Microsoft Teams** → Configure → Save
3. Tanggapin ang Terms of Service

## Local Development (Tunneling)

Teams can't reach `localhost`. Use a tunnel for local development:

**Opsyon A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**Opsyon B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal (Alternatibo)

Sa halip na manu-manong gumawa ng manifest ZIP, maaari mong gamitin ang [Teams Developer Portal](https://dev.teams.microsoft.com/apps):

1. I-click ang **+ New app**
2. Punan ang basic info (pangalan, paglalarawan, info ng developer)
3. Pumunta sa **App features** → **Bot**
4. Piliin ang **Enter a bot ID manually** at i-paste ang iyong Azure Bot App ID
5. Lagyan ng check ang scopes: **Personal**, **Team**, **Group Chat**
6. I-click ang **Distribute** → **Download app package**
7. Sa Teams: **Apps** → **Manage your apps** → **Upload a custom app** → piliin ang ZIP

Madalas itong mas madali kaysa mano-manong pag-edit ng JSON manifests.

## Pagsubok sa Bot

**Opsyon A: Azure Web Chat (i-verify muna ang webhook)**

1. Sa Azure Portal → iyong Azure Bot resource → **Test in Web Chat**
2. Magpadala ng mensahe - dapat kang makakita ng tugon
3. Kinukumpirma nito na gumagana ang iyong webhook endpoint bago ang Teams setup

**Opsyon B: Teams (pagkatapos ng pag-install ng app)**

1. I-install ang Teams app (sideload o org catalog)
2. Hanapin ang bot sa Teams at magpadala ng DM
3. Tingnan ang mga gateway log para sa papasok na activity

## Setup (minimal na text-only)

1. **I-install ang Microsoft Teams plugin**
   - Mula npm: `openclaw plugins install @openclaw/msteams`
   - Mula sa local checkout: `openclaw plugins install ./extensions/msteams`

2. **Bot registration**
   - Gumawa ng Azure Bot (tingnan sa itaas) at tandaan:
     - App ID
     - Client secret (App password)
     - Tenant ID (single-tenant)

3. **Teams app manifest**
   - Isama ang entry na `bot` na may `botId = <App ID>`.
   - Mga scope: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (kinakailangan para sa personal scope file handling).
   - Magdagdag ng mga pahintulot ng RSC (sa ibaba).
   - Gumawa ng mga icon: `outline.png` (32x32) at `color.png` (192x192).
   - I-zip ang tatlong file: `manifest.json`, `outline.png`, `color.png`.

4. **I-configure ang OpenClaw**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   Maaari ka ring gumamit ng mga environment variable sa halip na mga config key:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Bot endpoint**
   - Itakda ang Azure Bot Messaging Endpoint sa:
     - `https://<host>:3978/api/messages` (o ang napili mong path/port).

6. **Patakbuhin ang gateway**
   - Awtomatikong nagsisimula ang Teams channel kapag naka-install ang plugin at umiiral ang `msteams` config na may mga kredensyal.

## Konteksto ng history

- Kinokontrol ng `channels.msteams.historyLimit` kung ilang kamakailang mensahe ng channel/group ang ibinabalot sa prompt.
- Falls back to `messages.groupChat.historyLimit`. Itakda sa `0` para i-disable (default 50).
- Maaaring limitahan ang kasaysayan ng DM gamit ang `channels.msteams.dmHistoryLimit` (user turns). Per-user overrides: `channels.msteams.dms["<user_id>"].historyLimit`.

## Kasalukuyang Teams RSC Permissions (Manifest)

These are the **existing resourceSpecific permissions** in our Teams app manifest. They only apply inside the team/chat where the app is installed.

**Para sa channels (team scope):**

- `ChannelMessage.Read.Group` (Application) - tumanggap ng lahat ng channel message nang walang @mention
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**Para sa group chats:**

- `ChatMessage.Read.Chat` (Application) - tumanggap ng lahat ng group chat message nang walang @mention

## Halimbawa ng Teams Manifest (tinanggal ang sensitibo)

Minimal, valid example with the required fields. Replace IDs and URLs.

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### Mga paalala sa manifest (mga kailangang-kailangan)

- Ang `bots[].botId` ay **dapat** tumugma sa Azure Bot App ID.
- Ang `webApplicationInfo.id` ay **dapat** tumugma sa Azure Bot App ID.
- Dapat isama ng `bots[].scopes` ang mga surface na balak mong gamitin (`personal`, `team`, `groupChat`).
- Kinakailangan ang `bots[].supportsFiles: true` para sa file handling sa personal scope.
- Dapat isama ng `authorization.permissions.resourceSpecific` ang channel read/send kung gusto mo ng channel traffic.

### Pag-update ng umiiral na app

Para i-update ang isang naka-install na Teams app (hal., para magdagdag ng mga pahintulot ng RSC):

1. I-update ang iyong `manifest.json` gamit ang mga bagong setting
2. **Itaas ang field na `version`** (hal., `1.0.0` → `1.1.0`)
3. **I-re-zip** ang manifest kasama ang mga icon (`manifest.json`, `outline.png`, `color.png`)
4. I-upload ang bagong zip:
   - **Opsyon A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → hanapin ang iyong app → Upload new version
   - **Opsyon B (Sideload):** Sa Teams → Apps → Manage your apps → Upload a custom app
5. **Para sa team channels:** I-reinstall ang app sa bawat team para magkabisa ang mga bagong pahintulot
6. **Ganap na isara at muling buksan ang Teams** (hindi lang isara ang window) para linisin ang cached app metadata

## Mga kakayahan: RSC lang vs Graph

### Gamit ang **Teams RSC lang** (naka-install ang app, walang pahintulot ng Graph API)

Gumagana:

- Basahin ang **text** na nilalaman ng channel message.
- Magpadala ng **text** na nilalaman ng channel message.
- Tumanggap ng **personal (DM)** file attachments.

Hindi gumagana:

- **Larawan o file contents** sa channel/group (HTML stub lang ang laman ng payload).
- Pag-download ng mga attachment na naka-store sa SharePoint/OneDrive.
- Pagbasa ng message history (lampas sa live webhook event).

### Gamit ang **Teams RSC + Microsoft Graph Application permissions**

Dagdag:

- Pag-download ng hosted contents (mga larawang idinikit sa mga mensahe).
- Pag-download ng mga file attachment na naka-store sa SharePoint/OneDrive.
- Pagbasa ng channel/chat message history sa pamamagitan ng Graph.

### RSC vs Graph API

| Kakayahan               | RSC Permissions                            | Graph API                                               |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------- |
| **Real-time messages**  | Oo (via webhook)        | Hindi (polling lang)                 |
| **Historical messages** | Hindi                                      | Oo (maaaring mag-query ng history)   |
| **Setup complexity**    | App manifest lang                          | Nangangailangan ng admin consent + token flow           |
| **Works offline**       | Hindi (dapat tumatakbo) | Oo (maaaring mag-query anumang oras) |

**Bottom line:** RSC is for real-time listening; Graph API is for historical access. For catching up on missed messages while offline, you need Graph API with `ChannelMessage.Read.All` (requires admin consent).

## Media + history na may Graph (kinakailangan para sa channels)

Kung kailangan mo ng mga larawan/file sa **channels** o gusto mong kunin ang **message history**, kailangan mong i-enable ang mga pahintulot ng Microsoft Graph at magbigay ng admin consent.

1. Sa Entra ID (Azure AD) **App Registration**, magdagdag ng Microsoft Graph **Application permissions**:
   - `ChannelMessage.Read.All` (channel attachments + history)
   - `Chat.Read.All` o `ChatMessage.Read.All` (group chats)
2. **Magbigay ng admin consent** para sa tenant.
3. Itaas ang Teams app **manifest version**, i-re-upload, at **i-reinstall ang app sa Teams**.
4. **Ganap na isara at muling buksan ang Teams** para linisin ang cached app metadata.

## Mga Kilalang Limitasyon

### Mga timeout ng webhook

Teams delivers messages via HTTP webhook. If processing takes too long (e.g., slow LLM responses), you may see:

- Mga timeout ng gateway
- Pagre-retry ng Teams sa mensahe (nagiging sanhi ng mga duplicate)
- Mga nawawalang reply

Hinahawakan ito ng OpenClaw sa pamamagitan ng mabilis na pagbabalik at proaktibong pagpapadala ng mga reply, ngunit ang napakabagal na mga tugon ay maaari pa ring magdulot ng isyu.

### Pag-format

Mas limitado ang Teams markdown kaysa Slack o Discord:

- Gumagana ang basic formatting: **bold**, _italic_, `code`, mga link
- Ang komplikadong markdown (mga table, nested lists) ay maaaring hindi mag-render nang tama
- Sinusuportahan ang Adaptive Cards para sa mga poll at arbitrary na pagpapadala ng card (tingnan sa ibaba)

## Konpigurasyon

Mga key setting (tingnan ang `/gateway/configuration` para sa shared channel patterns):

- `channels.msteams.enabled`: i-enable/i-disable ang channel.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: mga kredensyal ng bot.
- `channels.msteams.webhook.port` (default `3978`)
- `channels.msteams.webhook.path` (default `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (default: pairing)
- `channels.msteams.allowFrom`: allowlist for DMs (AAD object IDs, UPNs, or display names). The wizard resolves names to IDs during setup when Graph access is available.
- `channels.msteams.textChunkLimit`: outbound text chunk size.
- `channels.msteams.chunkMode`: `length` (default) o `newline` para hatiin sa mga blank line (mga hangganan ng talata) bago ang length chunking.
- `channels.msteams.mediaAllowHosts`: allowlist para sa inbound attachment hosts (default sa mga domain ng Microsoft/Teams).
- `channels.msteams.mediaAuthAllowHosts`: allowlist para sa pag-attach ng Authorization headers sa media retries (default sa mga host ng Graph + Bot Framework).
- `channels.msteams.requireMention`: mangailangan ng @mention sa channels/groups (default true).
- `channels.msteams.replyStyle`: `thread | top-level` (tingnan ang [Reply Style](#reply-style-threads-vs-posts)).
- `channels.msteams.teams.<teamId>.replyStyle`: per-team override.
- `channels.msteams.teams.<teamId>.requireMention`: per-team override.
- `channels.msteams.teams.<teamId>.tools`: default per-team tool policy overrides (`allow`/`deny`/`alsoAllow`) used when a channel override is missing.
- `channels.msteams.teams.<teamId>.toolsBySender`: default per-team per-sender tool policy overrides (`"*"` wildcard supported).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: per-channel override.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: override kada channel.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: per-channel per-sender tool policy overrides (`"*"` wildcard supported).
- `channels.msteams.sharePointSiteId`: SharePoint site ID para sa file uploads sa group chats/channels (tingnan ang [Sending files in group chats](#sending-files-in-group-chats)).

## Routing & Sessions

- Sumusunod ang mga session key sa standard agent format (tingnan ang [/concepts/session](/concepts/session)):
  - Ang mga direct message ay nagbabahagi ng pangunahing session (`agent:<agentId>:<mainKey>`).
  - Ang mga channel/group message ay gumagamit ng conversation id:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Reply Style: Threads vs Posts

Kamakailan ay nagpakilala ang Teams ng dalawang channel UI style sa parehong underlying data model:

| Style                                         | Paglalarawan                                                                | Inirerekomendang `replyStyle`         |
| --------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------- |
| **Posts** (classic)        | Lumalabas ang mga mensahe bilang mga card na may threaded replies sa ilalim | `thread` (default) |
| **Threads** (parang Slack) | Dumadaloy ang mga mensahe nang linear, mas katulad ng Slack                 | `top-level`                           |

**The problem:** The Teams API does not expose which UI style a channel uses. If you use the wrong `replyStyle`:

- `thread` sa isang Threads-style channel → lumalabas ang mga reply na awkward na nested
- `top-level` sa isang Posts-style channel → lumalabas ang mga reply bilang hiwalay na top-level post sa halip na in-thread

**Solusyon:** I-configure ang `replyStyle` per-channel batay sa kung paano naka-set up ang channel:

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## Mga Attachment at Larawan

**Kasalukuyang mga limitasyon:**

- **DMs:** Gumagana ang mga larawan at file attachment sa pamamagitan ng Teams bot file APIs.
- **Channels/groups:** Attachments live in M365 storage (SharePoint/OneDrive). The webhook payload only includes an HTML stub, not the actual file bytes. **Kailangan ang mga pahintulot ng Graph API** upang ma-download ang mga attachment ng channel.

Without Graph permissions, channel messages with images will be received as text-only (the image content is not accessible to the bot).
Bilang default, nagda-download lamang ang OpenClaw ng media mula sa mga hostname ng Microsoft/Teams. Override with `channels.msteams.mediaAllowHosts` (use `["*"]` to allow any host).
Authorization headers are only attached for hosts in `channels.msteams.mediaAuthAllowHosts` (defaults to Graph + Bot Framework hosts). Keep this list strict (avoid multi-tenant suffixes).

## Pagpapadala ng mga file sa group chats

Bots can send files in DMs using the FileConsentCard flow (built-in). Gayunpaman, **ang pagpapadala ng mga file sa mga group chat/channel** ay nangangailangan ng karagdagang setup:

| Konteksto                                              | Paano ipinapadala ang mga file                              | Kinakailangang setup                                            |
| ------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------- |
| **DMs**                                                | FileConsentCard → tatanggap ang user → mag-a-upload ang bot | Gumagana kaagad                                                 |
| **Group chats/channels**                               | Upload sa SharePoint → share link                           | Nangangailangan ng `sharePointSiteId` + mga pahintulot ng Graph |
| **Mga larawan (anumang konteksto)** | Base64-encoded inline                                       | Gumagana kaagad                                                 |

### Bakit kailangan ng SharePoint ang group chats

Bots don't have a personal OneDrive drive (the `/me/drive` Graph API endpoint doesn't work for application identities). To send files in group chats/channels, the bot uploads to a **SharePoint site** and creates a sharing link.

### Setup

1. **Magdagdag ng mga pahintulot ng Graph API** sa Entra ID (Azure AD) → App Registration:
   - `Sites.ReadWrite.All` (Application) - mag-upload ng mga file sa SharePoint
   - `Chat.Read.All` (Application) - opsyonal, pinapagana ang per-user sharing links

2. **Magbigay ng admin consent** para sa tenant.

3. **Kunin ang iyong SharePoint site ID:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **I-configure ang OpenClaw:**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### Pag-uugali ng sharing

| Pahintulot                              | Pag-uugali ng sharing                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Sites.ReadWrite.All` lamang            | Organization-wide sharing link (maaaring ma-access ng sinuman sa org) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Per-user sharing link (tanging mga miyembro ng chat ang may access)   |

Per-user sharing is more secure as only the chat participants can access the file. If `Chat.Read.All` permission is missing, the bot falls back to organization-wide sharing.

### Fallback na pag-uugali

| Senaryo                                                   | Resulta                                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Group chat + file + naka-configure ang `sharePointSiteId` | Upload sa SharePoint, magpadala ng sharing link                                               |
| Group chat + file + walang `sharePointSiteId`             | Subukang mag-upload sa OneDrive (maaaring pumalya), magpadala ng text lang |
| Personal chat + file                                      | FileConsentCard flow (gumagana nang walang SharePoint)                     |
| Anumang konteksto + larawan                               | Base64-encoded inline (gumagana nang walang SharePoint)                    |

### Lokasyon ng pag-iimbak ng mga file

Ang mga na-upload na file ay iniimbak sa isang `/OpenClawShared/` na folder sa default document library ng naka-configure na SharePoint site.

## Mga Poll (Adaptive Cards)

Ipinapadala ng OpenClaw ang mga Teams poll bilang Adaptive Cards (walang native Teams poll API).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- Ang mga boto ay itinatala ng gateway sa `~/.openclaw/msteams-polls.json`.
- Kailangang manatiling online ang gateway para maitala ang mga boto.
- Hindi pa awtomatikong nagpo-post ng mga buod ng resulta ang mga poll (suriin ang store file kung kinakailangan).

## Adaptive Cards (arbitrary)

Magpadala ng anumang Adaptive Card JSON sa mga Teams user o conversation gamit ang tool o CLI na `message`.

The `card` parameter accepts an Adaptive Card JSON object. When `card` is provided, the message text is optional.

**Agent tool:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

See [Adaptive Cards documentation](https://adaptivecards.io/) for card schema and examples. For target format details, see [Target formats](#target-formats) below.

## Target formats

Gumagamit ang mga target ng MSTeams ng mga prefix para makilala ang pagitan ng mga user at conversation:

| Uri ng target                          | Format                           | Halimbawa                                                                     |
| -------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| User (by ID)        | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                                   |
| User (by name)      | `user:<display-name>`            | `user:John Smith` (nangangailangan ng Graph API)           |
| Group/channel                          | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                                      |
| Group/channel (raw) | `<conversation-id>`              | `19:abc123...@thread.tacv2` (kung naglalaman ng `@thread`) |

**Mga halimbawa ng CLI:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**Mga halimbawa ng agent tool:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

Note: Without the `user:` prefix, names default to group/team resolution. Always use `user:` when targeting people by display name.

## Proactive messaging

- Posible lamang ang mga proactive message **pagkatapos** makipag-interact ang user, dahil iniimbak namin ang mga conversation reference sa puntong iyon.
- Tingnan ang `/gateway/configuration` para sa `dmPolicy` at allowlist gating.

## Mga Team at Channel ID (Karaniwang Pagkakamali)

The `groupId` query parameter in Teams URLs is **NOT** the team ID used for configuration. 1. Kunin ang mga ID mula sa URL path sa halip:

**Team URL:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**Channel URL:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**Para sa config:**

- Team ID = path segment pagkatapos ng `/team/` (URL-decoded, hal., `19:Bk4j...@thread.tacv2`)
- Channel ID = path segment pagkatapos ng `/channel/` (URL-decoded)
- **Balewalain** ang query parameter na `groupId`

## Private Channels

May limitadong suporta ang mga bot sa private channels:

| Feature                                         | Standard Channels | Private Channels                       |
| ----------------------------------------------- | ----------------- | -------------------------------------- |
| Pag-install ng bot                              | Oo                | Limitado                               |
| Real-time messages (webhook) | Oo                | Maaaring hindi gumana                  |
| RSC permissions                                 | Oo                | Maaaring iba ang asal                  |
| @mentions                          | Oo                | Kung naa-access ang bot                |
| Graph API history                               | Oo                | Oo (may pahintulot) |

**Mga workaround kung hindi gumana ang private channels:**

1. Gumamit ng standard channels para sa pakikipag-ugnayan sa bot
2. Gumamit ng DMs - palaging maaaring i-message ng mga user ang bot nang direkta
3. Gumamit ng Graph API para sa historical access (nangangailangan ng `ChannelMessage.Read.All`)

## Pag-troubleshoot

### Mga karaniwang isyu

- 2. **Hindi lumalabas ang mga larawan sa mga channel:** Kulang ang Graph permissions o wala ang admin consent. 3. I-reinstall ang Teams app at tuluyang isara/buksan muli ang Teams.
- **Walang tugon sa channel:** kinakailangan ang mga mention bilang default; itakda ang `channels.msteams.requireMention=false` o i-configure per team/channel.
- **Hindi tugma ang bersyon (ipinapakita pa rin ng Teams ang lumang manifest):** alisin + idagdag muli ang app at ganap na isara ang Teams para mag-refresh.
- 4. **401 Unauthorized mula sa webhook:** Inaasahan ito kapag manu-manong nagte-test nang walang Azure JWT — ibig sabihin ay naaabot ang endpoint pero nabigo ang authentication. 5. Gamitin ang Azure Web Chat para maayos na mag-test.

### Mga error sa pag-upload ng manifest

- 6. **"Icon file cannot be empty":** Ang manifest ay tumutukoy sa mga icon file na 0 bytes ang laki. 7. Gumawa ng wastong PNG icons (32x32 para sa `outline.png`, 192x192 para sa `color.png`).
- 8. **"webApplicationInfo.Id already in use":** Naka-install pa rin ang app sa ibang team/chat. 9. Hanapin at i-uninstall muna ito, o maghintay ng 5–10 minuto para sa propagation.
- **"Something went wrong" sa pag-upload:** Mag-upload sa [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) sa halip, buksan ang browser DevTools (F12) → Network tab, at suriin ang response body para sa aktuwal na error.
- **Pumapalya ang sideload:** Subukan ang "Upload an app to your org's app catalog" sa halip na "Upload a custom app" - madalas nitong nalalampasan ang mga restriksyon sa sideload.

### Hindi gumagana ang mga pahintulot ng RSC

1. Tiyaking tumutugma nang eksakto ang `webApplicationInfo.id` sa App ID ng iyong bot
2. I-re-upload ang app at i-reinstall sa team/chat
3. Suriin kung hinarangan ng org admin ang mga pahintulot ng RSC
4. Tiyaking ginagamit mo ang tamang scope: `ChannelMessage.Read.Group` para sa teams, `ChatMessage.Read.Chat` para sa group chats

## Mga Sanggunian

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - gabay sa setup ng Azure Bot
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - gumawa/pamahalaan ang mga Teams app
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (nangangailangan ng Graph para sa channel/group)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
