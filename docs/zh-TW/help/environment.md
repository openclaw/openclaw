---
summary: "OpenClaw 載入環境變數的位置與優先順序"
read_when:
  - 你需要知道哪些環境變數被載入，以及其載入順序
  - 你正在疑難排解 Gateway 閘道器 中遺失的 API 金鑰
  - 你正在撰寫提供者身分驗證或部署環境的文件
title: "環境變數"
---

# 環境變數

OpenClaw pulls environment variables from multiple sources. The rule is **never override existing values**.

## 優先順序（最高 → 最低）

1. **程序環境**（Gateway 閘道器 程序已從父層 shell／daemon 取得的值）。
2. **目前工作目錄中的 `.env`**（dotenv 預設；不會覆寫）。
3. **位於 `~/.openclaw/.env` 的全域 `.env`**（亦稱為 `$OPENCLAW_STATE_DIR/.env`；不會覆寫）。
4. **`~/.openclaw/openclaw.json` 中的設定 `env` 區塊**（僅在缺少時套用）。
5. **選用的登入 shell 匯入**（`env.shellEnv.enabled` 或 `OPENCLAW_LOAD_SHELL_ENV=1`），僅針對缺少的預期金鑰套用。

如果設定檔完全缺失，則會跳過步驟 4；若啟用，Shell 匯入仍會執行。

## 設定檔 `env` 區塊

Two equivalent ways to set inline env vars (both are non-overriding):

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

## Shell env import

`env.shellEnv` 會執行你的登入 shell，並僅匯入 **缺少** 的預期金鑰：

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

環境變數對應：

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Env var substitution in config

你可以在設定的字串值中，使用 `${VAR_NAME}` 語法直接參考環境變數：

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

完整細節請參閱［Configuration: Env var substitution］(/gateway/configuration#env-var-substitution-in-config)。

## 12. 相關

- [Gateway configuration](/gateway/configuration)
- [FAQ: env vars and .env loading](/help/faq#env-vars-and-env-loading)
- [Models overview](/concepts/models)
