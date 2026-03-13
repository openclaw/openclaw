---
summary: "Multi-agent routing: isolated agents, channel accounts, and bindings"
title: Multi-Agent Routing
read_when: You want multiple isolated agents (workspaces + auth) in one gateway process.
status: active
---

# 多代理路由

目標：在同一個執行中的 Gateway 中，支援多個 _獨立_ 代理（獨立工作區 + `agentDir` + 多個會話），以及多個頻道帳號（例如兩個 WhatsApp）。入站訊息透過綁定路由到指定代理。

## 什麼是「一個代理」？

一個 **代理** 是一個完整範圍的智能體，擁有自己的：

- **工作區**（檔案、AGENTS.md/SOUL.md/USER.md、本地筆記、角色規則）。
- **狀態目錄** (`agentDir`)，用於認證設定檔、模型註冊表及每個代理的設定。
- **會話存儲**（聊天歷史 + 路由狀態），位於 `~/.openclaw/agents/<agentId>/sessions`。

認證設定檔是 **每個代理獨立** 的。每個代理從自己的：

```text
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

主要代理憑證不會自動共享。切勿跨代理重複使用 `agentDir`（會導致認證/會話衝突）。如果想共享憑證，請將 `auth-profiles.json` 複製到另一個代理的 `agentDir`。

技能是透過每個工作區的 `skills/` 資料夾為每個代理獨立管理，且可從 `~/.openclaw/skills` 取得共用技能。詳見 [技能：每代理 vs 共用](/tools/skills#per-agent-vs-shared-skills)。

Gateway 可以同時承載 **一個代理**（預設）或 **多個代理** 並列執行。

**工作區說明：** 每個代理的工作區是 **預設工作目錄**，而非嚴格沙箱。相對路徑會解析到工作區內，但絕對路徑可存取其他主機位置，除非啟用沙箱。詳見 [沙箱機制](/gateway/sandboxing)。

## 路徑（快速對照）

- 設定檔：`~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）
- 狀態目錄：`~/.openclaw`（或 `OPENCLAW_STATE_DIR`）
- 工作區：`~/.openclaw/workspace`（或 `~/.openclaw/workspace-<agentId>`）
- 代理目錄：`~/.openclaw/agents/<agentId>/agent`（或 `agents.list[].agentDir`）
- 會話：`~/.openclaw/agents/<agentId>/sessions`

### 單代理模式（預設）

如果不做任何設定，OpenClaw 將執行單一代理：

- `agentId` 預設為 **`main`**。
- 會話以 `agent:main:<mainKey>` 作為鍵值。
- 工作區預設為 `~/.openclaw/workspace`（當設定了 `OPENCLAW_PROFILE` 時則為 `~/.openclaw/workspace-<profile>`）。
- 狀態預設為 `~/.openclaw/agents/main/agent`。

## 代理助手

使用代理精靈新增一個獨立代理：

```bash
openclaw agents add work
```

接著新增 `bindings`（或讓精靈自動完成）以路由進站訊息。

透過以下指令驗證：

```bash
openclaw agents list --bindings
```

## 快速開始

<Steps>
  <Step title="建立每個代理的工作區">

使用精靈或手動建立工作區：

```bash
openclaw agents add coding
openclaw agents add social
```

每個代理擁有自己的工作區，包含 `SOUL.md`、`AGENTS.md`，以及可選的 `USER.md`，還有專屬的 `agentDir` 和位於 `~/.openclaw/agents/<agentId>` 下的會話存儲。

</Step>

<Step title="建立頻道帳號">

在您偏好的頻道上，為每個代理建立一個帳號：

- Discord：每個代理人一個機器人，啟用訊息內容權限，複製每個 token。
- Telegram：每個代理人透過 BotFather 建立一個機器人，複製每個 token。
- WhatsApp：每個帳號綁定一個電話號碼。

```bash
openclaw channels login --channel whatsapp --account work
```

請參考頻道指南：[Discord](/channels/discord)、[Telegram](/channels/telegram)、[WhatsApp](/channels/whatsapp)。

</Step>

<Step title="新增代理人、帳號與綁定">

在 `agents.list` 下新增代理人，在 `channels.<channel>.accounts` 下新增頻道帳號，並透過 `bindings` 連接它們（以下為範例）。

</Step>

<Step title="重新啟動並驗證">

```bash
openclaw gateway restart
openclaw agents list --bindings
openclaw channels status --probe
```

</Step>
</Steps>

## 多代理人 = 多人、多重人格

使用 **多代理人** 時，每個 `agentId` 都會成為一個 **完全獨立的人格**：

- **不同的電話號碼/帳號**（每個頻道 `accountId`）。
- **不同的人格特質**（每個代理人的工作區檔案，如 `AGENTS.md` 和 `SOUL.md`）。
- **獨立的認證與會話**（除非明確啟用，否則不會交叉通話）。

