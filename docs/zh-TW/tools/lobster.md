---
title: Lobster
summary: "OpenClaw 的強型別工作流執行階段，具備可恢復的審核門檻。"
description: OpenClaw 的強型別工作流執行階段 — 具備審核門檻的可組合管線。
read_when:
  - 您想要具有明確審核機制且具備確定性的多步驟工作流
  - 您需要恢復工作流而無需重新執行先前的步驟
---

# Lobster

Lobster 是一個工作流 Shell，讓 OpenClaw 能將多步驟工具序列作為單一且具確定性的操作執行，並具備明確的審核檢查點。

## 鉤子 (Hook)

您的助理可以建構管理自身的工具。要求一個工作流，30 分鐘後您就擁有一個 CLI 以及能以單次呼叫執行的管線。Lobster 是缺失的一塊：確定性管線、明確審核以及可恢復狀態。

## 為什麼 (Why)

如今，複雜的工作流需要多次往返的工具呼叫。每次呼叫都會消耗 token，且 LLM 必須編排每個步驟。Lobster 將這種編排移至強型別執行階段：

- **單次呼叫取代多次呼叫**：OpenClaw 執行一次 Lobster 工具呼叫並獲得結構化結果。
- **內建審核**：副作用（傳送電子郵件、發表評論）會暫停工作流，直到明確獲得審核通過。
- **可恢復**：暫停的工作流會回傳一個 token；核准並恢復，無需重新執行所有內容。

## 為什麼使用 DSL 而不是一般程式？

Lobster 刻意保持小巧。目標不是「一種新語言」，而是一個可預測、AI 友善的管線規格，具備一等公民審核支援和恢復 token。

- **內建審核/恢復**：一般的程式可以提示人類，但除非您自己發明執行階段，否則它無法使用持久 token 來 _暫停並恢復_。
- **確定性 + 可稽核性**：管線即資料，因此易於記錄、比對 (diff)、重播和檢閱。
- **限制 AI 的接觸面**：極小的語法 + JSON 管道減少了「創意性」程式碼路徑，並使驗證變得實際。
- **內建安全政策**：逾時、輸出限制、沙箱檢查和允許清單由執行階段強制執行，而非各個腳本。
- **仍具備可程式化性**：每個步驟都可以呼叫任何 CLI 或腳本。如果您想要 JS/TS，可以從程式碼產生 `.lobster` 檔案。

## 運作方式

OpenClaw 以 **工具模式 (tool mode)** 啟動本地 `lobster` CLI，並從 stdout 解析 JSON 封包。
如果管線因審核而暫停，該工具會回傳一個 `resumeToken`，以便您稍後繼續。

## 模式：小型 CLI + JSON 管道 + 審核

建構支援 JSON 的微型指令，然後將它們串接成單個 Lobster 呼叫。（以下為範例指令名稱 — 請換成您自己的指令。）

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

如果管線要求審核，請使用 token 恢復：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI 觸發工作流；Lobster 執行步驟。審核門檻讓副作用保持明確且可稽核。

範例：將輸入項目對應到工具呼叫：

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## 僅限 JSON 的 LLM 步驟 (llm-task)

對於需要 **結構化 LLM 步驟** 的工作流，請啟用選用的
`llm-task` 外掛工具並從 Lobster 呼叫它。這能保持工作流的
確定性，同時仍讓您能使用模型進行分類/摘要/起草。

啟用工具：

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

在管線中使用：

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
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

詳情與設定選項請參閱 [LLM Task](/tools/llm-task)。

## 工作流檔案 (.lobster)

Lobster 可以執行具有 `name`、`args`、`steps`、`env`、`condition` 和 `approval` 欄位的 YAML/JSON 工作流檔案。在 OpenClaw 工具呼叫中，將 `pipeline` 設為檔案路徑。

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

注意：

- `stdin: $step.stdout` 和 `stdin: $step.json` 會傳遞前一個步驟的輸出。
- `condition`（或 `when`）可以根據 `$step.approved` 來決定是否執行步驟。

## 安裝 Lobster

