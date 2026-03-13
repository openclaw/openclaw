---
summary: Broadcast a WhatsApp message to multiple agents
read_when:
  - Configuring broadcast groups
  - Debugging multi-agent replies in WhatsApp
status: experimental
title: Broadcast Groups
---

# 廣播群組

**狀態：** 實驗性  
**版本：** 於 2026.1.9 中新增

## 概述

廣播群組使多位代理能夠同時處理和回應相同的訊息。這讓您可以建立專門的代理團隊，這些團隊可以在單一的 WhatsApp 群組或直接訊息中協同工作 — 所有人都使用同一個電話號碼。

當前範圍：**僅限 WhatsApp**（網頁通道）。

廣播群組在頻道允許清單和群組啟用規則之後進行評估。在 WhatsApp 群組中，這意味著廣播會在 OpenClaw 通常會回覆的時候發生（例如：根據您的群組設定，在提及時）。

## 使用案例

### 1. 專業代理團隊

部署多個具有原子性、專注責任的代理：

```
Group: "Development Team"
Agents:
  - CodeReviewer (reviews code snippets)
  - DocumentationBot (generates docs)
  - SecurityAuditor (checks for vulnerabilities)
  - TestGenerator (suggests test cases)
```

每個代理處理相同的訊息並提供其專業的觀點。

### 2. 多語言支援

```
Group: "International Support"
Agents:
  - Agent_EN (responds in English)
  - Agent_DE (responds in German)
  - Agent_ES (responds in Spanish)
```

### 3. 品質保證工作流程

```
Group: "Customer Support"
Agents:
  - SupportAgent (provides answer)
  - QAAgent (reviews quality, only responds if issues found)
```

### 4. 任務自動化

```
Group: "Project Management"
Agents:
  - TaskTracker (updates task database)
  - TimeLogger (logs time spent)
  - ReportGenerator (creates summaries)
```

## Configuration

### 基本設置

新增一個頂層 `broadcast` 區段（位於 `bindings` 旁邊）。鍵值為 WhatsApp 對等 ID：

- 群組聊天：群組 JID（例如 `120363403215116621@g.us`）
- 直接訊息：E.164 電話號碼（例如 `+15551234567`）

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**結果：** 當 OpenClaw 在這個聊天中回覆時，它將執行所有三個代理。

### 處理策略

控制代理如何處理訊息：

#### Parallel (預設)

所有代理同時處理：

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### Sequential

代理程式按順序處理（一個等待前一個完成）：

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### 完整範例

```json
{
  "agents": {
    "list": [
      {
        "id": "code-reviewer",
        "name": "Code Reviewer",
        "workspace": "/path/to/code-reviewer",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "security-auditor",
        "name": "Security Auditor",
        "workspace": "/path/to/security-auditor",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "docs-generator",
        "name": "Documentation Generator",
        "workspace": "/path/to/docs-generator",
        "sandbox": { "mode": "all" }
      }
    ]
  },
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["code-reviewer", "security-auditor", "docs-generator"],
    "120363424282127706@g.us": ["support-en", "support-de"],
    "+15555550123": ["assistant", "logger"]
  }
}
```

## 如何運作

### Message Flow

1. **進來的訊息** 會在 WhatsApp 群組中到達
2. **廣播檢查**：系統檢查對等 ID 是否在 `broadcast` 中
3. **如果在廣播列表中**：
   - 所有列出的代理處理該訊息
   - 每個代理都有自己的會話金鑰和獨立的上下文
   - 代理可以並行（預設）或順序處理
4. **如果不在廣播列表中**：
   - 應用正常路由（第一個匹配的綁定）

注意：廣播群組不會繞過頻道允許清單或群組啟用規則（提及/指令等）。它們僅改變在消息符合處理條件時，_哪些代理執行_。

### Session Isolation

每個廣播群組中的代理都完全獨立地維護：

- **會話金鑰** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **對話歷史** (代理不會看到其他代理的訊息)
- **工作區** (如果設定，則為獨立的沙盒)
- **工具存取** (不同的允許/拒絕清單)
- **記憶/上下文** (獨立的 IDENTITY.md、SOUL.md 等)
- **群組上下文緩衝區** (最近的群組訊息用於上下文) 是按對等體共享的，因此所有廣播代理在觸發時看到相同的上下文

這使得每個代理可以擁有：

- 不同的個性
- 不同的工具存取權限（例如，只讀 vs. 可讀寫）
- 不同的模型（例如，opus vs. sonnet）
- 不同的技能安裝

### 範例：獨立會話

在群組 `120363403215116621@g.us` 中，代理 `["alfred", "baerbel"]`：

**Alfred的背景：**

```
Session: agent:alfred:whatsapp:group:120363403215116621@g.us
History: [user message, alfred's previous responses]
Workspace: /Users/pascal/openclaw-alfred/
Tools: read, write, exec
```

**Bärbel的背景：**

```
Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
History: [user message, baerbel's previous responses]
Workspace: /Users/pascal/openclaw-baerbel/
Tools: read only
```

## 最佳實踐

### 1. 讓代理人專注

為每個代理設計一個單一且明確的責任：

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **好:** 每個代理都有一個工作  
❌ **壞:** 一個通用的 "dev-helper" 代理

### 2. 使用具描述性的名稱

[[BLOCK_1]]  
讓每個代理的功能清楚明瞭：  
[[BLOCK_2]]

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. 設定不同工具的存取權限