這讓 **多個使用者** 可以共用同一個 Gateway 伺服器，同時保持他們的 AI「大腦」與資料隔離。

## 一個 WhatsApp 號碼，多人使用（私訊分流）

您可以在 **同一個 WhatsApp 帳號** 下，將 **不同的 WhatsApp 私訊** 分派給不同的客服人員。根據發送者的 E.164 格式（例如 `+15551234567`）與 `peer.kind: "direct"` 進行匹配。回覆訊息仍會從相同的 WhatsApp 號碼發出（不會有每位客服人員獨立的發送者身份）。

重要細節：直接聊天會合併到客服人員的 **主要會話金鑰**，因此真正的隔離需要 **一人對應一客服**。

範例：

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    {
      agentId: "alex",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230001" } },
    },
    {
      agentId: "mia",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230002" } },
    },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

備註：

- 私訊的存取控制是 **全域針對 WhatsApp 帳號**（配對/允許清單），而非針對單一客服人員。
- 對於共用群組，請將群組綁定給一位客服人員，或使用 [廣播群組](/channels/broadcast-groups)。

## 路由規則（訊息如何選擇客服人員）

綁定是 **確定性的**，且 **最具體的規則優先**：

1. `peer` 匹配（精確的私訊/群組/頻道 ID）
2. `parentPeer` 匹配（討論串繼承）
3. `guildId + roles`（Discord 角色路由）
4. `guildId`（Discord）
5. `teamId`（Slack）
6. `accountId` 頻道匹配
7. 頻道層級匹配（`accountId: "*"`）
8. 備援到預設客服人員（`agents.list[].default`，否則為清單第一筆，預設為 `main`）

若同一層級有多個綁定匹配，則以設定檔中排序最前者為準。
若綁定設定多個匹配欄位（例如 `peer` + `guildId`），則所有指定欄位皆須符合（`AND` 語意）。

重要的帳號範圍細節：

- 若綁定省略 `accountId`，則只匹配預設帳號。
- 使用 `accountId: "*"` 可設定跨所有帳號的頻道層級備援。
- 若之後為同一客服人員新增相同綁定且明確指定帳號 ID，OpenClaw 會將原本僅限頻道的綁定升級為帳號範圍，而非重複新增。

## 多帳號 / 多電話號碼

支援 **多帳號** 的頻道（例如 WhatsApp）使用 `accountId` 來識別每個登入。每個 `accountId` 可分派給不同客服人員，因此一台伺服器可同時管理多個電話號碼且不會混淆會話。

若想在省略 `accountId` 時設定頻道層級的預設帳號，可設定 `channels.<channel>.defaultAccount`（選填）。若未設定，OpenClaw 會回退使用 `default`（若存在），否則使用排序後的第一個已設定帳號 ID。

常見支援此模式的頻道包括：

- `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`
- `irc`, `line`, `googlechat`, `mattermost`, `matrix`, `nextcloud-talk`
- `bluebubbles`, `zalo`, `zalouser`, `nostr`, `feishu`

## 概念

- `agentId`：一個「大腦」（工作區、每個代理的授權、每個代理的會話存儲）。
- `accountId`：一個頻道帳號實例（例如 WhatsApp 帳號 `"personal"` 與 `"biz"`）。
- `binding`：透過 `(channel, accountId, peer)` 以及選擇性的公會/團隊 ID，將進入訊息路由到 `agentId`。
- 直接聊天會合併為 `agent:<agentId>:<mainKey>`（每個代理的「主要」；`session.mainKey`）。

## 平台範例

### 每個代理的 Discord 機器人

每個 Discord 機器人帳號對應唯一的 `accountId`。將每個帳號綁定到代理，並為每個機器人維護允許清單。

```json5
{
  agents: {
    list: [
      { id: "main", workspace: "~/.openclaw/workspace-main" },
      { id: "coding", workspace: "~/.openclaw/workspace-coding" },
    ],
  },
  bindings: [
    { agentId: "main", match: { channel: "discord", accountId: "default" } },
    { agentId: "coding", match: { channel: "discord", accountId: "coding" } },
  ],
  channels: {
    discord: {
      groupPolicy: "allowlist",
      accounts: {
        default: {
          token: "DISCORD_BOT_TOKEN_MAIN",
          guilds: {
            "123456789012345678": {
              channels: {
                "222222222222222222": { allow: true, requireMention: false },
              },
            },
          },
        },
        coding: {
          token: "DISCORD_BOT_TOKEN_CODING",
          guilds: {
            "123456789012345678": {
              channels: {
                "333333333333333333": { allow: true, requireMention: false },
              },
            },
          },
        },
      },
    },
  },
}
```

注意事項：

- 邀請每個機器人加入公會並啟用訊息內容權限（Message Content Intent）。
- Token 存放於 `channels.discord.accounts.<id>.token`（預設帳號可使用 `DISCORD_BOT_TOKEN`）。

### 每個代理的 Telegram 機器人

