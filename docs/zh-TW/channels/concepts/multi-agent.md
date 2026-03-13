---
summary: "Multi-agent routing: isolated agents, channel accounts, and bindings"
title: Multi-Agent Routing
read_when: You want multiple isolated agents (workspaces + auth) in one gateway process.
status: active
---

# 多代理路由

目標：多個 _獨立_ 代理（分開的工作區 + `agentDir` + 會話），以及在一個執行中的 Gateway 中的多個通道帳戶（例如兩個 WhatsApp）。進來的請求通過綁定路由到一個代理。

## 什麼是「一個代理」？

一個 **agent** 是一個完全範疇的智慧體，擁有自己的：

- **工作區**（檔案、AGENTS.md/SOUL.md/USER.md、本地筆記、角色規則）。
- **狀態目錄** (`agentDir`) 用於認證設定檔、模型註冊和每個代理的設定。
- **會話儲存**（聊天歷史 + 路由狀態）位於 `~/.openclaw/agents/<agentId>/sessions`。

Auth profiles 是 **每個代理** 專屬的。每個代理從自己的設定中讀取：

```text
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

主要代理的憑證**不**會自動共享。切勿在代理之間重複使用 `agentDir`（這會導致身份驗證/會話衝突）。如果您想共享憑證，請將 `auth-profiles.json` 複製到另一個代理的 `agentDir` 中。

技能是透過每個工作區的 `skills/` 資料夾來針對每個代理人設定的，共享技能則可以從 `~/.openclaw/skills` 獲得。請參閱 [技能：針對代理人與共享](/tools/skills#per-agent-vs-shared-skills)。

Gateway 可以同時托管 **一個代理**（預設）或 **多個代理**。

**工作區註解：** 每個代理的工作區是 **預設當前工作目錄 (cwd)**，而不是一個硬性沙盒。相對路徑在工作區內解析，但絕對路徑可以到達其他主機位置，除非啟用沙盒功能。請參見 [沙盒](/gateway/sandboxing)。

## 路徑 (快速地圖)

- 設定: `~/.openclaw/openclaw.json` (或 `OPENCLAW_CONFIG_PATH`)
- 狀態目錄: `~/.openclaw` (或 `OPENCLAW_STATE_DIR`)
- 工作區: `~/.openclaw/workspace` (或 `~/.openclaw/workspace-<agentId>`)
- 代理目錄: `~/.openclaw/agents/<agentId>/agent` (或 `agents.list[].agentDir`)
- 會話: `~/.openclaw/agents/<agentId>/sessions`

### 單代理模式（預設）

如果您什麼都不做，OpenClaw 將執行一個單一的代理：

- `agentId` 預設為 **`main`**。
- 會話的鍵值為 `agent:main:<mainKey>`。
- 工作區預設為 `~/.openclaw/workspace`（或當 `OPENCLAW_PROFILE` 設定時為 `~/.openclaw/workspace-<profile>`）。
- 狀態預設為 `~/.openclaw/agents/main/agent`。

## Agent helper

使用代理精靈新增一個獨立的代理：

```bash
openclaw agents add work
```

然後將 `bindings`（或讓精靈自動添加）以路由進來的訊息。

[[INLINE_1]]

```bash
openclaw agents list --bindings
```

## 快速入門

<Steps>
  <Step title="建立每個代理工作區">

使用精靈或手動創建工作區：

```bash
openclaw agents add coding
openclaw agents add social
```

每個代理都有自己的工作區，包括 `SOUL.md`、`AGENTS.md` 和可選的 `USER.md`，此外還有專用的 `agentDir` 和位於 `~/.openclaw/agents/<agentId>` 下的會話存儲。

</Step>

<Step title="建立頻道帳戶">

在您偏好的渠道上為每位代理創建一個帳戶：

- Discord: 每個代理一個機器人，啟用訊息內容意圖，複製每個 token。
- Telegram: 每個代理透過 BotFather 創建一個機器人，複製每個 token。
- WhatsApp: 每個帳號連結一個電話號碼。

```bash
openclaw channels login --channel whatsapp --account work
```

查看頻道指南：[Discord](/channels/discord)、[Telegram](/channels/telegram)、[WhatsApp](/channels/whatsapp)。

</Step>

<Step title="新增代理、帳戶和綁定">

在 `agents.list` 下新增代理，於 `channels.<channel>.accounts` 下新增通道帳戶，並使用 `bindings` 將它們連接起來（以下是範例）。

</Step>

<Step title="重新啟動並驗證">

```bash
openclaw gateway restart
openclaw agents list --bindings
openclaw channels status --probe
```

</Step>
</Steps>

## 多個代理 = 多個人，多種個性

有了 **多個代理**，每個 `agentId` 都成為一個 **完全獨立的角色**：

- **不同的電話號碼/帳戶**（依通道 `accountId`）。
- **不同的個性**（依代理工作區檔案，如 `AGENTS.md` 和 `SOUL.md`）。
- **獨立的身份驗證 + 會話**（除非明確啟用，否則不會互相通訊）。

這讓 **多個人** 可以共享一個 Gateway 伺服器，同時保持他們的 AI “大腦”和數據的隔離。

## 一個 WhatsApp 號碼，多個人（DM 分割）

您可以將 **不同的 WhatsApp 直接訊息** 路由到不同的代理商，同時保持在 **一個 WhatsApp 帳號** 上。根據發件人 E.164（如 `+15551234567`）與 `peer.kind: "direct"` 進行匹配。回覆仍然來自相同的 WhatsApp 號碼（沒有每位代理商的發件人身份）。

重要細節：直接聊天會折疊到代理的 **主要會話金鑰**，因此真正的隔離需要 **每個人一個代理**。

[[BLOCK_1]]  
範例：  
[[BLOCK_1]]

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

Notes:

- DM 存取控制是 **針對每個 WhatsApp 帳號的全域設定**（配對/允許清單），而不是針對每個代理。
- 對於共享群組，將群組綁定到一個代理或使用 [廣播群組](/channels/broadcast-groups)。

## 路由規則（訊息如何選擇代理）

Bindings 是 **確定性的** 且 **最具特異性的勝出**：

1. `peer` 匹配（精確的 DM/群組/頻道 ID）
2. `parentPeer` 匹配（線程繼承）
3. `guildId + roles` （Discord 角色路由）
4. `guildId` （Discord）
5. `teamId` （Slack）
6. `accountId` 匹配頻道
7. 頻道層級匹配 (`accountId: "*"`)
8. 回退到預設代理 (`agents.list[].default`，否則使用第一個列表專案，預設：`main`)

如果在同一層級中有多個綁定匹配，則設定順序中的第一個將獲勝。 如果一個綁定設置了多個匹配欄位（例如 `peer` + `guildId`），則所有指定的欄位都是必需的 (`AND` 語義)。

重要的帳戶範圍細節：

- 一個省略 `accountId` 的綁定僅匹配預設帳戶。
- 使用 `accountId: "*"` 來實現所有帳戶的頻道範圍回退。
- 如果您稍後為同一代理添加相同的綁定並指定帳戶 ID，OpenClaw 將把現有的僅限頻道的綁定升級為帳戶範圍的綁定，而不是重複它。

## 多個帳戶 / 電話號碼

支援 **多個帳戶** 的通道（例如 WhatsApp）使用 `accountId` 來識別每個登入。每個 `accountId` 可以路由到不同的代理，因此一台伺服器可以在不混合會話的情況下托管多個電話號碼。

如果您希望在省略 `accountId` 時使用頻道範圍的預設帳戶，請設置 `channels.<channel>.defaultAccount`（可選）。當未設置時，OpenClaw 會回退到 `default`（如果存在），否則使用第一個已設定的帳戶 ID（按排序）。

常見的支援此模式的通道包括：

- `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`
- `irc`, `line`, `googlechat`, `mattermost`, `matrix`, `nextcloud-talk`
- `bluebubbles`, `zalo`, `zalouser`, `nostr`, `feishu`

## 概念

- `agentId`: 一個「大腦」（工作區、每個代理的授權、每個代理的會話儲存）。
- `accountId`: 一個頻道帳戶實例（例如，WhatsApp 帳戶 `"personal"` 與 `"biz"`）。
- `binding`: 將進來的訊息路由到 `agentId`，透過 `(channel, accountId, peer)` 並可選擇性地使用公會/團隊 ID。
- 直接聊天會合併為 `agent:<agentId>:<mainKey>`（每個代理的「主要」；`session.mainKey`）。

## Platform examples

### Discord 機器人每位代理人

每個 Discord 機器人帳號對應到一個唯一的 `accountId`。將每個帳號綁定到一個代理，並為每個機器人保持允許清單。

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

[[BLOCK_1]]

- 邀請每個機器人進入公會並啟用訊息內容意圖。
- token存放在 `channels.discord.accounts.<id>.token`（預設帳戶可以使用 `DISCORD_BOT_TOKEN`）。

### 每位代理的 Telegram 機器人

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

[[BLOCK_1]]

- 使用 BotFather 為每個代理創建一個機器人並複製每個 token。
- Tokens 存放在 `channels.telegram.accounts.<id>.botToken`（預設帳戶可以使用 `TELEGRAM_BOT_TOKEN`）。

### 每位代理的 WhatsApp 號碼

在啟動網關之前，請先連結每個帳戶：

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
name: "家用",
workspace: "~/.openclaw/workspace-home",
agentDir: "~/.openclaw/agents/home/agent",
},
{
id: "work",
name: "工作",
workspace: "~/.openclaw/workspace-work",
agentDir: "~/.openclaw/agents/work/agent",
},
],
},

// 確定性路由：第一個匹配者獲勝（最具特異性者優先）。
綁定: [
{ agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
{ agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

// 可選的每個對等方覆蓋（範例：將特定群組發送到工作代理）。
{
agentId: "work",
match: {
channel: "whatsapp",
accountId: "personal",
peer: { kind: "group", id: "1203630...@g.us" },
},
},
],

// 預設為關閉：代理之間的訊息傳遞必須明確啟用並列入允許清單。
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
// 可選的覆寫。預設值: ~/.openclaw/credentials/whatsapp/personal
// authDir: "~/.openclaw/credentials/whatsapp/personal",
},
biz: {
// 可選的覆寫。預設值: ~/.openclaw/credentials/whatsapp/biz
// authDir: "~/.openclaw/credentials/whatsapp/biz",
},
},
},
},
}

## 範例：WhatsApp 每日聊天 + Telegram 深度工作

根據渠道分配：將 WhatsApp 路由到快速的日常代理，將 Telegram 路由到 Opus 代理。

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

[[BLOCK_1]]

- 如果您有多個帳戶用於一個頻道，請將 `accountId` 添加到綁定中（例如 `{ channel: "whatsapp", accountId: "personal" }`）。
- 若要將單一的 DM/群組路由到 Opus，同時保持其餘的在聊天中，請為該對等方添加 `match.peer` 綁定；對等方的匹配總是優先於頻道範圍的規則。

## 範例：相同頻道，一個對等端到 Opus

保持 WhatsApp 在快速代理上，但將一條 DM 路由到 Opus：

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

對等綁定總是優先，因此請將它們放在通道範圍規則之上。

## 家庭代理綁定至 WhatsApp 群組

將專用家庭代理綁定到單一的 WhatsApp 群組，並設置提及限制及更嚴格的工具政策：

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

[[BLOCK_1]]

- 工具的允許/拒絕清單是**工具**，而不是技能。如果一項技能需要執行一個二進位檔，請確保 `exec` 被允許，並且該二進位檔存在於沙盒中。
- 若要更嚴格的限制，請設置 `agents.list[].groupChat.mentionPatterns` 並保持該頻道的群組允許清單啟用。

## 每個代理的沙盒和工具設定

從 v2026.1.6 開始，每個代理可以擁有自己的沙盒和工具限制：

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

注意：`setupCommand` 生活在 `sandbox.docker` 之下，並在容器創建時執行一次。每個代理的 `sandbox.docker.*` 覆蓋在解析的範圍為 `"shared"` 時會被忽略。

**好處：**

- **安全隔離**：限制不受信任代理的工具
- **資源控制**：對特定代理進行沙盒處理，同時保持其他代理在主機上
- **靈活的政策**：為每個代理設定不同的權限

注意：`tools.elevated` 是 **全域** 且基於發送者的；它無法針對每個代理進行設定。如果您需要每個代理的邊界，請使用 `agents.list[].tools` 來拒絕 `exec`。對於群組目標，請使用 `agents.list[].groupChat.mentionPatterns` 以便 @提及 能夠清楚地對應到預期的代理。

請參閱 [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) 以獲取詳細範例。
