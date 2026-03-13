---
title: Lobster
summary: Typed workflow runtime for OpenClaw with resumable approval gates.
description: >-
  Typed workflow runtime for OpenClaw — composable pipelines with approval
  gates.
read_when:
  - You want deterministic multi-step workflows with explicit approvals
  - You need to resume a workflow without re-running earlier steps
---

# Lobster

Lobster 是一個工作流程外殼，讓 OpenClaw 能以單一且確定性的操作，執行多步驟工具序列，並設有明確的審核檢查點。

## Hook

你的助理可以建立自我管理的工具。只要請求一個工作流程，30 分鐘後你就會擁有一個 CLI 以及作為單一呼叫執行的管線。Lobster 是缺少的那塊拼圖：確定性的管線、明確的審核，以及可恢復的狀態。

## Why

現今，複雜的工作流程需要多次來回呼叫工具。每次呼叫都會消耗 token，且 LLM 必須協調每個步驟。Lobster 將這種協調移入一個型別化的執行環境：

- **一次呼叫取代多次**：OpenClaw 執行一次 Lobster 工具呼叫，並取得結構化結果。
- **內建審核**：副作用（寄送電子郵件、發表評論）會暫停工作流程，直到明確批准。
- **可恢復**：暫停的工作流程會回傳 token；批准後可繼續執行，無需重跑所有步驟。

## Why a DSL instead of plain programs?

Lobster 故意設計得很小。目標不是「一種新語言」，而是提供一個可預測、AI 友善的管線規格，具備一流的審核與恢復 token。

- **內建審核/恢復**：一般程式可以提示人類，但無法用持久 token _暫停並恢復_，除非你自己發明那套執行環境。
- **確定性 + 可稽核**：管線是資料，因此易於記錄、差異比較、重播與審查。
- **限制 AI 的操作範圍**：小型語法 + JSON 管線減少「創意」程式路徑，使驗證更實際。
- **內建安全政策**：逾時、輸出上限、沙盒檢查與允許清單由執行環境強制，而非每個腳本。
- **仍可程式化**：每個步驟都能呼叫任何 CLI 或腳本。若想用 JS/TS，可從程式碼產生 `.lobster` 檔案。

## How it works

OpenClaw 以 **工具模式** 啟動本地 `lobster` CLI，並從 stdout 解析 JSON 封包。
若管線暫停等待審核，工具會回傳 `resumeToken`，讓你稍後繼續。

## Pattern: small CLI + JSON pipes + approvals

建立能處理 JSON 的小型指令，然後串接成單一 Lobster 呼叫。（以下為範例指令名稱 — 請替換成你自己的。）

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

如果流程需要批准，請使用 token 繼續：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI 觸發工作流程；Lobster 執行步驟。批准閘門讓副作用明確且可審計。

範例：將輸入專案映射到工具呼叫：

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## 僅限 JSON 的 LLM 步驟（llm-task）

對於需要**結構化 LLM 步驟**的工作流程，啟用可選的
`llm-task` 外掛工具，並從 Lobster 呼叫它。這讓工作流程保持
確定性，同時仍能使用模型進行分類／摘要／草擬。

啟用該工具：

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

在流程中使用它：

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "thinking": "low",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

詳情與設定選項請參考 [LLM Task](/tools/llm-task)。

## 工作流程檔案 (.lobster)

Lobster 可以執行帶有 `name`、`args`、`steps`、`env`、`condition` 和 `approval` 欄位的 YAML/JSON 工作流程檔案。在 OpenClaw 工具呼叫中，將 `pipeline` 設為檔案路徑。

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

說明：

- `stdin: $step.stdout` 和 `stdin: $step.json` 傳遞前一個步驟的輸出。
- `condition`（或 `when`）可以根據 `$step.approved` 來控制步驟執行。

## 安裝 Lobster