給予代理人所需的工具：

```json
{
  "agents": {
    "reviewer": {
      "tools": { "allow": ["read", "exec"] } // Read-only
    },
    "fixer": {
      "tools": { "allow": ["read", "write", "edit", "exec"] } // Read-write
    }
  }
}
```

### 4. 監控效能

考慮有許多代理的情況：

- 使用 `"strategy": "parallel"` (預設) 以提高速度
- 將廣播群組限制為 5-10 名代理
- 為簡單代理使用更快的模型

### 5. 優雅地處理失敗

[[BLOCK_1]] 代理獨立失敗。一個代理的錯誤不會阻礙其他代理： [[BLOCK_1]]

```
Message → [Agent A ✓, Agent B ✗ error, Agent C ✓]
Result: Agent A and C respond, Agent B logs error
```

## 相容性

### Providers

[[BLOCK_1]]  
廣播群組目前適用於：  
[[BLOCK_2]]

- ✅ WhatsApp（已實作）
- 🚧 Telegram（計畫中）
- 🚧 Discord（計畫中）
- 🚧 Slack（計畫中）

### Routing

[[BLOCK_1]] 廣播群組與現有的路由一起運作： [[BLOCK_1]]

```json
{
  "bindings": [
    {
      "match": { "channel": "whatsapp", "peer": { "kind": "group", "id": "GROUP_A" } },
      "agentId": "alfred"
    }
  ],
  "broadcast": {
    "GROUP_B": ["agent1", "agent2"]
  }
}
```

- `GROUP_A`: 只有 alfred 回應（正常路由）
- `GROUP_B`: agent1 和 agent2 回應（廣播）

**優先順序：** `broadcast` 優先於 `bindings`。

## 故障排除

### Agents Not Responding

**Check:**

1. 代理人 ID 存在於 `agents.list`
2. 對等 ID 格式正確（例如，`120363403215116621@g.us`）
3. 代理人不在拒絕名單中

**Debug:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### 只有一個代理回應

**原因：** Peer ID 可能在 `bindings` 中，但不在 `broadcast` 中。

**修正：** 將其添加到廣播設定中或從綁定中移除。

### 性能問題

**如果有很多代理時速度較慢：**

- 減少每組的代理人數量
- 使用較輕的模型（sonnet 取代 opus）
- 檢查沙盒啟動時間

## Examples

### Example 1: 程式碼審查團隊

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": [
      "code-formatter",
      "security-scanner",
      "test-coverage",
      "docs-checker"
    ]
  },
  "agents": {
    "list": [
      {
        "id": "code-formatter",
        "workspace": "~/agents/formatter",
        "tools": { "allow": ["read", "write"] }
      },
      {
        "id": "security-scanner",
        "workspace": "~/agents/security",
        "tools": { "allow": ["read", "exec"] }
      },
      {
        "id": "test-coverage",
        "workspace": "~/agents/testing",
        "tools": { "allow": ["read", "exec"] }
      },
      { "id": "docs-checker", "workspace": "~/agents/docs", "tools": { "allow": ["read"] } }
    ]
  }
}
```

[[BLOCK_1]]  
**使用者發送：** 程式碼片段  
[[BLOCK_1]]

- code-formatter: "修正了縮排並新增了類型提示"
- security-scanner: "⚠️ 第 12 行存在 SQL 注入漏洞"
- test-coverage: "測試覆蓋率為 45%，缺少錯誤情況的測試"
- docs-checker: "函數 `process_data` 缺少文檔字串"

### Example 2: 多語言支援

```json
{
  "broadcast": {
    "strategy": "sequential",
    "+15555550123": ["detect-language", "translator-en", "translator-de"]
  },
  "agents": {
    "list": [
      { "id": "detect-language", "workspace": "~/agents/lang-detect" },
      { "id": "translator-en", "workspace": "~/agents/translate-en" },
      { "id": "translator-de", "workspace": "~/agents/translate-de" }
    ]
  }
}
```

## API 參考資料

### Config Schema

```typescript
interface OpenClawConfig {
  broadcast?: {
    strategy?: "parallel" | "sequential";
    [peerId: string]: string[];
  };
}
```

### Fields

- `strategy` (可選): 如何處理代理
  - `"parallel"` (預設): 所有代理同時處理
  - `"sequential"`: 代理按陣列順序處理
- `[peerId]`: WhatsApp 群組 JID、E.164 號碼或其他對等 ID
  - 值: 應該處理訊息的代理 ID 陣列

## 限制事項

1. **最大代理人數：** 沒有硬性限制，但超過 10 位代理人可能會變得緩慢
2. **共享上下文：** 代理人無法看到彼此的回應（設計如此）
3. **訊息排序：** 平行回應可能會以任何順序到達
4. **速率限制：** 所有代理人都計入 WhatsApp 的速率限制

## 未來增強功能

[[BLOCK_1]]  
計畫中的功能：  
[[BLOCK_1]]

- [ ] 共享上下文模式（代理可以看到彼此的回應）
- [ ] 代理協調（代理可以互相發信號）
- [ ] 動態代理選擇（根據訊息內容選擇代理）
- [ ] 代理優先級（某些代理在其他代理之前回應）

## 另請參閱

- [多代理設定](/tools/multi-agent-sandbox-tools)
- [路由設定](/channels/channel-routing)
- [會話管理](/concepts/session)
