```
---
summary: "多代理路由：隔離的代理、頻道帳戶和綁定"
title: 多代理路由
read_when: "您希望在一個 Gateway 程式中擁有多個隔離的代理（工作區 + 憑證）。"
status: active
---

# 多代理路由

目標：在一個執行中的 Gateway 中，擁有多個_隔離的_代理（獨立的工作區 + `agentDir` + 工作階段），以及多個頻道帳戶（例如兩個 WhatsApp 帳戶）。傳入的訊息會透過綁定路由到代理。

## 什麼是「一個代理」？

**代理**是一個功能完整的智慧代理，擁有自己的：

- **工作區**（檔案、AGENTS.md/SOUL.md/USER.md、本地筆記、角色規則）。
- **狀態目錄**（`agentDir`），用於憑證設定檔、模型註冊和每個代理的設定。
- **工作階段儲存區**（聊天記錄 + 路由狀態），位於 `~/.openclaw/agents/<agentId>/sessions`。

憑證設定檔是**每個代理**獨立的。每個代理從自己的路徑讀取：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

主要代理憑證**不會**自動共享。切勿在代理之間重複使用 `agentDir`（這會導致憑證/工作階段衝突）。如果您想共享憑證，請將 `auth-profiles.json` 複製到其他代理的 `agentDir` 中。

Skills 透過每個工作區的 `skills/` 資料夾實現每個代理獨立，共享的 Skills 可從 `~/.openclaw/skills` 取得。請參閱 [Skills：每個代理獨立與共享](/tools/skills#per-agent-vs-shared-skills)。

Gateway 可以託管**一個代理**（預設）或**多個代理**並行。

**工作區注意事項：** 每個代理的工作區是**預設的目前工作目錄 (cwd)**，而非嚴格的沙箱。相對路徑在工作區內解析，但絕對路徑可以存取其他主機位置，除非啟用沙箱隔離。請參閱 [沙箱隔離](/gateway/sandboxing)。

## 路徑（快速對應）

- 設定：`~/.openclaw/openclaw.json` (或 `OPENCLAW_CONFIG_PATH`)
- 狀態目錄：`~/.openclaw` (或 `OPENCLAW_STATE_DIR`)
- 工作區：`~/.openclaw/workspace` (或 `~/.openclaw/workspace-<agentId>`)
- 代理目錄：`~/.openclaw/agents/<agentId>/agent` (或 `agents.list[].agentDir`)
- 工作階段：`~/.openclaw/agents/<agentId>/sessions`

### 單代理模式（預設）

如果您不執行任何操作，OpenClaw 會執行單一代理：

- `agentId` 預設為 **`main`**。
- 工作階段以 `agent:main:<mainKey>` 為鍵。
- 工作區預設為 `~/.openclaw/workspace`（或當設定 `OPENCLAW_PROFILE` 時為 `~/.openclaw/workspace-<profile>`）。
- 狀態預設為 `~/.openclaw/agents/main/agent`。

## 代理助手

使用代理精靈新增一個隔離的代理：

```bash
openclaw agents add work
```

然後新增 `bindings`（或讓精靈處理）以路由傳入訊息。

透過以下指令驗證：

```bash
openclaw agents list --bindings
```

## 多個代理 = 多個人，多種個性

透過**多個代理**，每個 `agentId` 都會成為**完全隔離的角色**：

- **不同的電話號碼/帳戶**（每個頻道的 `accountId`）。
- **不同的個性**（每個代理的工作區檔案，例如 `AGENTS.md` 和 `SOUL.md`）。
- **獨立的憑證 + 工作階段**（除非明確啟用，否則不會交叉通訊）。

這允許多個人共享一個 Gateway 伺服器，同時保持其 AI「大腦」和資料隔離。

## 一個 WhatsApp 號碼，多個人（私訊拆分）

您可以將**不同的 WhatsApp 私訊**路由到不同的代理，同時保留在**一個 WhatsApp 帳戶**上。透過寄件人的 E.164 格式（例如 `+15551234567`）與 `peer.kind: "direct"` 進行比對。回覆仍來自相同的 WhatsApp 號碼（沒有每個代理的寄件者身份）。

重要細節：直接聊天會歸結到代理的**主要工作階段鍵**，因此真正的隔離需要**每個人一個代理**。

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

注意事項：

- 私訊存取控制是**每個 WhatsApp 帳戶全域**的（配對/允許清單），而非每個代理獨立的。
- 對於共享群組，請將群組綁定到一個代理，或使用 [廣播群組](/channels/broadcast-groups)。

## 路由規則（訊息如何選擇代理）

綁定是**確定性的**，且**最具體者優先**：

1. `peer` 比對（確切的私訊/群組/頻道 ID）
2. `parentPeer` 比對（執行緒繼承）
3. `guildId + roles` (Discord 角色路由)
4. `guildId` (Discord)
5. `teamId` (Slack)
6. `accountId` 頻道比對
7. 頻道層級比對 (`accountId: "*"`)
8. 回退到預設代理 (`agents.list[].default`，否則為清單中的第一個項目，預設：`main`)

如果綁定設定了多個比對欄位（例如 `peer` + `guildId`），則所有指定欄位都是必需的（`AND` 語義）。

## 多個帳戶 / 電話號碼

支援**多個帳戶**的頻道（例如 WhatsApp）使用 `accountId` 來識別每個登入。每個 `accountId` 可以路由到不同的代理，因此一台伺服器可以託管多個電話號碼而不會混淆工作階段。

## 概念

- `agentId`：一個「大腦」（工作區、每個代理的憑證、每個代理的工作階段儲存區）。
- `accountId`：一個頻道帳戶實例（例如 WhatsApp 帳戶 `"personal"` vs `"biz"`）。
- `binding`：透過 `(channel, accountId, peer)` 和可選的 guild/team ID 將傳入訊息路由到 `agentId`。
- 直接聊天會歸結到 `agent:<agentId>:<mainKey>`（每個代理的「主要」；`session.mainKey`）。

## 範例：兩個 WhatsApp 帳戶 → 兩個代理

`~/.openclaw/openclaw.json` (JSON5)：

```js
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

  // 確定性路由：第一個比對成功者優先（最具體者優先）。
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // 可選的每個 peer 覆寫（範例：將特定群組傳送給工作代理）。
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630... @g.us" },
      },
    },
  ],

  // 預設為關閉：代理之間的訊息傳遞必須明確啟用 + 允許清單。
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
          // 可選的覆寫。預設：~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // 可選的覆寫。預設：~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## 範例：WhatsApp 日常聊天 + Telegram 深度工作

