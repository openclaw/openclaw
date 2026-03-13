# ACP 持久綁定 Discord 頻道和 Telegram 主題

Status: Draft

## Summary

引入持久性 ACP 綁定，映射：

- Discord 頻道（以及必要時的現有主題），以及
- Telegram 論壇主題在群組/超級群組 (`chatId:topic:topicId`)

對於長期存在的 ACP 會話，綁定狀態使用明確的綁定類型儲存在頂層 `bindings[]` 條目中。

這使得在高流量訊息通道中使用 ACP 變得可預測且持久，因此用戶可以創建專用的通道/主題，例如 `codex`、`claude-1` 或 `claude-myrepo`。

## 為什麼

目前綁定於線程的 ACP 行為已針對短暫的 Discord 線程工作流程進行優化。Telegram 並不具備相同的線程模型；它在群組/超級群組中有論壇主題。用戶希望在聊天界面中擁有穩定、持續的 ACP “工作空間”，而不僅僅是臨時的線程會話。

## 目標

- 支援耐用的 ACP 綁定，適用於：
  - Discord 頻道/主題
  - Telegram 論壇主題（群組/超級群組）
- 使綁定的真實來源設定驅動。
- 在 Discord 和 Telegram 之間保持 `/acp`、`/new`、`/reset`、`/focus` 及交付行為的一致性。
- 保留現有的臨時綁定流程以供臨時使用。

## 非目標

- 完全重新設計 ACP 執行時/會話內部結構。
- 移除現有的短暫綁定流程。
- 在第一個迭代中擴充到每個通道。
- 在此階段實現 Telegram 通道直接消息主題 (`direct_messages_topic_id`)。
- 在此階段實現 Telegram 私聊主題變體。

## UX 方向

### 1) 兩種綁定類型

- **持久綁定**：儲存在設定中，啟動時進行調整，旨在用於「命名工作區」頻道/主題。
- **臨時綁定**：僅在執行時有效，根據閒置/最大年齡政策過期。

### 2) 命令行為

- `/acp spawn ... --thread here|auto|off` 仍然可用。
- 添加明確的綁定生命週期控制：
  - `/acp bind [session|agent] [--persist]`
  - `/acp unbind [--persist]`
  - `/acp status` 包含綁定是否為 `persistent` 或 `temporary`。
- 在綁定的對話中，`/new` 和 `/reset` 會在原地重置綁定的 ACP 會話並保持綁定附加。

### 3) 對話身份

- 使用標準對話 ID：
  - Discord：頻道/主題 ID。
  - Telegram 主題：`chatId:topic:topicId`。
- 切勿僅使用裸主題 ID 來鍵入 Telegram 綁定。

## Config Model (提議)

