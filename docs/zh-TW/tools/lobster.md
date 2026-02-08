---
title: 龍蝦
summary: 「適用於 OpenClaw 的型別化工作流程執行階段，具備可恢復的核准關卡。」
description: 適用於 OpenClaw 的型別化工作流程執行階段 — 具備核准關卡的可組合管線。
read_when:
  - 你需要具有明確核准的可預測多步驟工作流程
  - 你需要在不重新執行先前步驟的情況下恢復工作流程
x-i18n:
  source_path: tools/lobster.md
  source_hash: e787b65558569e8a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:50Z
---

# Lobster

Lobster 是一個工作流程殼層，讓 OpenClaw 能將多步驟工具序列作為單一、可預測的操作來執行，並具備明確的核准檢查點。

## Hook

你的助理可以建立用來管理自身的工具。只要要求一個工作流程，30 分鐘後你就會得到一個 CLI 加上一組可作為單次呼叫執行的管線。Lobster 正是缺失的那一塊：可預測的管線、明確的核准，以及可恢復的狀態。

## Why

現今，複雜的工作流程需要大量來回的工具呼叫。每一次呼叫都會消耗 token，而 LLM 必須編排每一個步驟。Lobster 將這個編排移入型別化的執行階段：

- **一次呼叫取代多次**：OpenClaw 只需執行一次 Lobster 工具呼叫，即可取得結構化結果。
- **內建核准**：具副作用的操作（寄送電子郵件、張貼留言）會暫停工作流程，直到明確核准。
- **可恢復**：被暫停的工作流程會回傳一個權杖；核准後即可恢復，而無需重新執行所有步驟。

## 為什麼使用 DSL 而不是一般程式？

Lobster 刻意保持精簡。目標不是「一種新語言」，而是一個對 AI 友善、可預測的管線規格，並且將核准與恢復權杖視為一等公民。

- **核准／恢復內建**：一般程式可以提示人類，但無法在沒有自行發明執行階段的情況下，使用耐久權杖來「暫停並恢復」。
- **可預測性 + 可稽核性**：管線是資料，因此容易記錄、比對、重播與審查。
- **為 AI 限縮介面**：極小的語法 + JSON 管道可減少「創意式」程式路徑，讓驗證成為可行。
- **內建安全政策**：逾時、輸出上限、沙箱檢查與允許清單由執行階段統一強制，而非各腳本各自處理。
- **仍可程式化**：每個步驟都能呼叫任何 CLI 或腳本。若你想使用 JS/TS，可從程式碼產生 `.lobster` 檔案。

## 運作方式

OpenClaw 以**工具模式**啟動本機的 `lobster` CLI，並從 stdout 解析一個 JSON 封裝。
若管線因等待核准而暫停，工具會回傳一個 `resumeToken`，讓你稍後繼續。

## 模式：小型 CLI + JSON 管道 + 核准

建立會說 JSON 的小型指令，然後將它們串接成一次 Lobster 呼叫。（以下為指令名稱範例 — 請替換為你自己的。）

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

若管線要求核准，使用權杖恢復：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI 觸發工作流程；Lobster 執行各步驟。核准關卡讓副作用保持明確且可稽核。

範例：將輸入項目對應為工具呼叫：

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## 僅 JSON 的 LLM 步驟（llm-task）

對於需要**結構化 LLM 步驟**的工作流程，啟用可選的
`llm-task` 外掛工具，並從 Lobster 呼叫它。這能在保持工作流程可預測的同時，仍讓你使用模型進行分類／摘要／草稿撰寫。

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

詳情與設定選項請參見 [LLM Task](/tools/llm-task)。

## 工作流程檔案（.lobster）

Lobster 可執行包含 `name`、`args`、`steps`、`env`、`condition` 與 `approval` 欄位的 YAML/JSON 工作流程檔案。在 OpenClaw 工具呼叫中，將 `pipeline` 設為檔案路徑。

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

注意事項：

- `stdin: $step.stdout` 與 `stdin: $step.json` 會傳遞前一個步驟的輸出。
- `condition`（或 `when`）可依據 `$step.approved` 來設定步驟的核准關卡。

## 安裝 Lobster

