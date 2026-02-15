---
summary: "將 WhatsApp 訊息廣播給多個智慧代理"
read_when:
  - 設定廣播群組
  - 在 WhatsApp 中偵錯多智慧代理回覆
status: experimental
title: "廣播群組"
---

# 廣播群組

**狀態：** 實驗性  
**版本：** 於 2026.1.9 新增

## 概覽

廣播群組讓多個智慧代理能夠同時處理並回覆同一則訊息。這使您能夠建立專業化的智慧代理團隊，在單一 WhatsApp 群組或私訊中協同工作 — 全部使用一個電話號碼。

目前範圍：**僅限 WhatsApp** (web 頻道)。

廣播群組在頻道允許清單和群組啟用規則之後進行評估。在 WhatsApp 群組中，這表示當 OpenClaw 通常會回覆時（例如：在提及時，根據您的群組設定），就會發生廣播。

## 用例

### 1. 專業化智慧代理團隊

部署具有原子性、專注職責的多個智慧代理：

```
Group: "Development Team"
Agents:
  - CodeReviewer (reviews code snippets)
  - DocumentationBot (generates docs)
  - SecurityAuditor (checks for vulnerabilities)
  - TestGenerator (suggests test cases)
```

每個智慧代理處理相同的訊息並提供其專業化的觀點。

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

## 設定

### 基本設定

在頂層新增 `broadcast` 部分（與 `bindings` 並列）。鍵是 WhatsApp 對等 ID：

- 群組聊天：群組 JID（例如 `120363403215116621 @g.us`）
- 私訊：E.164 電話號碼（例如 `+15551234567`）

```json
{
  "broadcast": {
    "120363403215116621 @g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**結果：** 當 OpenClaw 在此聊天中回覆時，它將執行所有三個智慧代理。

### 處理策略

控制智慧代理如何處理訊息：

#### 並行（預設）

所有智慧代理同時處理：

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621 @g.us": ["alfred", "baerbel"]
  }
}
```

#### 依序

