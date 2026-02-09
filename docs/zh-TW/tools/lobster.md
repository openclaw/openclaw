---
title: Lobster
summary: "Typed workflow runtime for OpenClaw with resumable approval gates."
description: 適用於 OpenClaw 的型別化工作流程執行階段 — 具備核准關卡的可組合管線。
read_when:
  - You want deterministic multi-step workflows with explicit approvals
  - 你需要在不重新執行先前步驟的情況下恢復工作流程
---

# Lobster

Lobster is a workflow shell that lets OpenClaw run multi-step tool sequences as a single, deterministic operation with explicit approval checkpoints.

## Hook

Your assistant can build the tools that manage itself. Ask for a workflow, and 30 minutes later you have a CLI plus pipelines that run as one call. Lobster is the missing piece: deterministic pipelines, explicit approvals, and resumable state.

## Why

Today, complex workflows require many back-and-forth tool calls. Each call costs tokens, and the LLM has to orchestrate every step. Lobster moves that orchestration into a typed runtime:

- **一次呼叫取代多次**：OpenClaw 只需執行一次 Lobster 工具呼叫，即可取得結構化結果。
- **內建核准**：具副作用的操作（寄送電子郵件、張貼留言）會暫停工作流程，直到明確核准。
- **Resumable**: Halted workflows return a token; approve and resume without re-running everything.

## 為什麼使用 DSL 而不是一般程式？

Lobster is intentionally small. The goal is not "a new language," it's a predictable, AI-friendly pipeline spec with first-class approvals and resume tokens.

- **Approve/resume is built in**: A normal program can prompt a human, but it can’t _pause and resume_ with a durable token without you inventing that runtime yourself.
- **可預測性 + 可稽核性**：管線是資料，因此容易記錄、比對、重播與審查。
- **為 AI 限縮介面**：極小的語法 + JSON 管道可減少「創意式」程式路徑，讓驗證成為可行。
- **Safety policy baked in**: Timeouts, output caps, sandbox checks, and allowlists are enforced by the runtime, not each script.
- **Still programmable**: Each step can call any CLI or script. 39. 如果你需要 JS/TS，請從程式碼產生 `.lobster` 檔案。

## How it works

OpenClaw 以**工具模式**啟動本機的 `lobster` CLI，並從 stdout 解析一個 JSON 封裝。
若管線因等待核准而暫停，工具會回傳一個 `resumeToken`，讓你稍後繼續。
If the pipeline pauses for approval, the tool returns a `resumeToken` so you can continue later.

## 模式：小型 CLI + JSON 管道 + 核准

建立會說 JSON 的小型指令，然後將它們串接成一次 Lobster 呼叫。（以下為指令名稱範例 — 請替換為你自己的。） (Example command names below — swap in your own.)

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

AI 觸發工作流程；Lobster 執行各步驟。核准關卡讓副作用保持明確且可稽核。 Approval gates keep side effects explicit and auditable.

範例：將輸入項目對應為工具呼叫：

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## 僅 JSON 的 LLM 步驟（llm-task）

對於需要**結構化 LLM 步驟**的工作流程，啟用可選的
`llm-task` 外掛工具，並從 Lobster 呼叫它。這能在保持工作流程可預測的同時，仍讓你使用模型進行分類／摘要／草稿撰寫。 This keeps the workflow
deterministic while still letting you classify/summarize/draft with a model.

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

Lobster 可執行包含 `name`、`args`、`steps`、`env`、`condition` 與 `approval` 欄位的 YAML/JSON 工作流程檔案。在 OpenClaw 工具呼叫中，將 `pipeline` 設為檔案路徑。 40. 在 OpenClaw 的工具呼叫中，將 `pipeline` 設為檔案路徑。

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
If you want to use a custom binary location, pass an **absolute** `lobsterPath` in the tool call.

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

Note: allowlists are opt-in for optional plugins. If your allowlist only names
plugin tools (like `lobster`), OpenClaw keeps core tools enabled. To restrict core
tools, include the core tools or groups you want in the allowlist too.

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

One workflow. Deterministic. Safe.

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

Continue a halted workflow after approval.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### 41. 可選輸入

- `lobsterPath`：Lobster 二進位檔的絕對路徑（省略則使用 `PATH`）。
- `cwd`：管線的工作目錄（預設為目前行程的工作目錄）。
- 42. `timeoutMs`：若子程序超過此時間則終止（預設：20000）。
- `maxStdoutBytes`：若 stdout 超過此大小則終止（預設：512000）。
- `argsJson`：傳遞給 `lobster run --args-json` 的 JSON 字串（僅工作流程檔案）。

## Output envelope

Lobster 會回傳一個具有三種狀態之一的 JSON 封裝：

- `ok` → 成功完成
- `needs_approval` → 已暫停；需要 `requiresApproval.resumeToken` 才能恢復
- `cancelled` → 明確拒絕或已取消

工具會同時在 `content`（美化後的 JSON）與 `details`（原始物件）中呈現該封裝。

## Approvals

若出現 `requiresApproval`，請檢視提示並做出決定：

- `approve: true` → 恢復並繼續副作用
- `approve: false` → 取消並結束工作流程

Use `approve --preview-from-stdin --limit N` to attach a JSON preview to approval requests without custom jq/heredoc glue. Resume tokens are now compact: Lobster stores workflow resume state under its state dir and hands back a small token key.

## OpenProse

OpenProse 與 Lobster 搭配良好：使用 `/prose` 來編排多代理程式的前置作業，接著執行 Lobster 管線以進行可預測的核准。若某個 Prose 程式需要 Lobster，請透過 `tools.subagents.tools` 為子代理程式允許 `lobster` 工具。請參見 [OpenProse](/prose)。 43. 若 Prose 程式需要 Lobster，請透過 `tools.subagents.tools` 為子代理允許 `lobster` 工具。 44. 請參閱 [OpenProse](/prose)。

## 安全性

- **Local subprocess only** — no network calls from the plugin itself.
- **不處理祕密** — Lobster 不管理 OAuth；它會呼叫負責此事的 OpenClaw 工具。
- **Sandbox-aware** — disabled when the tool context is sandboxed.
- **Hardened** — `lobsterPath` must be absolute if specified; timeouts and output caps enforced.

## Troubleshooting

- **`lobster subprocess timed out`** → 提高 `timeoutMs`，或拆分較長的管線。
- **`lobster output exceeded maxStdoutBytes`** → 提高 `maxStdoutBytes` 或減少輸出大小。
- **`lobster returned invalid JSON`** → 確保管線在工具模式下執行，且僅輸出 JSON。
- **`lobster failed (code …)`** → 在終端機中執行相同的管線以檢視 stderr。

## 了解更多

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/agent-tools)

## 案例研究：社群工作流程

One public example: a “second brain” CLI + Lobster pipelines that manage three Markdown vaults (personal, partner, shared). 一個公開的範例：「第二大腦」CLI + Lobster 管線，用來管理三個 Markdown 知識庫（個人、夥伴、共享）。該 CLI 會輸出用於統計、收件匣清單與過期掃描的 JSON；Lobster 將這些指令串接成如 `weekly-review`、`inbox-triage`、`memory-consolidation` 與 `shared-task-sync` 等工作流程，且每個流程都具備核准關卡。AI 在可用時負責判斷（分類），在不可用時則回退至可預測的規則。 AI handles judgment (categorization) when available and falls back to deterministic rules when not.

- 討論串：[https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo：[https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
