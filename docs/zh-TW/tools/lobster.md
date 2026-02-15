---
title: Lobster
summary: "適用於 OpenClaw 的型別工作流程執行環境，具備可恢復的審核關卡。"
description: 適用於 OpenClaw 的型別工作流程執行環境 — 具備審核關卡的組合式管線。
read_when:
  - 您需要具備明確審核的確定性多步驟工作流程
  - 您需要恢復工作流程而無需重新執行前期步驟
---

# Lobster

Lobster 是一個工作流程 shell，讓 OpenClaw 可以將多步驟工具序列作為單一、確定性的操作來執行，並具備明確的審核檢查點。

## Hook

您的助理可以建構管理自身的工具。請求一個工作流程，30 分鐘後您就會擁有一個 CLI 和作為單一呼叫執行的管線。Lobster 是其中缺失的一環：確定性管線、明確審核和可恢復的狀態。

## 為何使用

現今，複雜的工作流程需要許多來回的工具呼叫。每個呼叫都會消耗令牌，且大型語言模型 (LLM) 必須協調每個步驟。Lobster 將這種協調移至型別執行環境中：

- **一次呼叫取代多次呼叫**：OpenClaw 執行一次 Lobster 工具呼叫，並獲得結構化的結果。
- **內建審核**：副作用（例如傳送電子郵件、張貼評論）會暫停工作流程，直到明確審核為止。
- **可恢復**：暫停的工作流程會返回一個令牌；審核並恢復，無需重新執行所有內容。

## 為何選擇 DSL 而非普通程式？

Lobster 刻意設計得很小巧。目標不是「一種新語言」，而是一個可預測、對 AI 友善的管線規範，具備一流的審核和恢復令牌。

- **內建審核/恢復**：一般程式可以提示人類，但它無法在沒有您自行建構執行環境的情況下，以耐用的令牌「暫停並恢復」。
- **確定性 + 可稽核性**：管線是資料，因此易於記錄、差異分析、重播和審核。
- **對 AI 的受限介面**：微小的語法 + JSON 管道減少了「創意」程式碼路徑，並使驗證變得可行。
- **內建安全策略**：逾時、輸出上限、沙盒檢查和允許清單由執行環境強制執行，而非每個腳本。
- **仍然可編程**：每個步驟都可以呼叫任何 CLI 或腳本。如果您想要 JS/TS，可以從程式碼產生 `.lobster` 檔案。

## 運作方式

OpenClaw 以**工具模式**啟動本機 `lobster` CLI，並從標準輸出解析 JSON 封包。
如果管線因審核而暫停，該工具會返回一個 `resumeToken`，以便您稍後繼續。

## 模式：小型 CLI + JSON 管道 + 審核

建構可輸出 JSON 的小型命令，然後將它們鏈結為單一 Lobster 呼叫。(以下是範例命令名稱 — 請替換成您自己的命令。)

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

如果管線要求審核，請使用令牌恢復：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI 觸發工作流程；Lobster 執行步驟。審核關卡使副作用明確且可稽核。

範例：將輸入項目映射到工具呼叫：

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## 僅限 JSON 的 LLM 步驟 (llm-task)

對於需要**結構化 LLM 步驟**的工作流程，請啟用可選的
`llm-task` 外掛程式工具，並從 Lobster 呼叫它。這會保持工作流程
的確定性，同時仍允許您使用模型進行分類/摘要/草擬。

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

在管線中使用它：

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

## 工作流程檔案 (.lobster)

Lobster 可以執行包含 `name`、`args`、`steps`、`env`、`condition` 和 `approval` 欄位的 YAML/JSON 工作流程檔案。在 OpenClaw 工具呼叫中，將 `pipeline` 設定為檔案路徑。

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

備註：

- `stdin: $step.stdout` 和 `stdin: $step.json` 傳遞前一個步驟的輸出。
- `condition` (或 `when`) 可以根據 `$step.approved` 來控制步驟。

## 安裝 Lobster