```json5
{
  agents: {
    list: [
      { id: "main", workspace: "~/.openclaw/workspace-main" },
      { id: "alerts", workspace: "~/.openclaw/workspace-alerts" },
    ],
  },
  bindings: [
    { agentId: "main", match: { channel: "telegram", accountId: "default" } },
    { agentId: "alerts", match: { channel: "telegram", accountId: "alerts" } },
  ],
  channels: {
    telegram: {
      accounts: {
        default: {
          botToken: "123456:ABC...",
          dmPolicy: "pairing",
        },
        alerts: {
          botToken: "987654:XYZ...",
          dmPolicy: "allowlist",
          allowFrom: ["tg:123456789"],
        },
      },
    },
  },
}
```

注意事項：

- 使用 BotFather 為每個代理建立一個機器人並複製各自的 token。
- Token 存放於 `channels.telegram.accounts.<id>.botToken`（預設帳號可使用 `TELEGRAM_BOT_TOKEN`）。

### 每個代理的 WhatsApp 號碼

在啟動閘道前，請先連結每個帳號：

```bash
openclaw channels login --channel whatsapp --account personal
openclaw channels login --channel whatsapp --account biz
```

`~/.openclaw/openclaw.json` (JSON5):

js
{
agents: {
list: [
{
id: "home",
default: true,
name: "Home",
workspace: "~/.openclaw/workspace-home",
agentDir: "~/.openclaw/agents/home/agent",
},
{
id: "work",
name: "Work",
workspace: "~/.openclaw/workspace-work",
agentDir: "~/.openclaw/agents/work/agent",
},
],
},

// 決定性路由：第一個符合條件者勝出（由最具體開始匹配）。
bindings: [
{ agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
{ agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

// 可選的每個對等端覆寫（範例：將特定群組導向 work agent）。
{
agentId: "work",
match: {
channel: "whatsapp",
accountId: "personal",
peer: { kind: "group", id: "1203630...@g.us" },
},
},
],

// 預設關閉：agent 間訊息必須明確啟用且列入允許清單。
tools: {
agentToAgent: {
enabled: false,
allow: ["home", "work"],
},
},

channels: {
whatsapp: {
accounts: {
personal: {
// 可選覆寫。預設路徑：~/.openclaw/credentials/whatsapp/personal
// authDir: "~/.openclaw/credentials/whatsapp/personal",
},
biz: {
// 可選覆寫。預設路徑：~/.openclaw/credentials/whatsapp/biz
// authDir: "~/.openclaw/credentials/whatsapp/biz",
},
},
},
},
}

## 範例：WhatsApp 日常聊天 + Telegram 深度工作

依頻道分流：將 WhatsApp 導向快速的日常代理，Telegram 導向 Opus 代理。

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

注意事項：

- 如果你在同一頻道有多個帳號，請在 binding 中加入 `accountId`（例如 `{ channel: "whatsapp", accountId: "personal" }`）。
- 若要將單一 DM/群組導向 Opus，同時保持其他訊息在 chat，請為該對等端新增 `match.peer` binding；對等端匹配總是優先於整個頻道規則。

## 範例：同一頻道，一個對等端導向 Opus

保持 WhatsApp 使用快速代理，但將一個 DM 導向 Opus：

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    {
      agentId: "opus",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551234567" } },
    },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

Peer 綁定規則永遠優先，因此請將它們置於整個頻道規則之上。

## 家庭代理綁定至 WhatsApp 群組

將專屬的家庭代理綁定至單一 WhatsApp 群組，並搭配提及門檻與更嚴格的工具政策：

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

注意事項：

- 工具允許/拒絕清單是 **工具**，而非技能。如果技能需要執行二進位檔，請確保 `exec` 已被允許，且該二進位檔存在於沙箱中。
- 若需更嚴格的門檻，請設定 `agents.list[].groupChat.mentionPatterns` 並保持群組允許清單在頻道中啟用。

## 每個代理的沙箱與工具設定

從 v2026.1.6 開始，每個代理都可以擁有自己的沙箱與工具限制：

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

注意：`setupCommand` 位於 `sandbox.docker` 之下，並於容器建立時執行一次。
當解析範圍為 `"shared"` 時，會忽略每個代理的 `sandbox.docker.*` 覆寫設定。

**優點：**

- **安全隔離**：限制不受信任代理的工具使用
- **資源控制**：針對特定代理使用沙箱，其他代理則維持在主機上
- **彈性政策**：每個代理可設定不同權限

注意：`tools.elevated` 是 **全域** 且基於發送者，無法針對每個代理設定。
若需要每個代理的邊界，請使用 `agents.list[].tools` 來拒絕 `exec`。
針對群組目標，請使用 `agents.list[].groupChat.mentionPatterns`，讓 @提及 能夠正確對應到指定代理。

詳情範例請參考 [多代理沙箱與工具](/tools/multi-agent-sandbox-tools)。