在頂層 `bindings[]` 中統一路由和持久性 ACP 綁定設定，並使用明確的 `type` 區別符：

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace-main",
        "runtime": { "type": "embedded" },
      },
      {
        "id": "codex",
        "workspace": "~/.openclaw/workspace-codex",
        "runtime": {
          "type": "acp",
          "acp": {
            "agent": "codex",
            "backend": "acpx",
            "mode": "persistent",
            "cwd": "/workspace/repo-a",
          },
        },
      },
      {
        "id": "claude",
        "workspace": "~/.openclaw/workspace-claude",
        "runtime": {
          "type": "acp",
          "acp": {
            "agent": "claude",
            "backend": "acpx",
            "mode": "persistent",
            "cwd": "/workspace/repo-b",
          },
        },
      },
    ],
  },
  "acp": {
    "enabled": true,
    "backend": "acpx",
    "allowedAgents": ["codex", "claude"],
  },
  "bindings": [
    // Route bindings (existing behavior)
    {
      "type": "route",
      "agentId": "main",
      "match": { "channel": "discord", "accountId": "default" },
    },
    {
      "type": "route",
      "agentId": "main",
      "match": { "channel": "telegram", "accountId": "default" },
    },
    // Persistent ACP conversation bindings
    {
      "type": "acp",
      "agentId": "codex",
      "match": {
        "channel": "discord",
        "accountId": "default",
        "peer": { "kind": "channel", "id": "222222222222222222" },
      },
      "acp": {
        "label": "codex-main",
        "mode": "persistent",
        "cwd": "/workspace/repo-a",
        "backend": "acpx",
      },
    },
    {
      "type": "acp",
      "agentId": "claude",
      "match": {
        "channel": "discord",
        "accountId": "default",
        "peer": { "kind": "channel", "id": "333333333333333333" },
      },
      "acp": {
        "label": "claude-repo-b",
        "mode": "persistent",
        "cwd": "/workspace/repo-b",
      },
    },
    {
      "type": "acp",
      "agentId": "codex",
      "match": {
        "channel": "telegram",
        "accountId": "default",
        "peer": { "kind": "group", "id": "-1001234567890:topic:42" },
      },
      "acp": {
        "label": "tg-codex-42",
        "mode": "persistent",
      },
    },
  ],
  "channels": {
    "discord": {
      "guilds": {
        "111111111111111111": {
          "channels": {
            "222222222222222222": {
              "enabled": true,
              "requireMention": false,
            },
            "333333333333333333": {
              "enabled": true,
              "requireMention": false,
            },
          },
        },
      },
    },
    "telegram": {
      "groups": {
        "-1001234567890": {
          "topics": {
            "42": {
              "requireMention": false,
            },
          },
        },
      },
    },
  },
}
```

### 最小範例（無每個綁定的 ACP 覆寫）

jsonc
{
"agents": {
"list": [
{ "id": "main", "default": true, "runtime": { "type": "embedded" } },
{
"id": "codex",
"runtime": {
"type": "acp",
"acp": { "agent": "codex", "backend": "acpx", "mode": "persistent" }
}
},
{
"id": "claude",
"runtime": {
"type": "acp",
"acp": { "agent": "claude", "backend": "acpx", "mode": "persistent" }
}
}
]
},
"acp": { "enabled": true, "backend": "acpx" },
"bindings": [
{
"type": "route",
"agentId": "main",
"match": { "channel": "discord", "accountId": "default" }
},
{
"type": "route",
"agentId": "main",
"match": { "channel": "telegram", "accountId": "default" }
}

{
"type": "acp",
"agentId": "codex",
"match": {
"channel": "discord",
"accountId": "default",
"peer": { "kind": "channel", "id": "222222222222222222" },
},
},
{
"type": "acp",
"agentId": "claude",
"match": {
"channel": "discord",
"accountId": "default",
"peer": { "kind": "channel", "id": "333333333333333333" },
},
},
{
"type": "acp",
"agentId": "codex",
"match": {
"channel": "telegram",
"accountId": "default",
"peer": { "kind": "group", "id": "-1009876543210:topic:5" },
},
},
],
}

[[BLOCK_1]]

- `bindings[].type` 是明確的：
  - `route`：正常的代理路由。
  - `acp`：為匹配的對話持久的 ACP 繫結。
- 對於 `type: "acp"`，`match.peer.id` 是標準的對話鍵：
  - Discord 頻道/主題：原始頻道/主題 ID。
  - Telegram 主題：`chatId:topic:topicId`。
- `bindings[].acp.backend` 是可選的。後端回退順序：
  1. `bindings[].acp.backend`
  2. `agents.list[].runtime.acp.backend`
  3. 全域 `acp.backend`
- `mode`、`cwd` 和 `label` 遵循相同的覆蓋模式 (`binding override -> agent runtime default -> global/default behavior`)。
- 保留現有的 `session.threadBindings.*` 和 `channels.discord.threadBindings.*` 以便於臨時繫結政策。
- 持久條目聲明所需狀態；執行時會調整為實際的 ACP 會話/繫結。
- 每個對話節點一個活動的 ACP 繫結是預期的模型。
- 向後相容性：缺少 `type` 被解釋為 `route` 以適應舊有條目。

### Backend 選擇

- ACP 會話初始化已經在生成時使用設定的後端選擇 (`acp.backend` 今天)。
- 此提案擴充生成/調解邏輯，以優先考慮類型化的 ACP 綁定覆蓋：
  - `bindings[].acp.backend` 用於對話本地的覆蓋。
  - `agents.list[].runtime.acp.backend` 用於每個代理的預設值。
- 如果不存在覆蓋，則保持當前行為 (`acp.backend` 預設)。

## Architecture Fit in Current System

### 重用現有元件

- `SessionBindingService` 已經支援與通道無關的對話參考。
- ACP 產生/綁定流程已經支援透過服務 API 進行綁定。
- Telegram 已經透過 `MessageThreadId` 和 `chatId` 傳遞主題/線程上下文。

### 新增/擴充元件

- **Telegram 綁定適配器**（與 Discord 適配器平行）：
  - 每個 Telegram 帳號註冊適配器，
  - 根據標準對話 ID 解決/列出/綁定/解除綁定/觸碰。
- **類型化綁定解析器/索引**：
  - 將 `bindings[]` 拆分為 `route` 和 `acp` 視圖，
  - 僅在 `route` 綁定上保留 `resolveAgentRoute`，
  - 僅從 `acp` 綁定中解析持久的 ACP 意圖。
- **Telegram 的入站綁定解析**：
  - 在路由最終確定之前解析綁定的會話（Discord 已經這樣做）。
- **持久綁定調解器**：
  - 在啟動時：加載設定的頂層 `type: "acp"` 綁定，確保 ACP 會話存在，確保綁定存在。
  - 在設定變更時：安全地應用增量。
- **切換模型**：
  - 不讀取任何通道本地的 ACP 綁定回退，
  - 持久的 ACP 綁定僅來自頂層 `bindings[].type="acp"` 條目。

## 分階段交付

### 階段 1：類型綁定架構基礎

- 擴充設定架構以支援 `bindings[].type` 判別器：
  - `route`，
  - `acp` 具有可選的 `acp` 覆蓋物件 (`mode`，`backend`，`cwd`，`label`)。
- 擴充代理架構，增加執行時描述符以標記 ACP 原生代理 (`agents.list[].runtime.type`)。
- 為路由與 ACP 綁定添加解析器/索引器分離。

### Phase 2: 執行時解析 + Discord/Telegram 同步性

- 從頂層 `type: "acp"` 條目解析持久的 ACP 綁定，針對：
  - Discord 頻道/主題，
  - Telegram 論壇主題 (`chatId:topic:topicId` 正規 ID)。
- 實作 Telegram 綁定適配器，並與 Discord 實現入站綁定會話的覆蓋一致性。
- 此階段不包括 Telegram 直接/私人主題變體。

### Phase 3: 命令平衡與重置

- 將 `/acp`、`/new`、`/reset` 和 `/focus` 的行為對齊於綁定的 Telegram/Discord 對話中。
- 確保綁定在設定的重置流程中能夠持續存在。

### Phase 4: 強化

- 更好的診斷 (`/acp status`，啟動對帳日誌)。
- 衝突處理和健康檢查。

## Guardrails and Policy

- 嚴格遵守 ACP 啟用和沙盒限制，與今天相同。
- 保持明確的帳戶範圍 (`accountId`) 以避免跨帳戶資料洩漏。
- 在模糊路由的情況下，保持失敗關閉。
- 根據每個通道設定，保持提及/訪問政策行為的明確性。

## 測試計畫

- 單元：
  - 對話 ID 正規化（特別是 Telegram 主題 ID），
  - 調解器的創建/更新/刪除路徑，
  - `/acp bind --persist` 和解除綁定流程。
- 整合：
  - 進來的 Telegram 主題 -> 綁定的 ACP 會話解析，
  - 進來的 Discord 頻道/主題 -> 持久綁定優先權。
- 回歸：
  - 臨時綁定繼續有效，
  - 解除綁定的頻道/主題保持當前路由行為。

## 開放性問題

- 在 Telegram 主題中，`/acp spawn --thread auto` 是否應該預設為 `here`？
- 持久綁定是否應該在綁定對話中始終繞過提及限制，還是需要明確的 `requireMention=false`？
- `/focus` 是否應該獲得 `--persist` 作為 `/acp bind --persist` 的別名？

## Rollout

- 根據對話選擇性發送 (`bindings[].type="acp"` 條目存在)。
- 先從 Discord 和 Telegram 開始。
- 添加包含範例的文件，內容包括：
  - “每個代理一個頻道/主題”
  - “同一代理的多個頻道/主題，使用不同的 `cwd`”
  - “團隊命名模式 (`codex-1`, `claude-repo-x`)”。