在執行 OpenClaw Gateway 的**同一主機**上安裝 Lobster CLI (請參閱 [Lobster 儲存庫](https://github.com/openclaw/lobster))，並確保 `lobster` 在 `PATH` 中。
如果您想使用自訂的二進位位置，請在工具呼叫中傳遞**絕對**的 `lobsterPath`。

## 啟用工具

Lobster 是一個**可選的**外掛程式工具（預設未啟用）。

建議（附加、安全）：

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

或每個代理程式：

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

除非您打算在限制性允許清單模式下執行，否則請避免使用 `tools.allow: ["lobster"]`。

注意：允許清單對於可選外掛程式是選擇性加入的。如果您的允許清單僅包含
外掛程式工具（例如 `lobster`），OpenClaw 會保持核心工具啟用。要限制核心
工具，請在允許清單中包含您想要的核心工具或群組。

## 範例：電子郵件分類

沒有 Lobster：

```
使用者：「檢查我的電子郵件並草擬回覆」
→ openclaw 呼叫 gmail.list
→ LLM 摘要
→ 使用者：「草擬對 #2 和 #5 的回覆」
→ LLM 草擬
→ 使用者：「傳送 #2」
→ openclaw 呼叫 gmail.send
（每天重複，沒有對已分類內容的記憶）
```

使用 Lobster：

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

返回 JSON 封包（截斷）：

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

使用者審核 → 恢復：

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

一個工作流程。確定性。安全。

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

執行帶有參數的工作流程檔案：

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

審核後繼續已暫停的工作流程。

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### 可選輸入

- `lobsterPath`：Lobster 二進位檔的絕對路徑（省略則使用 `PATH`）。
- `cwd`：管線的工作目錄（預設為目前程序的目前工作目錄）。
- `timeoutMs`：如果子程序超過此持續時間，則終止它（預設：20000）。
- `maxStdoutBytes`：如果標準輸出超過此大小，則終止子程序（預設：512000）。
- `argsJson`：傳遞給 `lobster run --args-json` 的 JSON 字串（僅適用於工作流程檔案）。

## 輸出封包

Lobster 會返回一個包含三種狀態之一的 JSON 封包：

- `ok` → 成功完成
- `needs_approval` → 已暫停；需要 `requiresApproval.resumeToken` 才能恢復
- `cancelled` → 已明確拒絕或取消

該工具在 `content` (美觀的 JSON) 和 `details` (原始物件) 中都呈現封包。

## 審核

如果 `requiresApproval` 存在，請檢查提示並決定：

- `approve: true` → 恢復並繼續副作用
- `approve: false` → 取消並結束工作流程

使用 `approve --preview-from-stdin --limit N` 可以將 JSON 預覽附加到審核請求，而無需自訂 jq/heredoc 粘合。恢復令牌現在很簡潔：Lobster 將工作流程恢復狀態儲存在其狀態目錄下，並返回一個小的令牌鍵。

## OpenProse

OpenProse 與 Lobster 搭配得很好：使用 `/prose` 協調多代理準備，然後執行 Lobster 管線以進行確定性審核。如果 Prose 程式需要 Lobster，則透過 `tools.subagents.tools` 允許子代理使用 `lobster` 工具。請參閱 [OpenProse](/prose)。

## 安全性

- **僅限本機子程序** — 外掛程式本身沒有網路呼叫。
- **無機密資訊** — Lobster 不管理 OAuth；它呼叫管理 OAuth 的 OpenClaw 工具。
- **沙盒感知** — 當工具內容為沙盒時，會停用。
- **強化** — 如果指定，`lobsterPath` 必須是絕對路徑；強制執行逾時和輸出上限。

## 疑難排解

- **`lobster subprocess timed out`** → 增加 `timeoutMs`，或拆分長管線。
- **`lobster output exceeded maxStdoutBytes`** → 提高 `maxStdoutBytes` 或減少輸出大小。
- **`lobster returned invalid JSON`** → 確保管線以工具模式執行，並且只輸出 JSON。
- **`lobster failed (code …)`** → 在終端機中執行相同的管線以檢查標準錯誤。

## 了解更多

- [外掛程式](/tools/plugin)
- [外掛程式工具開發](/plugins/agent-tools)

## 案例研究：社群工作流程

一個公開範例：「第二大腦」CLI + Lobster 管線，管理三個 Markdown 保險庫（個人、夥伴、共享）。CLI 輸出 JSON 用於統計、收件箱列表和過時掃描；Lobster 將這些命令鏈結到 `weekly-review`、`inbox-triage`、`memory-consolidation` 和 `shared-task-sync` 等工作流程，每個都帶有審核關卡。AI 在可用時處理判斷（分類），並在不可用時回退到確定性規則。

- 討論串：[https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- 儲存庫：[https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
