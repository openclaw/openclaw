---
summary: "多代理路由：隔離的代理、頻道帳號與綁定"
title: 多代理路由
read_when: "你想在單一 Gateway 行程中使用多個彼此隔離的代理（工作區 + 驗證）。"
status: active
x-i18n:
  source_path: concepts/multi-agent.md
  source_hash: aa2b77f4707628ca
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:57Z
---

# 多代理路由

目標：在一個執行中的 Gateway 中同時運行多個「彼此隔離」的代理（各自獨立的工作區 + `agentDir` + 工作階段），並支援多個頻道帳號（例如兩個 WhatsApp）。所有入站訊息會透過綁定規則路由到指定代理。

## 什麼是「一個代理」？

**代理** 是一個完整作用域的「大腦」，各自擁有：

- **工作區**（檔案、AGENTS.md/SOUL.md/USER.md、本機筆記、人格規則）。
- **狀態目錄**（`agentDir`），用於驗證設定檔、模型登錄表與每代理設定。
- **工作階段儲存**（聊天記錄 + 路由狀態），位於 `~/.openclaw/agents/<agentId>/sessions`。

驗證設定檔是**每代理**獨立的。每個代理都會從其各自的以下位置讀取：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

主代理的憑證**不會**自動共享。切勿在代理之間重用 `agentDir`，
否則會造成驗證／工作階段衝突。若需要共用憑證，
請將 `auth-profiles.json` 複製到另一個代理的 `agentDir`。