智慧代理按順序處理（一個等待前一個完成）：

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621 @g.us": ["alfred", "baerbel"]
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
    "120363403215116621 @g.us": ["code-reviewer", "security-auditor", "docs-generator"],
    "120363424282127706 @g.us": ["support-en", "support-de"],
    "+15555550123": ["assistant", "logger"]
  }
}
```

## 工作原理

### 訊息流程

1. **傳入訊息**抵達 WhatsApp 群組
2. **廣播檢查**：系統檢查對等 ID 是否在 `broadcast` 中
3. **如果在廣播清單中**：
   - 所有列出的智慧代理處理訊息
   - 每個智慧代理都有自己的工作階段鍵和隔離的上下文
   - 智慧代理並行（預設）或依序處理
4. **如果不在廣播清單中**：
   - 套用正常路由（第一個匹配的綁定）

注意：廣播群組不會繞過頻道允許清單或群組啟用規則（提及/指令/等）。它們只在訊息符合處理資格時，改變**哪些智慧代理運行**。

### 工作階段隔離

廣播群組中的每個智慧代理都維持完全獨立的：

- **工作階段鍵**（`agent:alfred:whatsapp:group:120363...` 與 `agent:baerbel:whatsapp:group:120363...`）
- **對話記錄**（智慧代理看不到其他智慧代理的訊息）
- **工作區**（如果已設定，則為獨立的沙箱）
- **工具存取**（不同的允許/拒絕清單）
- **記憶體/上下文**（獨立的 IDENTITY.md、SOUL.md 等）
- **群組上下文緩衝區**（用於上下文的最近群組訊息）是每個對等共用的，因此所有廣播智慧代理在觸發時都會看到相同的上下文

這允許每個智慧代理擁有：

- 不同的個性
- 不同的工具存取權限（例如，唯讀與讀寫）
- 不同的模型（例如，opus 與 sonnet）
- 安裝不同的 Skills

### 範例：隔離的工作階段

在群組 `120363403215116621 @g.us` 中，智慧代理為 `["alfred", "baerbel"]`：

**Alfred 的上下文：**

```
Session: agent:alfred:whatsapp:group:120363403215116621 @g.us
History: [user message, alfred's previous responses]
Workspace: /Users/pascal/openclaw-alfred/
Tools: read, write, exec
```

**Bärbel 的上下文：**

```
Session: agent:baerbel:whatsapp:group:120363403215116621 @g.us
History: [user message, baerbel's previous responses]
Workspace: /Users/pascal/openclaw-baerbel/
Tools: read only
```

## 最佳實踐

### 1. 保持智慧代理專注

設計每個智慧代理時，讓其只負責一個明確的職責：

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **優點：** 每個智慧代理只有一項工作  
❌ **缺點：** 一個通用的「開發協助」智慧代理

### 2. 使用描述性名稱

清楚表明每個智慧代理的功能：

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. 設定不同的工具存取權限

僅授予智慧代理所需的工具：

```json
{
  "agents": {
    "reviewer": {
      "tools": { "allow": ["read", "exec"] } // 唯讀
    },
    "fixer": {
      "tools": { "allow": ["read", "write", "edit", "exec"] } // 讀寫
    }
  }
}
```

### 4. 監控效能

智慧代理數量眾多時，請考慮：

- 使用 `"strategy": "parallel"`（預設）以提高速度
- 將廣播群組限制為 5-10 個智慧代理
- 對於較簡單的智慧代理，使用速度較快的模型

### 5. 優雅地處理失敗

智慧代理獨立失敗。一個智慧代理的錯誤不會阻止其他智慧代理：

```
Message → [Agent A ✓, Agent B ✗ error, Agent C ✓]
Result: Agent A 和 C 回覆，Agent B 記錄錯誤
```

## 相容性

### 供應商

廣播群組目前適用於：

- ✅ WhatsApp（已實作）
- 🚧 Telegram（規劃中）
- 🚧 Discord（規劃中）
- 🚧 Slack（規劃中）

### 路由

廣播群組與現有路由協同工作：

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

- `GROUP_A`：只有 alfred 回覆（正常路由）
- `GROUP_B`：agent1 和 agent2 回覆（廣播）

**優先順序：** `broadcast` 的優先順序高於 `bindings`。

## 疑難排解

### 智慧代理沒有回覆

**檢查：**

1. 智慧代理 ID 存在於 `agents.list` 中
2. 對等 ID 格式正確（例如 `120363403215116621 @g.us`）
3. 智慧代理不在拒絕清單中

**偵錯：**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### 只有一個智慧代理回覆

**原因：** 對等 ID 可能在 `bindings` 中，但不在 `broadcast` 中。

**修復：** 新增到廣播設定或從綁定中移除。

### 效能問題

**如果智慧代理數量多時速度緩慢：**

- 減少每個群組的智慧代理數量
- 使用較輕量級的模型（sonnet 而非 opus）
- 檢查沙箱啟動時間

## 範例

### 範例 1：程式碼審查團隊

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621 @g.us": [
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

**使用者傳送：** 程式碼片段  
**回覆：**

- code-formatter：「已修正縮排並新增類型提示」
- security-scanner：「⚠️ 第 12 行存在 SQL 注入漏洞」
- test-coverage：「覆蓋率為 45%，遺漏錯誤情況的測試」
- docs-checker：「`process_data` 函數缺少文件字串」

### 範例 2：多語言支援

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

## API 參考

### 設定綱要

```typescript
interface OpenClawConfig {
  broadcast?: {
    strategy?: "parallel" | "sequential";
    [peerId: string]: string[];
  };
}
```

### 欄位

- `strategy`（選填）：如何處理智慧代理
  - `"parallel"`（預設）：所有智慧代理同時處理
  - `"sequential"`：智慧代理按陣列順序處理
- `[peerId]`：WhatsApp 群組 JID、E.164 號碼或其他對等 ID
  - 值：應處理訊息的智慧代理 ID 陣列

## 限制

1. **最大智慧代理數量：** 沒有硬性限制，但 10 個以上的智慧代理可能會變慢
2. **共用上下文：** 智慧代理彼此看不到對方的回覆（設計如此）
3. **訊息排序：** 並行回覆可能以任意順序到達
4. **速率限制：** 所有智慧代理都計入 WhatsApp 速率限制

## 未來增強功能

規劃中的功能：

- [ ] 共用上下文模式（智慧代理可以看到彼此的回覆）
- [ ] 智慧代理協調（智慧代理可以互相發出訊號）
- [ ] 動態智慧代理選擇（根據訊息內容選擇智慧代理）
- [ ] 智慧代理優先級（某些智慧代理比其他智慧代理優先回覆）

## 參閱

- [多智慧代理設定](/tools/multi-agent-sandbox-tools)
- [路由設定](/channels/channel-routing)
- [工作階段管理](/concepts/sessions)
