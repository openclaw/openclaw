---
summary: "OpenClaw 載入環境變數的位置以及優先順序"
read_when:
  - 您需要了解載入了哪些環境變數及其順序
  - 您正在偵錯 Gateway 中遺失的 API 金鑰
  - 您正在記錄供應商驗證或部署環境
title: "環境變數"
---

# 環境變數

OpenClaw 從多個來源提取環境變數。規則是**永不覆寫現有值**。

## 優先順序（由高至低）

1. **處理程序環境** (Gateway 處理程序已從父層 shell/精靈程式 (daemon) 繼承的環境變數)。
2. **目前工作目錄中的 `.env`** (dotenv 預設行為；不進行覆寫)。
3. **全域 `.env`**，位於 `~/.openclaw/.env` (又稱 `$OPENCLAW_STATE_DIR/.env`；不進行覆寫)。
4. **設定檔中的 `env` 區塊**，位於 `~/.openclaw/openclaw.json` (僅在缺少時套用)。
5. **選用的登入 shell 匯入** (`env.shellEnv.enabled` 或 `OPENCLAW_LOAD_SHELL_ENV=1`)，僅針對遺失的預期鍵名套用。

如果設定檔完全缺失，則跳過第 4 步；若已啟用，shell 匯入仍會執行。

## 設定檔 `env` 區塊

設定內聯 (inline) 環境變數的兩種等效方式（皆不進行覆寫）：

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

`env.shellEnv` 會執行您的登入 shell，並僅匯入**遺失**的預期鍵名：

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

等效環境變數：

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## 設定檔中的環境變數替換

您可以在設定檔的字串值中使用 `${VAR_NAME}` 語法直接引用環境變數：

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

了解詳情請參閱 [設定：環境變數替換](/gateway/configuration#env-var-substitution-in-config)。

## 路徑相關的環境變數

| 變數 |
