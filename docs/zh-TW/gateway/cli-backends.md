---
summary: "CLI 後端：透過本機 AI CLI 的純文字備援"
read_when:
  - 當 API 提供者失效時，你需要可靠的備援
  - 你正在執行 Claude Code CLI 或其他本機 AI CLI，並想要重複使用它們
  - 你需要一條僅文字、無工具，但仍支援工作階段與圖片的路徑
title: "CLI 後端"
---

# CLI 後端（備援執行階段）

OpenClaw 可以在 API 提供者當機、被限流，或暫時行為異常時，執行 **本機 AI CLI** 作為 **純文字備援**。此設計刻意保守： This is intentionally conservative:

- **停用工具**（不進行工具呼叫）。
- **文字輸入 → 文字輸出**（可靠）。
- **支援工作階段**（後續回合可保持連貫）。
- **可傳遞圖片**（若 CLI 接受圖片路徑）。

This is designed as a **safety net** rather than a primary path. Use it when you
want “always works” text responses without relying on external APIs.

## 新手友善的快速開始

你可以 **不需任何設定** 就使用 Claude Code CLI（OpenClaw 內建預設）：

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI 也可開箱即用：

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

如果你的 Gateway 閘道器是在 launchd/systemd 下執行，且 PATH 最小化，只需加入
指令路徑：

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

That’s it. 就這樣。不需要金鑰，也不需要除了 CLI 本身之外的額外身分驗證設定。

## Using it as a fallback

將 CLI 後端加入你的備援清單，讓它只在主要模型失敗時才執行：

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

- 如果你使用 `agents.defaults.models`（允許清單），必須包含 `claude-cli/...`。
- If the primary provider fails (auth, rate limits, timeouts), OpenClaw will
  try the CLI backend next.

## 設定概覽

所有 CLI 後端都位於：

```
agents.defaults.cliBackends
```

Each entry is keyed by a **provider id** (e.g. `claude-cli`, `my-cli`).
The provider id becomes the left side of your model ref:

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

## How it works

1. **選擇後端**：依提供者前綴（`claude-cli/...`）。
2. **建立系統提示**：使用相同的 OpenClaw 提示與工作區內容。
3. **執行 CLI**：若支援，會帶入工作階段 id 以保持歷史一致。
4. **解析輸出**：解析 JSON 或純文字，並回傳最終文字。
5. **Persists session ids** per backend, so follow-ups reuse the same CLI session.

## Sessions

- 若 CLI 支援工作階段，請設定 `sessionArg`（例如 `--session-id`）或
  `sessionArgs`（當需要將 ID 插入多個旗標時，使用佔位符 `{sessionId}`）。
- 若 CLI 使用 **resume 子命令** 且旗標不同，請設定
  `resumeArgs`（在復原時取代 `args`），並可選擇設定 `resumeOutput`
  （用於非 JSON 的復原）。
- `sessionMode`：
  - `always`：一律送出工作階段 id（若未儲存則建立新的 UUID）。
  - `existing`: only send a session id if one was stored before.
  - `none`：永不送出工作階段 id。

## 圖片（直通）

若你的 CLI 接受圖片路徑，請設定 `imageArg`：

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw will write base64 images to temp files. If `imageArg` is set, those
paths are passed as CLI args. If `imageArg` is missing, OpenClaw appends the
file paths to the prompt (path injection), which is enough for CLIs that auto-
load local files from plain paths (Claude Code CLI behavior).

## Inputs / outputs

- `output: "json"`（預設）嘗試解析 JSON，並擷取文字與工作階段 id。
- `output: "jsonl"` 解析 JSONL 串流（Codex CLI `--json`），並擷取
  最後一則代理程式訊息，以及在存在時的 `thread_id`。
- `output: "text"` 將 stdout 視為最終回應。

輸入模式：

- `input: "arg"`（預設）將提示作為最後一個 CLI 參數傳遞。
- `input: "stdin"` 透過 stdin 傳送提示。
- 若提示非常長且設定了 `maxPromptArgChars`，則使用 stdin。

## Defaults (built-in)

OpenClaw 內建 `claude-cli` 的預設：

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw 也內建 `codex-cli` 的預設：

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

Override only if needed (common: absolute `command` path).

## 限制

- **沒有 OpenClaw 工具**（CLI 後端永遠不會接收工具呼叫）。部分 CLI
  仍可能執行其自身的代理程式工具。 Some CLIs
  may still run their own agent tooling.
- **不支援串流**（CLI 輸出會先收集再回傳）。
- **結構化輸出** 取決於 CLI 的 JSON 格式。
- **Codex CLI 工作階段** 透過文字輸出復原（非 JSONL），其結構化程度
  低於初次的 `--json` 執行。OpenClaw 的工作階段仍可正常運作。 OpenClaw sessions still work
  normally.

## Troubleshooting

- **找不到 CLI**：將 `command` 設為完整路徑。
- **模型名稱錯誤**：使用 `modelAliases` 將 `provider/model` 對應到 CLI 模型。
- **沒有工作階段連續性**：確認已設定 `sessionArg`，且 `sessionMode` 不是
  `none`（Codex CLI 目前無法以 JSON 輸出復原）。
- **圖片被忽略**：設定 `imageArg`（並確認 CLI 支援檔案路徑）。
