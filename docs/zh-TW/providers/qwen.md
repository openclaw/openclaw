---
summary: "在 OpenClaw 中使用 Qwen OAuth (免費方案)"
read_when:
  - 您希望在 OpenClaw 中使用 Qwen
  - 您希望取得 Qwen Coder 的免費方案 OAuth 存取權
title: "Qwen"
---

# Qwen

Qwen 提供適用於 Qwen Coder 和 Qwen Vision 模型 的免費方案 OAuth 流程（每天 2,000 次請求，受 Qwen 速率限制）。

## 啟用外掛程式

```bash
openclaw plugins enable qwen-portal-auth
```

啟用後請重新啟動 Gateway。

## 驗證

```bash
openclaw models auth login --provider qwen-portal --set-default
```

這會執行 Qwen 裝置代碼 OAuth 流程，並將一個供應商項目寫入您的 `models.json` 檔案（以及一個 `qwen` 別名，以便快速切換）。

## 模型 ID

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

切換模型：

```bash
openclaw models set qwen-portal/coder-model
```

## 重複使用 Qwen Code CLI 登入

如果您已經使用 Qwen Code CLI 登入，OpenClaw 將在載入憑證儲存時，從 `~/.qwen/oauth_creds.json` 同步憑證。您仍然需要一個 `models.providers.qwen-portal` 項目（請使用上方的登入指令建立一個）。

## 注意事項

- 權杖自動重新整理；如果重新整理失敗或存取被撤銷，請重新執行登入指令。
- 預設基礎 URL：`https://portal.qwen.ai/v1`（如果 Qwen 提供不同的端點，請使用 `models.providers.qwen-portal.baseUrl` 覆寫）。
- 請參閱 [模型供應商](/concepts/model-providers) 以了解供應商通用規則。
