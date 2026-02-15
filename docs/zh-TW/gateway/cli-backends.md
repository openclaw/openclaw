---
summary: "CLI 後端：透過本地 AI CLI 的純文字備援"
read_when:
  - 當 API 供應商故障時，您需要可靠的備援
  - 您正在執行 Claude Code CLI 或其他本地 AI CLI 並希望重複使用它們
  - 您需要一個純文字、無工具的路徑，但仍支援工作階段和圖像
title: "CLI 後端"
---

# CLI 後端 (備援運行環境)

OpenClaw 可以將**本地 AI CLI** 作為**純文字備援**來執行，當 API 供應商停機、受速率限制或暫時異常時。這是刻意保守的設計：

- **工具已停用**（無工具呼叫）。
- **文字輸入 → 文字輸出**（可靠）。
- **支援工作階段**（因此後續的對話保持連貫）。
- **如果 CLI 接受圖像路徑，則圖像可以傳遞**。

這被設計為一個**安全網**，而非主要路徑。當您想要「始終有效」的文字回應，而不依賴外部 API 時，請使用它。

## 新手友善快速開始

您可以**無需任何設定**即可使用 Claude Code CLI (OpenClaw 內建預設值)：

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI 也開箱即用：

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

如果您的 Gateway運行於 launchd/systemd 之下且 PATH 精簡，只需新增指令路徑：

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

就是這樣。除了 CLI 本身之外，無需金鑰，無需額外的驗證設定。

## 將其作為備援使用

將 CLI 後端新增至您的備援清單，以便它僅在主要模型故障時執行：

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
        "claude-cli/opus-4-6": {},
        "claude-cli/opus-4-5": {},
      },
    },
  },
}
```

注意事項：

- 如果使用 `agents.defaults.models`（允許清單），則必須包含 `claude-cli/...`。
- 如果主要供應商故障（驗證、速率限制、逾時），OpenClaw 將接著嘗試 CLI 後端。

## 設定概覽

所有 CLI 後端都位於：

```
agents.defaults.cliBackends
```

每個條目都以**供應商 ID**（例如 `claude-cli`、`my-cli`）作為鍵。供應商 ID 成為您模型參考的左側部分：

```
<provider>/<model>
```

### 設定範例

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

## 運作方式

1.  **根據供應商前綴** (`claude-cli/...`) 選擇後端。
2.  **使用相同的 OpenClaw 提示 + 工作區上下文**建立系統提示。
3.  **執行 CLI** 並帶有工作階段 ID (如果支援)，以便歷史紀錄保持一致。
4.  **解析輸出** (JSON 或純文字) 並返回最終文字。
5.  **每個後端持久化工作階段 ID**，因此後續請求重複使用相同的 CLI 工作階段。

## 工作階段

- 如果 CLI 支援工作階段，當 ID 需要插入到多個旗標中時，請設定 `sessionArg`（例如 `--session-id`）或 `sessionArgs`（佔位符 `{sessionId}`）。
- 如果 CLI 使用帶有不同旗標的**恢復子指令**，請設定 `resumeArgs`（恢復時替換 `args`）以及可選的 `resumeOutput`（用於非 JSON 恢復）。
- `sessionMode`：
    - `always`：始終傳送工作階段 ID (如果沒有儲存則使用新的 UUID)。
    - `existing`：僅在之前已儲存工作階段 ID 時才傳送。
    - `none`：從不傳送工作階段 ID。

## 圖像 (傳遞)

如果您的 CLI 接受圖像路徑，請設定 `imageArg`：

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw 會將 base64 圖像寫入暫存檔案。如果設定了 `imageArg`，這些路徑將作為 CLI 參數傳遞。如果缺少 `imageArg`，OpenClaw 會將檔案路徑附加到提示中（路徑注入），這對於從純路徑自動載入本地檔案的 CLI 來說已經足夠 (Claude Code CLI 行為)。

## 輸入 / 輸出

- `output: "json"`（預設）嘗試解析 JSON 並提取文字 + 工作階段 ID。
- `output: "jsonl"` 解析 JSONL 串流 (Codex CLI `--json`) 並提取最後一條智慧代理訊息以及當存在時的 `thread_id`。
- `output: "text"` 將 stdout 視為最終回應。

輸入模式：

- `input: "arg"`（預設）將提示作為最後一個 CLI 參數傳遞。
- `input: "stdin"` 透過 stdin 傳送提示。
- 如果提示非常長且 `maxPromptArgChars` 已設定，則使用 stdin。

## 預設值 (內建)

OpenClaw 為 `claude-cli` 內建預設值：

```
- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`
```

OpenClaw 也為 `codex-cli` 內建預設值：

```
- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`
```

僅在需要時覆寫（常見情況：絕對 `command` 路徑）。

## 限制

- **無 OpenClaw 工具**（CLI 後端從未接收工具呼叫）。某些 CLI 可能仍會運行自己的智慧代理工具。
- **無串流**（CLI 輸出被收集然後返回）。
- **結構化輸出**取決於 CLI 的 JSON 格式。
- **Codex CLI 工作階段**透過文字輸出恢復（無 JSONL），這比初始的 `--json` 執行較不結構化。OpenClaw 工作階段仍然正常運作。

## 疑難排解

- **找不到 CLI**：將 `command` 設定為完整路徑。
- **錯誤的模型名稱**：使用 `modelAliases` 將 `provider/model` 映射到 CLI 模型。
- **無工作階段連續性**：確保 `sessionArg` 已設定且 `sessionMode` 不是 `none`（Codex CLI 目前無法使用 JSON 輸出恢復）。
- **圖像被忽略**：設定 `imageArg` (並驗證 CLI 支援檔案路徑)。
