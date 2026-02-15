---
summary: "多智慧代理路由：隔離的智慧代理、頻道帳號以及綁定"
title: 多智慧代理路由
read_when: "當您想在一個 Gateway 處理程序中運行多個隔離的智慧代理（工作區 + 認證）時。"
status: active
---

# 多智慧代理路由

目標：在一個運行的 Gateway 中管理多個*隔離*的智慧代理（具備獨立的工作區 + `agentDir` + 工作階段），以及多個頻道帳號（例如兩個 WhatsApp）。入站訊息會透過綁定（bindings）路由至特定的智慧代理。

## 什麼是「一個智慧代理」？

一個**智慧代理**是一個具備完整作用域的大腦，擁有自己的：

- **工作區**（檔案、AGENTS.md/SOUL.md/USER.md、本地筆記、人格設定規則）。
- **狀態目錄**（`agentDir`），用於儲存認證設定檔、模型註冊表和每個智慧代理的專屬設定。
- **工作階段儲存區**（聊天紀錄 + 路由狀態），位於 `~/.openclaw/agents/<agentId>/sessions`。

認證設定檔是**依智慧代理獨立**的。每個智慧代理會讀取自己的：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

主要智慧代理的憑證**不會**自動共享。切勿在智慧代理之間共用 `agentDir`（這會導致認證/工作階段衝突）。如果您想共享憑證，請將 `auth-profiles.json` 複製到另一個智慧代理的 `agentDir` 中。