Skills 是每代理獨立的，位於各工作區的 `skills/` 資料夾；
共用 Skills 則位於 `~/.openclaw/skills`。請參閱
[Skills：每代理 vs 共用](/tools/skills#per-agent-vs-shared-skills)。

Gateway 可同時承載**一個代理**（預設）或**多個代理**並排運行。

**工作區注意事項：** 每個代理的工作區是**預設 cwd**，而非硬性沙箱。
相對路徑會在工作區內解析，但除非啟用沙箱隔離，
否則絕對路徑仍可存取主機上的其他位置。請參閱
[沙箱隔離](/gateway/sandboxing)。

## 路徑（快速對照）

- 設定：`~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）
- 狀態目錄：`~/.openclaw`（或 `OPENCLAW_STATE_DIR`）
- 工作區：`~/.openclaw/workspace`（或 `~/.openclaw/workspace-<agentId>`）
- 代理目錄：`~/.openclaw/agents/<agentId>/agent`（或 `agents.list[].agentDir`）
- 工作階段：`~/.openclaw/agents/<agentId>/sessions`

### 單代理模式（預設）

若不做任何設定，OpenClaw 會以單一代理運行：

- `agentId` 預設為 **`main`**。
- 工作階段的鍵值為 `agent:main:<mainKey>`。
- 工作區預設為 `~/.openclaw/workspace`（當設定 `OPENCLAW_PROFILE` 時則為 `~/.openclaw/workspace-<profile>`）。
- 狀態預設為 `~/.openclaw/agents/main/agent`。

## 代理輔助工具

使用代理精靈新增一個隔離的代理：

```bash
openclaw agents add work
```

接著加入 `bindings`（或讓精靈自動處理）以路由入站訊息。

使用以下指令驗證：

```bash
openclaw agents list --bindings
```

## 多代理＝多個人、多種人格

在**多代理**情境下，每個 `agentId` 都是一個**完全隔離的人格**：

- **不同的電話號碼／帳號**（每個頻道的 `accountId`）。
- **不同的人格**（每代理工作區檔案，例如 `AGENTS.md` 與 `SOUL.md`）。
- **獨立的驗證 + 工作階段**（除非明確啟用，否則不會互相影響）。

這讓**多個人**能共用一台 Gateway 伺服器，同時保持其 AI「大腦」與資料彼此隔離。

## 一個 WhatsApp 號碼，多個人（私訊分流）

你可以在**同一個 WhatsApp 帳號**下，將**不同的 WhatsApp 私訊**路由到不同代理。
透過 `peer.kind: "dm"` 依寄件者的 E.164（例如 `+15551234567`）進行比對。
回覆仍會從相同的 WhatsApp 號碼送出（不支援每代理的寄件者身分）。

重要細節：直接聊天會合併到代理的**主要工作階段鍵**，
因此若要真正隔離，必須**每人一個代理**。

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
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
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

- 私訊的存取控制是**每個 WhatsApp 帳號全域**（配對／允許清單），而非每代理。
- 對於共用群組，請將群組綁定到單一代理，或使用
  [廣播群組](/channels/broadcast-groups)。

## 路由規則（訊息如何選擇代理）

綁定是**可預期的**，且遵循**最具體者優先**：

1. `peer` 比對（精確的私訊／群組／頻道 ID）
2. `guildId`（Discord）
3. `teamId`（Slack）
4. 某頻道的 `accountId` 比對
5. 頻道層級比對（`accountId: "*"`）
6. 回退到預設代理（`agents.list[].default`，否則使用清單中的第一個，預設：`main`）

## 多帳號／多電話號碼

支援**多帳號**的頻道（例如 WhatsApp）會使用 `accountId` 來識別
每一次登入。每個 `accountId` 都可路由到不同代理，
因此一台伺服器即可承載多個電話號碼且不混用工作階段。

## 概念

- `agentId`：一個「大腦」（工作區、每代理驗證、每代理工作階段儲存）。
- `accountId`：一個頻道帳號實例（例如 WhatsApp 帳號 `"personal"` 與 `"biz"`）。
- `binding`：依 `(channel, accountId, peer)`（以及可選的 guild／team ID）將入站訊息路由到 `agentId`。
- 直接聊天會合併到 `agent:<agentId>:<mainKey>`（每代理的「主要」；`session.mainKey`）。

## 範例：兩個 WhatsApp → 兩個代理

`~/.openclaw/openclaw.json`（JSON5）：

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

  // Deterministic routing: first match wins (most-specific first).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Optional per-peer override (example: send a specific group to work agent).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
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
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## 範例：WhatsApp 日常聊天 + Telegram 深度工作

依頻道分流：將 WhatsApp 路由到快速的日常代理，Telegram 路由到 Opus 代理。

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

- 若某頻道有多個帳號，請在綁定中加入 `accountId`（例如 `{ channel: "whatsapp", accountId: "personal" }`）。
- 若要將單一私訊／群組路由到 Opus，同時讓其他對話維持在聊天代理，
  請為該對象加入一條 `match.peer` 綁定；對象層級的比對永遠優先於頻道層級規則。

## 範例：同一頻道，單一對象到 Opus

保留 WhatsApp 走快速代理，但將一個私訊路由到 Opus：

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
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

對象綁定永遠優先，因此請將其放在頻道層級規則之上。

## 綁定到 WhatsApp 群組的家庭代理

將專用的家庭代理綁定到單一 WhatsApp 群組，並啟用提及門檻
與更嚴格的工具政策：

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

- 工具允許／拒絕清單屬於**工具**，不是 Skills。若某個 Skill 需要執行
  二進位檔，請確認已允許 `exec`，且該二進位檔存在於沙箱中。
- 若需要更嚴格的門檻，請設定 `agents.list[].groupChat.mentionPatterns`，並為該頻道
  保持群組允許清單啟用。

## 每代理的沙箱與工具設定

自 v2026.1.6 起，每個代理都可以擁有自己的沙箱與工具限制：

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

注意：`setupCommand` 位於 `sandbox.docker` 之下，且只在容器建立時執行一次。
當解析後的作用域為 `"shared"` 時，會忽略每代理的 `sandbox.docker.*` 覆寫。

**優點：**

- **安全性隔離**：為不受信任的代理限制工具
- **資源控制**：僅對特定代理啟用沙箱，其他代理仍在主機上運行
- **彈性政策**：每個代理可有不同權限

注意：`tools.elevated` 是**全域**且以寄件者為基礎；無法為每個代理個別設定。
若需要每代理的邊界，請使用 `agents.list[].tools` 來拒絕 `exec`。
若要針對群組，請使用 `agents.list[].groupChat.mentionPatterns`，讓 @ 提及能明確對應到預期的代理。

請參閱 [多代理沙箱與工具](/tools/multi-agent-sandbox-tools) 以取得詳細範例。
