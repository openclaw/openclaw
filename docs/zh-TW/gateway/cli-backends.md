---
summary: "CLI 後端：透過本地 AI CLI 進行純文字備援"
read_when:
  - API 供應商故障時，您需要可靠的備援方案
  - 您正在執行 Claude Code CLI 或其他本地 AI CLI 並希望重複使用時
  - 您需要純文字、無工具路徑，且仍支援工作階段與圖片時
title: "CLI 後端"
---

# CLI 後端（備援執行環境）

當 API 供應商故障、觸發頻率限制或暫時異常時，OpenClaw 可以執行**本地 AI CLI** 作為**純文字備援**。這是刻意保守的設計：

- **工具已停用**（無工具呼叫）。
- **純文字輸入 → 純文字輸出**（可靠）。
- **支援工作階段**（使後續輪次保持連貫）。
- **圖片可以傳遞**（若 CLI 接受圖片路徑）。

這是作為**安全網**而非主要路徑設計的。當您希望在不依賴外部 API 的情況下獲得「保證運作」的文字回應時，請使用此功能。

## 初學者友善的快速開始

您可以在**不進行任何設定**的情況下使用 Claude Code CLI（OpenClaw 內建了預設值）：

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI 也能開箱即用：

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

如果您的 Gateway 在 launchd/systemd 下執行且 PATH 路徑極簡，請僅添加指令路徑：

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

就這樣。除了 CLI 本身之外，不需要金鑰或額外的驗證設定。

## 將其作為備援使用

將 CLI 後端新增至您的備援清單，以便僅在主要模型失敗時執行：

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

注意事項：

- 如果您使用 `agents.defaults.models`（白名單），必須包含 `claude-cli/...`。
- 如果主要供應商失敗（驗證、頻率限制、逾時），OpenClaw 接下來會嘗試 CLI 後端。

## 設定概覽

所有 CLI 後端都位於：

```
agents.defaults.cliBackends
```

每個項目都以 **provider id** 為鍵（例如 `claude-cli`、`my-cli`）。該 provider id 會成為模型參考的左側：

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

## 運作原理

1. **選擇後端**：根據供應商前綴（`claude-cli/...`）選擇。
2. **構建系統提示詞**：使用相同的 OpenClaw 提示詞 + 工作區上下文。
3. **執行 CLI**：使用 session id（若支援）使歷史記錄保持一致。
4. **解析輸出**：解析（JSON 或純文字）並回傳最終文字。
5. **持久化 session id**：為每個後端儲存 session id，以便後續輪次重複使用相同的 CLI 工作階段。

## 工作階段

- 如果 CLI 支援工作階段，請在 ID 需要插入多個旗標時設定 `sessionArg`（例如 `--session-id`）或 `sessionArgs`（佔位符 `{sessionId}`）。
- 如果 CLI 使用具有不同旗標的 **resume 子指令**，請設定 `resumeArgs`（恢復時取代 `args`）以及選擇性設定 `resumeOutput`（用於非 JSON 恢復）。
- `sessionMode`:
  - `always`: 始終發送 session id（若無儲存則發送新的 UUID）。
  - `existing`: 僅在之前儲存過 session id 時發送。
  - `none`: 永不發送 session id。

## 圖片（傳遞）

如果您的 CLI 接受圖片路徑，請設定 `imageArg`：

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw 會將 base64 圖片寫入暫存檔案。如果設定了 `imageArg`，這些路徑將作為 CLI 參數傳遞。如果缺少 `imageArg`，OpenClaw 會將檔案路徑附加到提示詞中（路徑注入），這對於會自動從純路徑載入本地檔案的 CLI（如 Claude Code CLI 的行為）來說已經足夠。

## 輸入 / 輸出

- `output: "json"`（預設）嘗試解析 JSON 並提取文字 + session id。
- `output: "jsonl"` 解析 JSONL 串流（Codex CLI `--json`）並在存在時提取最後一則智慧代理訊息以及 `thread_id`。
- `output: "text"` 將標準輸出（stdout）視為最終回應。

輸入模式：

- `input: "arg"`（預設）將提示詞作為最後一個 CLI 參數傳遞。
- `input: "stdin"` 透過標準輸入（stdin）發送提示詞。
- 如果提示詞非常長且設定了 `maxPromptArgChars`，則會使用 stdin。

## 預設值（內建）

OpenClaw 為 `claude-cli` 提供預設值：

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw 也為 `codex-cli` 提供預設值：

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

僅在需要時進行覆寫（常見情況：絕對 `command` 路徑）。

## 限制

- **無 OpenClaw 工具**（CLI 後端永遠不會收到工具呼叫）。某些 CLI 可能仍會執行自己的智慧代理工具。
- **無串流傳輸**（收集 CLI 輸出後再回傳）。
- **結構化輸出**取決於 CLI 的 JSON 格式。
- **Codex CLI 工作階段**透過文字輸出恢復（無 JSONL），這比初始的 `--json` 執行更缺乏結構。OpenClaw 工作階段仍可正常運作。

## 疑難排解

- **找不到 CLI**：將 `command` 設定為完整路徑。
- **模型名稱錯誤**：使用 `modelAliases` 來對應 `provider/model` → CLI 模型。
- **無工作階段連續性**：確保已設定 `sessionArg` 且 `sessionMode` 不是 `none`（Codex CLI 目前無法使用 JSON 輸出進行恢復）。
- **圖片被忽略**：設定 `imageArg`（並確認 CLI 支援檔案路徑）。