Skills 是依智慧代理獨立的，透過每個工作區的 `skills/` 資料夾運作，而共用 Skills 可從 `~/.openclaw/skills` 取得。請參閱 [Skills：智慧代理專屬 vs 共用](/tools/skills#per-agent-vs-shared-skills)。

Gateway 可以同時託管**一個智慧代理**（預設）或**多個智慧代理**。

**工作區注意事項：** 每個智慧代理的工作區是**預設的目前工作目錄 (cwd)**，而非強制的沙箱。相對路徑會在工作區內解析，但除非啟用了沙箱隔離，否則絕對路徑可以存取主機的其他位置。請參閱 [沙箱隔離](/gateway/sandboxing)。

## 路徑（快速對照）

- 設定：`~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）
- 狀態目錄：`~/.openclaw`（或 `OPENCLAW_STATE_DIR`）
- 工作區：`~/.openclaw/workspace`（或 `~/.openclaw/workspace-<agentId>`）
- 智慧代理目錄：`~/.openclaw/agents/<agentId>/agent`（或 `agents.list[].agentDir`）
- 工作階段：`~/.openclaw/agents/<agentId>/sessions`

### 單智慧代理模式（預設）

如果您不進行任何操作，OpenClaw 會運行單個智慧代理：

- `agentId` 預設為 **`main`**。
- 工作階段鍵值格式為 `agent:main:<mainKey>`。
- 工作區預設為 `~/.openclaw/workspace`（或當設定 `OPENCLAW_PROFILE` 時為 `~/.openclaw/workspace-<profile>`）。
- 狀態預設為 `~/.openclaw/agents/main/agent`。

## 智慧代理小幫手

使用智慧代理精靈來新增一個隔離的智慧代理：

```bash
openclaw agents add work
```

然後新增 `bindings`（或讓精靈自動完成）來路由入站訊息。

驗證方式：

```bash
openclaw agents list --bindings
```

## 多個智慧代理 = 多個人員，多種人格

使用**多個智慧代理**，每個 `agentId` 都會成為一個**完全隔離的人格**：

- **不同的電話號碼/帳號**（依頻道 `accountId` 區分）。
- **不同的人格設定**（每個智慧代理工作區內的 `AGENTS.md` 和 `SOUL.md` 檔案）。
- **獨立的認證 + 工作階段**（除非明確啟用，否則不會產生交集）。

這讓**多個人員**可以共用一個 Gateway 伺服器，同時保持他們的 AI 「大腦」和資料互相隔離。

## 一個 WhatsApp 號碼，多個人員（私訊拆分）

您可以將**不同的 WhatsApp 私訊**路由至不同的智慧代理，同時維持使用**同一個 WhatsApp 帳號**。透過 `peer.kind: "direct"` 匹配發送者的 E.164 格式號碼（例如 `+15551234567`）。回覆仍會從同一個 WhatsApp 號碼發出（不具備智慧代理專屬的發送者身分）。

重要細節：私訊聊天會收納到智慧代理的**主要工作階段鍵值**中，因此要實現真正的隔離，需要**每個人配置一個智慧代理**。

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

注意：

- 私訊存取控制是**基於每個 WhatsApp 帳號的全域設定**（配對/允許列表），而非基於智慧代理。
- 對於共用群組，請將群組綁定至一個智慧代理，或使用 [廣播群組](/channels/broadcast-groups)。

## 路由規則（訊息如何選擇智慧代理）

綁定是**確定性**的，且**最精確的匹配優先**：

1. `peer` 匹配（確切的私訊/群組/頻道 ID）
2. `parentPeer` 匹配（討論串繼承）
3. `guildId + roles`（Discord 身分組路由）
4. `guildId` (Discord)
5. `teamId` (Slack)
6. 頻道的 `accountId` 匹配
7. 頻道層級匹配 (`accountId: "*"`)
8. 退回至預設智慧代理（`agents.list[].default`，若未設定則為列表中的第一個項目，預設值為：`main`）

如果綁定設定了多個匹配欄位（例如 `peer` + `guildId`），則所有指定的欄位都必須符合（`AND` 語義）。

## 多個帳號 / 電話號碼

支援**多帳號**的頻道（例如 WhatsApp）使用 `accountId` 來識別每次登入。每個 `accountId` 都可以路由至不同的智慧代理，因此一台伺服器可以託管多個電話號碼而不會混淆工作階段。

## 核心概念

- `agentId`：一個「大腦」（工作區、依智慧代理獨立的認證、依智慧代理獨立的工作階段儲存區）。
- `accountId`：一個頻道帳號實例（例如 WhatsApp 帳號 `"personal"` 對比 `"biz"`）。
- `binding`：透過 `(channel, accountId, peer)` 以及選用的 guild/team ID，將入站訊息路由至特定的 `agentId`。
- 私訊聊天會收納至 `agent:<agentId>:<mainKey>`（每個智慧代理的「主要」工作階段；`session.mainKey`）。

## 範例：兩個 WhatsApp → 兩個智慧代理

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

  // 確定性路由：第一個匹配成功的優先（由最精確的開始）。
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // 選用的個別節點覆寫（範例：將特定群組傳送至 work 智慧代理）。
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630... @g.us" },
      },
    },
  ],

  // 預設關閉：智慧代理間的訊息傳遞必須明確啟用並加入允許列表。
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
          // 選用覆寫。預設：~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // 選用覆寫。預設：~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## 範例：WhatsApp 日常聊天 + Telegram 深度工作

按頻道拆分：將 WhatsApp 路由至快速的日常智慧代理，將 Telegram 路由至 Opus 智慧代理。

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

注意：

- 如果一個頻道有多個帳號，請在綁定中加入 `accountId`（例如 `{ channel: "whatsapp", accountId: "personal" }`）。
- 若要將單個私訊/群組路由至 Opus，同時保持其他內容在 chat，請為該節點新增一個 `match.peer` 綁定；節點匹配始終優先於頻道級別的規則。

## 範例：同頻道，將一個節點路由至 Opus

讓 WhatsApp 保持在快速智慧代理上，但將一個私訊路由至 Opus：

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

節點綁定始終優先，因此請將它們放在頻道級別規則之上。

## 綁定至 WhatsApp 群組的家庭智慧代理

將一個專屬的家庭智慧代理綁定至單個 WhatsApp 群組，並設置提及門檻（mention gating）和更嚴格的工具策略：

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

注意：

- 工具的允許/拒絕列表針對的是**工具**而非技能（skills）。如果某個技能需要運行二進位檔案，請確保 `exec` 已被允許，且該二進位檔案存在於沙箱中。
- 若要實施更嚴格的過濾，請設定 `agents.list[].groupChat.mentionPatterns` 並保持頻道群組允許列表啟用。

## 個別智慧代理的沙箱與工具設定

從 v2026.1.6 開始，每個智慧代理都可以擁有自己的沙箱與工具限制：

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // 個人智慧代理不使用沙箱
        },
        // 無工具限制 - 所有工具皆可用
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // 始終使用沙箱隔離
          scope: "agent",  // 每個智慧代理一個容器
          docker: {
            // 容器建立後的選用一次性設定
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // 僅限 read 工具
          deny: ["exec", "write", "edit", "apply_patch"],    // 拒絕其他工具
        },
      },
    ],
  },
}
```

注意：`setupCommand` 位於 `sandbox.docker` 下，且在容器建立時僅執行一次。當解析後的作用域為 `"shared"` 時，個別智慧代理的 `sandbox.docker.*` 覆寫將被忽略。

**優點：**

- **安全性隔離**：限制不受信任智慧代理的工具權限。
- **資源控制**：對特定智慧代理進行沙箱隔離，同時讓其他智慧代理保留在主機上。
- **靈活的策略**：為每個智慧代理設定不同的權限。

注意：`tools.elevated` 是**全域**且基於發送者的；它無法針對每個智慧代理單獨設定。如果您需要智慧代理層級的限制，請使用 `agents.list[].tools` 來拒絕 `exec`。對於群組對象，請使用 `agents.list[].groupChat.mentionPatterns`，以便讓 @提及 能精確對應到目標智慧代理。

請參閱 [多智慧代理沙箱與工具](/tools/multi-agent-sandbox-tools) 以瞭解詳細範例。