在執行 OpenClaw Gateway 的 **同一台主機** 上安裝 Lobster CLI（請參閱 [Lobster 儲存庫](https://github.com/openclaw/lobster)），並確保 `lobster` 已加入 `PATH`。
如果您想使用自定義的二進位檔位置，請在工具呼叫中傳遞 **絕對路徑** `lobsterPath`。

## 啟用工具

Lobster 是一個 **選用** 的外掛工具（預設未啟用）。

推薦方式（累加且安全）：

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

或針對每個智慧代理設定：

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

除非您打算在限制性的允許清單模式下執行，否則請避免使用 `tools.allow: ["lobster"]`。

注意：對於選用外掛，允許清單是選擇性加入 (opt-in) 的。如果您的允許清單僅列出
外掛工具（如 `lobster`），OpenClaw 會保持核心工具啟用。若要限制核心
工具，請在允許清單中包含您想要的核心工具或群組。

## 範例：電子郵件分類與處理

沒有 Lobster：

```
使用者：「檢查我的電子郵件並起草回覆」
→ openclaw 呼叫 gmail.list
→ LLM 進行摘要
→ 使用者：「起草對 #2 和 #5 的回覆」
→ LLM 起草
→ 使用者：「傳送 #2」
→ openclaw 呼叫 gmail.send
（每日重複，不記得哪些已經處理過）
```

使用 Lobster：

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

回傳一個 JSON 封包（已簡略）：

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

使用者審核通過 → 恢復：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

單一工作流。具確定性。安全。

## 工具參數

### `run`

以工具模式執行管線。

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

執行帶有參數的工作流檔案：

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

審核後繼續暫停的工作流。

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### 選用輸入

- `lobsterPath`: Lobster 執行檔的絕對路徑（若省略則使用 `PATH`）。
- `cwd`: 管線的執行目錄（預設為目前處理程序的執行目錄）。
- `timeoutMs`: 如果子程序超過此時間則終止（預設：20000）。
- `maxStdoutBytes`: 如果 stdout 超過此大小則終止子程序（預設：512000）。
- `argsJson`: 傳遞給 `lobster run --args-json` 的 JSON 字串（僅限工作流檔案）。

## 輸出封包

Lobster 會回傳一個具有以下三種狀態之一的 JSON 封包：

- `ok` → 成功完成
- `needs_approval` → 已暫停；需要 `requiresApproval.resumeToken` 才能恢復
- `cancelled` → 明確拒絕或已取消

該工具會在 `content`（美化的 JSON）和 `details`（原始物件）中呈現封包。

## 審核

如果存在 `requiresApproval`，請檢查提示並決定：

- `approve: true` → 恢復並繼續副作用
- `approve: false` → 取消並結束工作流

使用 `approve --preview-from-stdin --limit N` 在審核請求中附加 JSON 預覽，無需自定義 jq/heredoc 串接。恢復 token 現在非常精簡：Lobster 將工作流恢復狀態儲存在其狀態目錄下，並回傳一個短小的 token 鍵值。

## OpenProse

OpenProse 與 Lobster 配合良好：使用 `/prose` 編排多代理準備工作，然後執行 Lobster 管線以進行具確定性的審核。如果 Prose 程式需要 Lobster，請透過 `tools.subagents.tools` 允許子代理使用 `lobster` 工具。參見 [OpenProse](/prose)。

## 安全性

- **僅限本地子程序** — 外掛程式本身不會發起網路呼叫。
- **無秘密資訊** — Lobster 不管理 OAuth；它呼叫執行該操作的 OpenClaw 工具。
- **沙箱隔離感知** — 當工具內容被沙箱隔離時會停用。
- **強化設定** — 如果指定了 `lobsterPath`，則必須是絕對路徑；強制執行逾時與輸出限制。

## 疑難排解

- **`lobster subprocess timed out`** → 增加 `timeoutMs`，或拆分過長的管線。
- **`lobster output exceeded maxStdoutBytes`** → 調高 `maxStdoutBytes` 或減少輸出大小。
- **`lobster returned invalid JSON`** → 確保管線以工具模式執行且僅列印 JSON。
- **`lobster failed (code …)`** → 在終端機執行相同的管線以檢查 stderr。

## 了解更多

- [Plugins](/tools/plugin)
- [外掛工具開發](/plugins/agent-tools)

## 個案研究：社群工作流

一個公開範例：一個「第二大腦」CLI + 管理三個 Markdown 儲藏庫（個人、伴侶、共享）的 Lobster 管線。CLI 發出 JSON 以提供統計數據、收件匣列表和過期掃描；Lobster 將這些指令串接成工作流，如 `weekly-review`、`inbox-triage`、`memory-consolidation` 和 `shared-task-sync`，每個都帶有審核門檻。AI 在可行時處理判斷（分類），不可行時則退而求其次使用確定性規則。

- 討論串：[https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- 儲存庫：[https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
