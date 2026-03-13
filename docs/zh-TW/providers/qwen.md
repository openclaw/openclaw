---
summary: Use Qwen OAuth (free tier) in OpenClaw
read_when:
  - You want to use Qwen with OpenClaw
  - You want free-tier OAuth access to Qwen Coder
title: Qwen
---

# Qwen

Qwen 提供 Qwen Coder 和 Qwen Vision 模型的免費階層 OAuth 流程  
（每日 2,000 次請求，受 Qwen 速率限制約束）。

## 啟用外掛

```bash
openclaw plugins enable qwen-portal-auth
```

啟用後請重新啟動 Gateway。

## 認證

```bash
openclaw models auth login --provider qwen-portal --set-default
```

此操作會執行 Qwen 裝置程式碼 OAuth 流程，並將提供者條目寫入您的  
`models.json`（並新增一個 `qwen` 別名以便快速切換）。

## 模型 ID

- `qwen-portal/coder-model`
- `qwen-portal/vision-model`

切換模型指令：

```bash
openclaw models set qwen-portal/coder-model
```

## 重複使用 Qwen Code CLI 登入

如果您已使用 Qwen Code CLI 登入，OpenClaw 在載入認證存儲時會從 `~/.qwen/oauth_creds.json` 同步憑證。  
您仍然需要一個 `models.providers.qwen-portal` 條目（請使用上述登入指令建立）。

## 注意事項

- Token 自動刷新；如果刷新失敗或存取權被撤銷，請重新執行登入指令。
- 預設基底 URL：`https://portal.qwen.ai/v1`（如果 Qwen 提供不同的端點，可用 `models.providers.qwen-portal.baseUrl` 覆寫）。
- 詳見 [模型提供者](/concepts/model-providers) 以了解提供者整體規則。