請在執行 OpenClaw Gateway 閘道器 的**同一台主機**上安裝 Lobster CLI（參見 [Lobster repo](https://github.com/openclaw/lobster)），並確保 `lobster` 位於 `PATH`。
若你想使用自訂的二進位位置，請在工具呼叫中傳入**絕對路徑**的 `lobsterPath`。

## 啟用工具

Lobster 是一個**可選**的外掛工具（預設未啟用）。

建議作法（累加且安全）：

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

或針對個別代理程式：

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

除非你打算在嚴格的允許清單模式下執行，否則避免使用 `tools.allow: ["lobster"]`。

注意：允許清單對可選外掛是採用加入式。如果你的允許清單只列出
外掛工具（例如 `lobster`），OpenClaw 仍會保持核心工具啟用。若要限制核心
工具，請將你想要的核心工具或群組也一併加入允許清單。

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

回傳一個 JSON 封裝（已截斷）：

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

使用者核准 → 恢復：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

單一工作流程。可預測。安全。

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

使用參數執行工作流程檔案：

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

在核准後繼續被暫停的工作流程。

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### 可選輸入

- `lobsterPath`：Lobster 二進位檔的絕對路徑（省略則使用 `PATH`）。
- `cwd`：管線的工作目錄（預設為目前行程的工作目錄）。
- `timeoutMs`：若子行程超過此時間則終止（預設：20000）。
- `maxStdoutBytes`：若 stdout 超過此大小則終止（預設：512000）。
- `argsJson`：傳遞給 `lobster run --args-json` 的 JSON 字串（僅工作流程檔案）。

## 輸出封裝

Lobster 會回傳一個具有三種狀態之一的 JSON 封裝：

- `ok` → 成功完成
- `needs_approval` → 已暫停；需要 `requiresApproval.resumeToken` 才能恢復
- `cancelled` → 明確拒絕或已取消

工具會同時在 `content`（美化後的 JSON）與 `details`（原始物件）中呈現該封裝。

## 核准

若出現 `requiresApproval`，請檢視提示並做出決定：

- `approve: true` → 恢復並繼續副作用
- `approve: false` → 取消並結束工作流程

使用 `approve --preview-from-stdin --limit N` 可在核准請求中附加 JSON 預覽，而無需自訂 jq／heredoc 黏合。恢復權杖現在更精簡：Lobster 會將工作流程的恢復狀態儲存在其狀態目錄下，並回傳一個小型權杖鍵值。

## OpenProse

OpenProse 與 Lobster 搭配良好：使用 `/prose` 來編排多代理程式的前置作業，接著執行 Lobster 管線以進行可預測的核准。若某個 Prose 程式需要 Lobster，請透過 `tools.subagents.tools` 為子代理程式允許 `lobster` 工具。請參見 [OpenProse](/prose)。

## 安全性

- **僅本機子行程** — 外掛本身不進行網路呼叫。
- **不處理祕密** — Lobster 不管理 OAuth；它會呼叫負責此事的 OpenClaw 工具。
- **具沙箱意識** — 當工具情境為沙箱隔離時會停用。
- **強化防護** — 若指定 `lobsterPath` 則必須為絕對路徑；並強制執行逾時與輸出上限。

## 疑難排解

- **`lobster subprocess timed out`** → 提高 `timeoutMs`，或拆分較長的管線。
- **`lobster output exceeded maxStdoutBytes`** → 提高 `maxStdoutBytes` 或減少輸出大小。
- **`lobster returned invalid JSON`** → 確保管線在工具模式下執行，且僅輸出 JSON。
- **`lobster failed (code …)`** → 在終端機中執行相同的管線以檢視 stderr。

## 了解更多

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/agent-tools)

## 案例研究：社群工作流程

一個公開的範例：「第二大腦」CLI + Lobster 管線，用來管理三個 Markdown 知識庫（個人、夥伴、共享）。該 CLI 會輸出用於統計、收件匣清單與過期掃描的 JSON；Lobster 將這些指令串接成如 `weekly-review`、`inbox-triage`、`memory-consolidation` 與 `shared-task-sync` 等工作流程，且每個流程都具備核准關卡。AI 在可用時負責判斷（分類），在不可用時則回退至可預測的規則。

- 討論串：[https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo：[https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
