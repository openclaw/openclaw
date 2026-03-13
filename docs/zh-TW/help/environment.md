---
summary: Where OpenClaw loads environment variables and the precedence order
read_when:
  - "You need to know which env vars are loaded, and in what order"
  - You are debugging missing API keys in the Gateway
  - You are documenting provider auth or deployment environments
title: Environment Variables
---

# 環境變數

OpenClaw 從多個來源提取環境變數。規則是 **絕不覆蓋現有值**。

## 優先順序（最高 → 最低）

1. **處理環境**（Gateway 處理程序已從父殼層/守護進程獲得的內容）。
2. **`.env` 在當前工作目錄中**（dotenv 預設；不會覆蓋）。
3. **全域 `.env`** 在 `~/.openclaw/.env`（又名 `$OPENCLAW_STATE_DIR/.env`；不會覆蓋）。
4. **設定 `env` 區塊** 在 `~/.openclaw/openclaw.json`（僅在缺失時應用）。
5. **可選的登入殼層匯入**（`env.shellEnv.enabled` 或 `OPENCLAW_LOAD_SHELL_ENV=1`），僅在缺失預期鍵時應用。

如果設定檔案完全缺失，步驟 4 將被跳過；如果啟用，shell 匯入仍然會執行。

## Config `env` block

有兩種等效的方式來設置內聯環境變數（兩者均為非覆蓋模式）：

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## Shell 環境匯入

`env.shellEnv` 執行您的登入外殼並僅匯入 **缺失** 的預期金鑰：

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Env var equivalents:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Runtime-injected env vars

OpenClaw 也會將上下文標記注入到產生的子進程中：

- `OPENCLAW_SHELL=exec`: 設定用於通過 `exec` 工具執行的命令。
- `OPENCLAW_SHELL=acp`: 設定用於 ACP 執行時後端進程的產生（例如 `acpx`）。
- `OPENCLAW_SHELL=acp-client`: 設定用於 `openclaw acp client` 當它產生 ACP 橋接進程時。
- `OPENCLAW_SHELL=tui-local`: 設定用於本地 TUI `!` 命令。

這些是執行時標記（不需要用戶設定）。它們可以用於 shell/profile 邏輯中，以應用特定於上下文的規則。

## UI 環境變數

- `OPENCLAW_THEME=light`: 當你的終端機有淺色背景時，強制使用淺色 TUI 調色板。
- `OPENCLAW_THEME=dark`: 強制使用深色 TUI 調色板。
- `COLORFGBG`: 如果你的終端機有輸出，OpenClaw 會使用背景顏色提示自動選擇 TUI 調色板。

## 環境變數替換於設定中

您可以使用 `${VAR_NAME}` 語法直接在設定字串值中引用環境變數：

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

請參閱 [Configuration: Env var substitution](/gateway/configuration#env-var-substitution-in-config) 以獲取完整詳細資訊。

## Secret refs 與 `${ENV}` 字串

OpenClaw 支援兩種環境驅動的模式：

- `${VAR}` 字串替換於設定值中。
- SecretRef 物件 (`{ source: "env", provider: "default", id: "VAR" }`) 用於支援秘密參考的欄位。

兩者在啟動時都從過程環境中解析。SecretRef 的詳細資訊記錄在 [Secrets Management](/gateway/secrets) 中。

## 路徑相關的環境變數

| 變數                   | 目的                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_HOME`        | 覆蓋所有內部路徑解析所使用的主目錄 (`~/.openclaw/`、代理目錄、會話、憑證)。當以專用服務使用者身份執行 OpenClaw 時非常有用。 |
| `OPENCLAW_STATE_DIR`   | 覆蓋狀態目錄（預設為 `~/.openclaw`）。                                                                                      |
| `OPENCLAW_CONFIG_PATH` | 覆蓋設定檔案路徑（預設為 `~/.openclaw/openclaw.json`）。                                                                    |

## Logging

| 變數                 | 目的                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_LOG_LEVEL` | 覆蓋檔案和控制台的日誌級別（例如 `debug`、`trace`）。在設定中優先於 `logging.level` 和 `logging.consoleLevel`。無效的值會被忽略並顯示警告。 |

### `OPENCLAW_HOME`

當設定時，`OPENCLAW_HOME` 會替換系統主目錄 (`$HOME` / `os.homedir()`) 以進行所有內部路徑解析。這使得無頭服務帳戶能夠實現完整的檔案系統隔離。

**優先順序：** `OPENCLAW_HOME` > `$HOME` > `USERPROFILE` > `os.homedir()`

**範例** (macOS LaunchDaemon):

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>OPENCLAW_HOME</key>
  <string>/Users/kira</string>
</dict>
```

`OPENCLAW_HOME` 也可以設置為波浪號路徑（例如 `~/svc`），在使用之前會通過 `$HOME` 進行擴充。

## Related

- [閘道設定](/gateway/configuration)
- [常見問題：環境變數和 .env 加載](/help/faq#env-vars-and-env-loading)
- [模型概述](/concepts/models)