請在執行 OpenClaw Gateway 的**同一台主機**上安裝 Lobster CLI（參考 [Lobster repo](https://github.com/openclaw/lobster)），並確保 `lobster` 位於 `PATH`。

## 啟用此工具

Lobster 是一個**可選**的外掛工具（預設未啟用）。

建議（可累加，安全）：

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

或針對每個代理：

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

除非您打算在嚴格的允許清單模式下執行，否則避免使用 `tools.allow: ["lobster"]`。

注意：允許清單是可選外掛的選擇性設定。如果您的允許清單只列出外掛工具（例如 `lobster`），OpenClaw 會保持核心工具啟用。若要限制核心工具，請在允許清單中同時包含您想限制的核心工具或群組。

## 範例：電子郵件分流

未使用 Lobster：

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

使用 Lobster：

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

回傳 JSON 封包（已截斷）：

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

使用者批准 → 繼續執行：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

單一工作流程。確定性。安全。

## 工具參數

### `run`

以工具模式執行管線。

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

使用參數執行工作流程檔案：

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

繼續在核准後暫停的工作流程。

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### 選用輸入

- `cwd`：管線的相對工作目錄（必須在當前程序工作目錄內）。
- `timeoutMs`：若子程序執行超過此時間則終止（預設：20000）。
- `maxStdoutBytes`：若子程序標準輸出超過此大小則終止（預設：512000）。
- `argsJson`：傳遞給 `lobster run --args-json` 的 JSON 字串（僅限工作流程檔案）。

## 輸出封包

Lobster 回傳一個 JSON 封包，狀態為以下三種之一：

- `ok` → 成功完成
- `needs_approval` → 暫停；需 `requiresApproval.resumeToken` 以繼續
- `cancelled` → 明確拒絕或取消

此工具會同時以 `content`（格式化 JSON）和 `details`（原始物件）呈現封包。

## 核准

若存在 `requiresApproval`，請檢視提示並決定：

- `approve: true` → 恢復並繼續副作用
- `approve: false` → 取消並結束工作流程

使用 `approve --preview-from-stdin --limit N` 來附加 JSON 預覽於核准請求，無需自訂 jq/heredoc 結合。恢復 token 現在更精簡：Lobster 將工作流程恢復狀態存放於其狀態目錄，並回傳一個小型 token 鍵。

## OpenProse

OpenProse 與 Lobster 搭配良好：使用 `/prose` 來協調多代理準備，接著執行 Lobster 管線以達成確定性核准。若 Prose 程式需要 Lobster，允許子代理透過 `tools.subagents.tools` 使用 `lobster` 工具。詳見 [OpenProse](/prose)。

## 安全性

- **僅限本地子程序** — 插件本身不進行網路呼叫。
- **無秘密資訊** — Lobster 不管理 OAuth；它呼叫負責 OAuth 的 OpenClaw 工具。
- **支援沙盒環境** — 在工具上下文為沙盒時會被停用。
- **強化安全** — 在 `PATH` 上使用固定的可執行檔名稱 (`lobster`)；強制執行逾時和輸出限制。

## 疑難排解

- **`lobster subprocess timed out`** → 增加 `timeoutMs`，或拆分過長的流程。
- **`lobster output exceeded maxStdoutBytes`** → 提高 `maxStdoutBytes` 或減少輸出大小。
- **`lobster returned invalid JSON`** → 確保流程在工具模式下執行，且僅輸出 JSON。
- **`lobster failed (code …)`** → 在終端機執行相同流程以檢查 stderr。

## 進一步了解

- [插件](/tools/plugin)
- [插件工具開發](/plugins/agent-tools)

## 案例研究：社群工作流程

一個公開範例：「第二大腦」CLI + Lobster 流程，管理三個 Markdown 保險庫（個人、夥伴、共享）。CLI 輸出統計、收件匣列表和過期掃描的 JSON；Lobster 將這些指令串接成 `weekly-review`、`inbox-triage`、`memory-consolidation` 和 `shared-task-sync` 等工作流程，每個流程都有審核門檻。AI 在可用時負責判斷（分類），不可用時則退回使用確定性規則。

- 推文串：[https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- 程式庫：[https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
