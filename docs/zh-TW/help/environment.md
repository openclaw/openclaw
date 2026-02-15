---
summary: "OpenClaw 載入環境變數的位置及優先順序"
read_when:
  - 您需要了解哪些環境變數被載入，以及其載入順序時
  - 您正在偵錯 Gateway 中遺失的 API 金鑰時
  - 您正在撰寫供應商憑證或部署環境文件時
title: "環境變數"
---

# 環境變數

OpenClaw 從多個來源提取環境變數。規則是**永不覆寫現有值**。

## 優先順序 (高 → 低)

1.  **程序環境** (Gateway 程序從父級 shell/daemon 已經擁有的)。
2.  **目前工作目錄中的 `.env` 檔案** (dotenv 預設；不覆寫)。
3.  **全域 `.env` 檔案** 位於 `~/.openclaw/.env` (又稱 `$OPENCLAW_STATE_DIR/.env`；不覆寫)。
4.  **設定檔中的 `env` 區塊** 位於 `~/.openclaw/openclaw.json` (僅在遺失時套用)。
5.  **選用登入 shell 匯入** (`env.shellEnv.enabled` 或 `OPENCLAW_LOAD_SHELL_ENV=1`)，僅在遺失預期鍵名時套用。

如果設定檔完全遺失，則跳過步驟 4；如果啟用，shell 匯入仍會執行。

## 設定檔 `env` 區塊

設定內聯環境變數的兩種等效方法（兩者皆不覆寫）：

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

## Shell 環境變數匯入

`env.shellEnv` 執行您的登入 shell 並僅匯入**遺失**的預期鍵名：

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

環境變數等效項目：

-   `OPENCLAW_LOAD_SHELL_ENV=1`
-   `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## 設定中的環境變數替換

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

請參閱 [設定：環境變數替換](/gateway/configuration#env-var-substitution-in-config) 了解
