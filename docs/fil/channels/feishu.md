---
summary: "Pangkalahatang-ideya ng Feishu bot, mga tampok, at konpigurasyon"
read_when:
  - Gusto mong kumonekta ng Feishu/Lark bot
  - Kino-configure mo ang Feishu channel
title: Feishu
x-i18n:
  source_path: channels/feishu.md
  source_hash: c9349983562d1a98
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:40Z
---

# Feishu bot

Ang Feishu (Lark) ay isang team chat platform na ginagamit ng mga kumpanya para sa pagmemensahe at kolaborasyon. Ikinokonekta ng plugin na ito ang OpenClaw sa isang Feishu/Lark bot gamit ang WebSocket event subscription ng platform para makatanggap ng mga mensahe nang hindi kailangang magbukas ng pampublikong webhook URL.

---

## Kailangan na plugin

I-install ang Feishu plugin:

```bash
openclaw plugins install @openclaw/feishu
```

Local checkout (kapag tumatakbo mula sa git repo):

```bash
openclaw plugins install ./extensions/feishu
```

---

## Mabilis na pagsisimula

May dalawang paraan para idagdag ang Feishu channel:

### Paraan 1: onboarding wizard (inirerekomenda)

Kung kakainstall mo lang ng OpenClaw, patakbuhin ang wizard:

```bash
openclaw onboard
```

Gagabayan ka ng wizard sa:

1. Paglikha ng Feishu app at pagkuha ng mga credential
2. Pag-configure ng app credentials sa OpenClaw
3. Pagpapatakbo ng gateway

✅ **Pagkatapos ng konpigurasyon**, i-check ang status ng gateway:

- `openclaw gateway status`
- `openclaw logs --follow`

### Paraan 2: CLI setup

Kung nakumpleto mo na ang initial install, idagdag ang channel via CLI:

```bash
openclaw channels add
```

Piliin ang **Feishu**, pagkatapos ay ilagay ang App ID at App Secret.

✅ **Pagkatapos ng konpigurasyon**, pamahalaan ang gateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Hakbang 1: Gumawa ng Feishu app

### 1. Buksan ang Feishu Open Platform