按頻道拆分：將 WhatsApp 路由到快速日常代理，將 Telegram 路由到 Opus 代理。

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

- 如果您有多個頻道帳戶，請將 `accountId` 加入綁定（例如 `{ channel: "whatsapp", accountId: "personal" }`）。
- 若要將單一私訊/群組路由到 Opus，同時將其餘訊息保留在聊天代理上，請為該 peer 新增一個 `match.peer` 綁定；peer 比對永遠優先於頻道範圍的規則。

## 範例：相同頻道，一個 peer 到 Opus

將 WhatsApp 保持在快速代理上，但將一個私訊路由到 Opus：

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

Peer 綁定永遠優先，因此請將它們放在頻道範圍規則的上方。

## 綁定到 WhatsApp 群組的家庭代理

將專用的家庭代理綁定到單一 WhatsApp 群組，並設定提及閘門和更嚴格的工具政策：

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
          mentionPatterns: [" @family", " @familybot", " @Family Bot"],
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
        peer: { kind: "group", id: "120363999999999999 @g.us" },
      },
    },
  ],
}
```

注意事項：

- 工具允許/拒絕清單是**工具**，而非 Skills。如果 Skills 需要執行二進位檔，請確保允許 `exec` 且二進位檔存在於沙箱中。
- 若要更嚴格的閘門控制，請設定 `agents.list[].groupChat.mentionPatterns` 並為頻道啟用群組允許清單。

## 每個代理的沙箱和工具設定

從 v2026.1.6 版開始，每個代理都可以擁有自己的沙箱和工具限制：

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // 個人代理不使用沙箱
        },
        // 沒有工具限制 - 所有工具皆可用
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // 始終沙箱隔離
          scope: "agent",  // 每個代理一個容器
          docker: {
            // 容器建立後可選的一次性設定
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // 僅允許 read 工具
          deny: ["exec", "write", "edit", "apply_patch"],    // 拒絕其他工具
        },
      },
    ],
  },
}
```

注意事項：`setupCommand` 位於 `sandbox.docker` 下，並在容器建立時執行一次。當解析的範圍為 `"shared"` 時，每個代理的 `sandbox.docker.*` 覆寫會被忽略。

**優點：**

- **安全性隔離**：限制不受信任代理的工具
- **資源控制**：沙箱隔離特定代理，同時讓其他代理保留在主機上
- **彈性政策**：每個代理有不同的權限

注意事項：`tools.elevated` 是**全域**且基於寄件人的；它不能按代理設定。如果您需要每個代理的邊界，請使用 `agents.list[].tools` 來拒絕 `exec`。對於群組目標，請使用 `agents.list[].groupChat.mentionPatterns`，以便提及可明確對應到預期的代理。

請參閱 [多代理沙箱與工具](/tools/multi-agent-sandbox-tools) 以了解詳細範例。
```
