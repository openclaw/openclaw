---
summary: "在 OpenClaw 中使用 Qwen OAuth (免費層級)"
read_when:
  - 您想在 OpenClaw 中使用 Qwen
  - 您想透過免費層級的 OAuth 存取 Qwen Coder
title: "Qwen"
---

# Qwen

Qwen 為 Qwen Coder 和 Qwen Vision 模型提供免費層級的 OAuth 流程（每日 2,000 次請求，受 Qwen 速率限制約束）。

## 啟用外掛程式

```bash
openclaw plugins enable qwen-portal-auth
```

啟用後請重新啟動 Gateway。

## 進行驗證

```bash
openclaw models auth login --provider qwen-portal --set-default
```

這會執行 Qwen 裝置代碼 OAuth 流程，並將供應商項目寫入您的 `models.json`（並加上 `qwen` 別名以便快速切換）。

## 模型 ID

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

使用以下指令切換模型：

```bash
openclaw models set qwen-portal/coder-model
```

## 重複使用 Qwen Code CLI 登入資訊

如果您已經使用 Qwen Code CLI 登入，OpenClaw 在載入驗證儲存庫時會從 `~/.qwen/oauth_creds.json` 同步憑證。您仍然需要一個 `models.providers.qwen-portal` 項目（請使用上方的登入指令來建立）。

## 注意事項

- 權杖 (Token) 會自動重新整理；如果重新整理失敗或存取權限被撤銷，請重新執行登入指令。
- 預設基礎 URL：`https://portal.qwen.ai/v1`（如果 Qwen 提供不同的端點，請透過 `models.providers.qwen-portal.baseUrl` 進行覆蓋）。
- 請參閱 [模型供應商](/concepts/model-providers) 以了解適用於整個供應商的規則。