Bisitahin ang [Feishu Open Platform](https://open.feishu.cn/app) at mag-sign in.

Ang mga Lark (global) tenant ay dapat gumamit ng [https://open.larksuite.com/app](https://open.larksuite.com/app) at itakda ang `domain: "lark"` sa Feishu config.

### 2. Gumawa ng app

1. I-click ang **Create enterprise app**
2. Ilagay ang pangalan at deskripsyon ng app
3. Pumili ng app icon

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. Kopyahin ang mga credential

Mula sa **Credentials & Basic Info**, kopyahin ang:

- **App ID** (format: `cli_xxx`)
- **App Secret**

❗ **Mahalaga:** panatilihing pribado ang App Secret.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. I-configure ang mga permission

Sa **Permissions**, i-click ang **Batch import** at i-paste ang:

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

### 5. I-enable ang bot capability

Sa **App Capability** > **Bot**:

1. I-enable ang bot capability
2. Itakda ang pangalan ng bot

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. I-configure ang event subscription

⚠️ **Mahalaga:** bago mag-set ng event subscription, tiyakin na:

1. Naipatupad mo na ang `openclaw channels add` para sa Feishu
2. Tumatakbo ang gateway (`openclaw gateway status`)

Sa **Event Subscription**:

1. Piliin ang **Use long connection to receive events** (WebSocket)
2. Idagdag ang event: `im.message.receive_v1`

⚠️ Kung hindi tumatakbo ang gateway, maaaring mabigong ma-save ang long-connection setup.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. I-publish ang app

1. Gumawa ng version sa **Version Management & Release**
2. I-submit para sa review at i-publish
3. Maghintay ng admin approval (karaniwang auto-approve ang enterprise apps)

---

## Hakbang 2: I-configure ang OpenClaw

### I-configure gamit ang wizard (inirerekomenda)

```bash
openclaw channels add
```

Piliin ang **Feishu** at i-paste ang iyong App ID at App Secret.

### I-configure via config file

I-edit ang `~/.openclaw/openclaw.json`:

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

### I-configure via environment variables

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark (global) domain

Kung nasa Lark (international) ang iyong tenant, itakda ang domain sa `lark` (o isang buong domain string). Maaari mo itong itakda sa `channels.feishu.domain` o per account (`channels.feishu.accounts.<id>.domain`).

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

## Hakbang 3: Simulan + subukan

### 1. Simulan ang gateway

```bash
openclaw gateway
```

### 2. Magpadala ng test message

Sa Feishu, hanapin ang iyong bot at magpadala ng mensahe.

### 3. Aprubahan ang pairing

Bilang default, sasagot ang bot ng pairing code. Aprubahan ito:

```bash
openclaw pairing approve feishu <CODE>
```

Pagkatapos ng approval, maaari ka nang makipag-chat nang normal.

---

## Pangkalahatang-ideya

- **Feishu bot channel**: Feishu bot na pinamamahalaan ng gateway
- **Deterministic routing**: palaging bumabalik ang mga reply sa Feishu
- **Session isolation**: ang mga DM ay nagbabahagi ng main session; ang mga group ay hiwalay
- **WebSocket connection**: long connection via Feishu SDK, walang kailangang pampublikong URL

---

## Kontrol sa access

### Direct messages

- **Default**: `dmPolicy: "pairing"` (ang mga hindi kilalang user ay nakakakuha ng pairing code)
- **Aprubahan ang pairing**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Allowlist mode**: itakda ang `channels.feishu.allowFrom` gamit ang mga pinapayagang Open ID

### Group chats

**1. Group policy** (`channels.feishu.groupPolicy`):

- `"open"` = payagan ang lahat sa mga group (default)
- `"allowlist"` = payagan lamang ang `groupAllowFrom`
- `"disabled"` = i-disable ang mga group message

**2. Pangangailangan ng mention** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = kailangan ng @mention (default)
- `false` = tumugon kahit walang mention

---

## Mga halimbawa ng konpigurasyon ng group

### Payagan ang lahat ng group, kailangan ng @mention (default)

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

### Payagan ang lahat ng group, hindi kailangan ng @mention

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

### Payagan lamang ang mga partikular na user sa mga group

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

## Kumuha ng group/user IDs

### Group IDs (chat_id)

Ang mga Group ID ay ganito ang itsura: `oc_xxx`.

**Paraan 1 (inirerekomenda)**

1. Simulan ang gateway at i-@mention ang bot sa group
2. Patakbuhin ang `openclaw logs --follow` at hanapin ang `chat_id`

**Paraan 2**

Gamitin ang Feishu API debugger para ilista ang mga group chat.

### User IDs (open_id)

Ang mga User ID ay ganito ang itsura: `ou_xxx`.

**Paraan 1 (inirerekomenda)**

1. Simulan ang gateway at mag-DM sa bot
2. Patakbuhin ang `openclaw logs --follow` at hanapin ang `open_id`

**Paraan 2**

Suriin ang mga pairing request para sa user Open IDs:

```bash
openclaw pairing list feishu
```

---

## Mga karaniwang command

| Command   | Deskripsyon               |
| --------- | ------------------------- |
| `/status` | Ipakita ang status ng bot |
| `/reset`  | I-reset ang session       |
| `/model`  | Ipakita/palitan ang model |

> Tala: Hindi pa sinusuportahan ng Feishu ang native command menus, kaya kailangang ipadala ang mga command bilang text.

## Mga command sa pamamahala ng Gateway

| Command                    | Deskripsyon                           |
| -------------------------- | ------------------------------------- |
| `openclaw gateway status`  | Ipakita ang status ng gateway         |
| `openclaw gateway install` | I-install/simulan ang gateway service |
| `openclaw gateway stop`    | Ihinto ang gateway service            |
| `openclaw gateway restart` | I-restart ang gateway service         |
| `openclaw logs --follow`   | I-tail ang gateway logs               |

---

## Pag-troubleshoot

### Hindi sumasagot ang bot sa mga group chat

1. Tiyaking idinagdag ang bot sa group
2. Tiyaking i-@mention ang bot (default na behavior)
3. Suriin na ang `groupPolicy` ay hindi nakatakda sa `"disabled"`
4. Suriin ang logs: `openclaw logs --follow`

### Hindi tumatanggap ng mga mensahe ang bot

1. Tiyaking na-publish at naaprubahan ang app
2. Tiyaking kasama sa event subscription ang `im.message.receive_v1`
3. Tiyaking naka-enable ang **long connection**
4. Tiyaking kumpleto ang mga permission ng app
5. Tiyaking tumatakbo ang gateway: `openclaw gateway status`
6. Suriin ang logs: `openclaw logs --follow`

### Pag-leak ng App Secret

1. I-reset ang App Secret sa Feishu Open Platform
2. I-update ang App Secret sa iyong config
3. I-restart ang gateway

### Mga failure sa pagpapadala ng mensahe

1. Tiyaking may permission na `im:message:send_as_bot` ang app
2. Tiyaking na-publish ang app
3. Suriin ang logs para sa detalyadong error

---

## Advanced na konpigurasyon

### Maramihang account

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

### Mga limit ng mensahe

- `textChunkLimit`: outbound text chunk size (default: 2000 chars)
- `mediaMaxMb`: limit ng pag-upload/pag-download ng media (default: 30MB)

### Streaming

Sinusuportahan ng Feishu ang streaming replies via interactive cards. Kapag naka-enable, ina-update ng bot ang isang card habang bumubuo ng text.

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

Itakda ang `streaming: false` para maghintay ng buong reply bago magpadala.

### Multi-agent routing

Gamitin ang `bindings` para i-route ang mga Feishu DM o group sa iba’t ibang agent.

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

Mga field ng routing:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` o `"group"`
- `match.peer.id`: user Open ID (`ou_xxx`) o group ID (`oc_xxx`)

Tingnan ang [Get group/user IDs](#get-groupuser-ids) para sa mga tip sa pag-lookup.

---

## Sanggunian ng konpigurasyon

Buong konpigurasyon: [Gateway configuration](/gateway/configuration)

Mga pangunahing opsyon:

| Setting                                           | Deskripsyon                        | Default   |
| ------------------------------------------------- | ---------------------------------- | --------- |
| `channels.feishu.enabled`                         | I-enable/i-disable ang channel     | `true`    |
| `channels.feishu.domain`                          | API domain (`feishu` o `lark`)     | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                             | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                         | -         |
| `channels.feishu.accounts.<id>.domain`            | Per-account API domain override    | `feishu`  |
| `channels.feishu.dmPolicy`                        | DM policy                          | `pairing` |
| `channels.feishu.allowFrom`                       | DM allowlist (open_id list)        | -         |
| `channels.feishu.groupPolicy`                     | Group policy                       | `open`    |
| `channels.feishu.groupAllowFrom`                  | Group allowlist                    | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | Kailangan ng @mention              | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | I-enable ang group                 | `true`    |
| `channels.feishu.textChunkLimit`                  | Laki ng message chunk              | `2000`    |
| `channels.feishu.mediaMaxMb`                      | Limit ng laki ng media             | `30`      |
| `channels.feishu.streaming`                       | I-enable ang streaming card output | `true`    |
| `channels.feishu.blockStreaming`                  | I-enable ang block streaming       | `true`    |

---

## Sanggunian ng dmPolicy

| Value         | Behavior                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------- |
| `"pairing"`   | **Default.** Ang mga hindi kilalang user ay nakakakuha ng pairing code; kailangang aprubahan |
| `"allowlist"` | Tanging ang mga user sa `allowFrom` lang ang maaaring makipag-chat                           |
| `"open"`      | Payagan ang lahat ng user (kailangan ang `"*"` sa allowFrom)                                 |
| `"disabled"`  | I-disable ang mga DM                                                                         |

---

## Mga sinusuportahang uri ng mensahe

### Tanggap

- ✅ Text
- ✅ Rich text (post)
- ✅ Images
- ✅ Files
- ✅ Audio
- ✅ Video
- ✅ Stickers

### Padala

- ✅ Text
- ✅ Images
- ✅ Files
- ✅ Audio
- ⚠️ Rich text (bahagyang suporta)
