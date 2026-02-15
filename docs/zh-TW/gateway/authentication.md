---
summary: "模型認證：OAuth、API 密鑰和 setup-token"
read_when:
  - 偵錯模型認證或 OAuth 過期
  - 記錄認證或憑證儲存
title: "認證"
---

# 認證

OpenClaw 支援模型供應商的 OAuth 和 API 密鑰。對於 Anthropic 帳戶，我們推薦使用 **API 密鑰**。對於 Claude 訂閱存取，請使用 `claude setup-token` 建立的長期有效權杖。

請參閱 [/concepts/oauth](/concepts/oauth) 了解完整的 OAuth 流程和儲存佈局。

## 建議的 Anthropic 設定 (API 密鑰)

如果您直接使用 Anthropic，請使用 API 密鑰。

1. 在 Anthropic 控制台建立 API 密鑰。
2. 將其放置在 **Gateway主機**（運行 `openclaw gateway` 的機器）上。

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. 如果 Gateway在 systemd/launchd 下運行，最好將密鑰放在 `~/.openclaw/.env` 中以便守護程式可以讀取它：

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

然後重新啟動守護程式（或重新啟動您的 Gateway程序）並重新檢查：

```bash
openclaw models status
openclaw doctor
```

如果您不希望自行管理環境變數，新手導覽精靈可以儲存 API 密鑰供守護程式使用：`openclaw onboard`。

請參閱 [Help](/help) 了解環境變數繼承的詳情 (`env.shellEnv`、`~/.openclaw/.env`、systemd/launchd)。

## Anthropic：setup-token (訂閱認證)

對於 Anthropic，建議的方式是 **API 密鑰**。如果您使用 Claude 訂閱，setup-token 流程也支援。在 **Gateway主機**上運行它：

```bash
claude setup-token
```

然後將其貼上到 OpenClaw：

```bash
openclaw models auth setup-token --provider anthropic
```

如果權杖是在另一台機器上建立的，手動貼上它：

```bash
openclaw models auth paste-token --provider anthropic
```

如果您看到類似以下的 Anthropic 錯誤：

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…請改用 Anthropic API 密鑰。

手動權杖輸入（任何供應商；寫入 `auth-profiles.json` + 更新設定）：

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

自動化友善檢查（過期/遺失時退出 `1`，即將過期時退出 `2`）：

```bash
openclaw models status --check
```

可選的運營腳本 (systemd/Termux) 在此處記錄：[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` 需要互動式 TTY。

## 檢查模型認證狀態

```bash
openclaw models status
openclaw doctor
```

## 控制使用哪個憑證

### 每個工作階段 (聊天指令)

使用 `/model <alias-or-id> @<profileId>` 以釘選特定供應商憑證用於當前工作階段（範例設定檔 ID：`anthropic:default`、`anthropic:work`）。

使用 `/model`（或 `/model list`）用於緊湊的選擇器；使用 `/model status` 用於完整視圖（候選 + 下一個認證設定檔，以及配置時的供應商端點詳情）。

### 每個智慧代理 (CLI 覆寫)

設定智慧代理的顯式認證設定檔順序覆寫（儲存在該智慧代理的 `auth-profiles.json` 中）：

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

使用 `--agent <id>` 以指定特定的智慧代理；省略它則使用已設定的預設智慧代理。

## 疑難排解

### 「找不到憑證」

如果 Anthropic 權杖設定檔遺失，請在 **Gateway主機**上運行 `claude setup-token`，然後重新檢查：

```bash
openclaw models status
```

### 權杖即將過期/已過期

運行 `openclaw models status` 以確認哪個設定檔即將過期。如果設定檔遺失，重新運行 `claude setup-token` 並再次貼上權杖。

## 要求

- Claude Max 或 Pro 訂閱（用於 `claude setup-token`）
- Claude Code CLI 已安裝（`claude` 指令可用）
