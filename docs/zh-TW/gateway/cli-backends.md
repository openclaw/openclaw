---
summary: "CLI backends: text-only fallback via local AI CLIs"
read_when:
  - You want a reliable fallback when API providers fail
  - >-
    You are running Claude Code CLI or other local AI CLIs and want to reuse
    them
  - "You need a text-only, tool-free path that still supports sessions and images"
title: CLI Backends
---

# CLI 後端（備用執行環境）

OpenClaw 可以在 API 提供者無法使用、速率限制或暫時出現問題時，作為 **文字-only 備援** 執行 **本地 AI CLI**。這是故意採取保守的做法：

- **工具已禁用**（無法調用工具）。
- **文本輸入 → 文本輸出**（可靠）。
- **支援會話**（因此後續回合保持一致性）。
- **如果 CLI 接受圖像路徑，可以傳遞圖像**。

這是設計為一個 **安全網**，而不是主要路徑。當你想要「總是有效」的文本回應而不依賴外部 API 時，請使用它。

## 初學者友好的快速入門

您可以使用 Claude Code CLI **無需任何設定**（OpenClaw 附帶內建的預設設定）：

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI 也可以即時使用：

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.4
```

如果您的網關在 launchd/systemd 下執行且 PATH 環境變數最小，請僅添加命令路徑：

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

就這樣。除了 CLI 本身，不需要任何金鑰或額外的身份驗證設定。

## 使用它作為備用方案

將 CLI 後端添加到你的備援列表中，這樣它僅在主要模型失敗時執行：

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

[[BLOCK_1]]

- 如果您使用 `agents.defaults.models` (允許清單)，您必須包含 `claude-cli/...`。
- 如果主要提供者失敗（身份驗證、速率限制、超時），OpenClaw 將會接著嘗試 CLI 後端。

## 設定概述

所有 CLI 後端都位於：

```
agents.defaults.cliBackends
```

每個條目都以 **提供者 ID** 為鍵（例如 `claude-cli`、`my-cli`）。提供者 ID 成為您模型參考的左側：

```
<provider>/<model>
```

### 範例設定

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## 它是如何運作的

1. **根據提供者前綴** (`claude-cli/...`) **選擇後端**。
2. **使用相同的 OpenClaw 提示 + 工作區上下文** **構建系統提示**。
3. **執行 CLI**，並使用會話 ID（如果支援），以便歷史記錄保持一致。
4. **解析輸出**（JSON 或純文字）並返回最終文本。
5. **根據後端持久化會話 ID**，以便後續操作重用相同的 CLI 會話。

## Sessions

- 如果 CLI 支援會話，當需要將 ID 插入多個標誌時，請設置 `sessionArg`（例如 `--session-id`）或 `sessionArgs`（佔位符 `{sessionId}`）。
- 如果 CLI 使用 **resume 子命令** 並帶有不同的標誌，請設置 `resumeArgs`（在恢復時替換 `args`）並可選擇性地設置 `resumeOutput`（用於非 JSON 的恢復）。
- `sessionMode`:
  - `always`: 始終發送會話 ID（如果沒有存儲則使用新的 UUID）。
  - `existing`: 只有在之前存儲過會話 ID 時才發送。
  - `none`: 永遠不發送會話 ID。

## Images (pass-through)

如果您的 CLI 接受影像路徑，請設定 `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw 將會將 base64 圖片寫入臨時檔案。如果 `imageArg` 被設定，這些路徑將作為 CLI 參數傳遞。如果 `imageArg` 缺失，OpenClaw 會將檔案路徑附加到提示中（路徑注入），這對於自動從純路徑加載本地檔案的 CLI（Claude Code CLI 行為）來說已經足夠。

## Inputs / outputs

- `output: "json"` (預設) 嘗試解析 JSON 並提取文本 + 會話 ID。
- `output: "jsonl"` 解析 JSONL 流 (Codex CLI `--json`) 並提取最後的代理訊息以及 `thread_id`（如果存在的話）。
- `output: "text"` 將 stdout 視為最終回應。

Input modes:

- `input: "arg"` (預設) 將提示作為最後一個 CLI 參數傳遞。
- `input: "stdin"` 通過 stdin 發送提示。
- 如果提示非常長且 `maxPromptArgChars` 被設置，則使用 stdin。

## 預設值（內建）

OpenClaw 提供了 `claude-cli` 的預設值：

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw 也提供了 `codex-cli` 的預設值：

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

僅在必要時覆蓋（常見：絕對 `command` 路徑）。

## 限制事項

- **無 OpenClaw 工具**（CLI 後端從未接收到工具調用）。某些 CLI 可能仍會執行自己的代理工具。
- **無串流**（CLI 輸出會被收集後再返回）。
- **結構化輸出** 依賴於 CLI 的 JSON 格式。
- **Codex CLI 會話** 透過文字輸出恢復（無 JSONL），這比最初的 `--json` 執行更不結構化。OpenClaw 會話仍然正常運作。

## 故障排除

- **找不到 CLI**：將 `command` 設定為完整路徑。
- **錯誤的模型名稱**：使用 `modelAliases` 將 `provider/model` 映射到 CLI 模型。
- **無法保持會話連續性**：確保 `sessionArg` 已設定且 `sessionMode` 不是 `none`（Codex CLI 目前無法使用 JSON 輸出恢復）。
- **圖片被忽略**：設定 `imageArg`（並確認 CLI 支援檔案路徑）。
