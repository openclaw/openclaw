---
summary: "Sub-agents：產生獨立的智慧代理執行任務，並將結果通知回請求者的聊天中"
read_when:
  - 您希望透過智慧代理進行背景或平行作業
  - 您正在修改 sessions_spawn 或 sub-agent 工具規則
title: "Sub-Agents"
---

# Sub-Agents

Sub-agents 讓您可以在不阻塞主對話的情況下執行背景任務。當您產生一個 sub-agent 時，它會在獨立的工作階段中執行，完成工作後會將結果通知回聊天室。

**使用案例：**

- 在主智慧代理繼續回答問題時研究某個主題
- 同時平行執行多個長時間任務（網頁抓取、程式碼分析、檔案處理）
- 在多智慧代理架構中將任務委派給專業的智慧代理

## 快速開始

使用 sub-agents 最簡單的方式是直接以自然語言詢問您的智慧代理：

> 「產生一個 sub-agent 來研究最新的 Node.js 版本說明」

智慧代理會在幕後呼叫 `sessions_spawn` 工具。當 sub-agent 完成時，它會將發現的資訊通知回您的聊天室。

您也可以明確指定選項：

> 「產生一個 sub-agent 來分析今天的伺服器日誌。使用 gpt-5.2 並設定 5 分鐘超時。」

## 運作方式

<Steps>
  <Step title="主智慧代理產生任務">
    主智慧代理呼叫 `sessions_spawn` 並附帶任務描述。此呼叫是**非阻塞的** —— 主智慧代理會立即收到 `{ status: "accepted", runId, childSessionKey }`。
  </Step>
  <Step title="Sub-agent 在背景執行">
    系統會在專用的 `subagent` 佇列通道中建立一個新的獨立工作階段 (`agent:<agentId>:subagent:<uuid>`)。
  </Step>
  <Step title="通知結果">
    當 sub-agent 完成時，它會將發現的結果通知回請求者的聊天室。主智慧代理會發布一段自然語言摘要。
  </Step>
  <Step title="工作階段封存">
    Sub-agent 工作階段會在 60 分鐘後（可設定）自動封存。對話紀錄會被保留。
  </Step>
</Steps>

<Tip>
每個 sub-agent 都有其**自己的**上下文和 Token 使用量。為 sub-agent 設定較便宜的模型以節省成本 —— 請參閱下方的[設定預設模型](#設定預設模型)。
</Tip>

## 設定

Sub-agents 無需任何設定即可直接使用。預設值：

- 模型：目標智慧代理的正常模型選擇（除非設定了 `subagents.model`）
- 思考 (Thinking)：無 sub-agent 覆寫（除非設定了 `subagents.thinking`）
- 最大並行數：8
- 自動封存：60 分鐘後

### 設定預設模型

為 sub-agent 使用較便宜的模型以節省 Token 成本：

```json5
{
  agents: {
    defaults: {
      subagents: {
        model: "minimax/MiniMax-M2.1",
      },
    },
  },
}
```

### 設定預設思考層級

```json5
{
  agents: {
    defaults: {
      subagents: {
        thinking: "low",
      },
    },
  },
}
```

### 個別智慧代理覆寫

在多智慧代理架構中，您可以為每個智慧代理設定 sub-agent 預設值：

```json5
{
  agents: {
    list: [
      {
        id: "researcher",
        subagents: {
          model: "anthropic/claude-sonnet-4",
        },
      },
      {
        id: "assistant",
        subagents: {
          model: "minimax/MiniMax-M2.1",
        },
      },
    ],
  },
}
```

### 並行限制

控制可以同時執行的 sub-agent 數量：

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 4, // 預設：8
      },
    },
  },
}
```

Sub-agents 使用獨立於主智慧代理佇列的專用佇列通道 (`subagent`)，因此 sub-agent 的執行不會阻塞傳入的回覆。

### 自動封存

Sub-agent 工作階段會在設定的時間後自動封存：

```json5
{
  agents: {
    defaults: {
      subagents: {
        archiveAfterMinutes: 120, // 預設：60
      },
    },
  },
}
```

<Note>
封存會將對話紀錄重新命名為 `*.deleted.<timestamp>`（位於同一資料夾）—— 對話紀錄會被保留而非刪除。自動封存定時器是盡力而為的；如果 Gateway 重新啟動，待處理的定時器將會遺失。
</Note>

## `sessions_spawn` 工具

這是智慧代理用來建立 sub-agent 的工具。

###
