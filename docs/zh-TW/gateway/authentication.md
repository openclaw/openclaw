---
summary: "模型驗證：OAuth、API key 以及 setup-token"
read_when:
  - 調試模型驗證或 OAuth 到期問題
  - 記錄驗證或憑證儲存方式
title: "驗證"
---

# 驗證

OpenClaw 支援模型供應商的 OAuth 和 API key。對於 Anthropic 帳戶，我們建議使用 **API key**。對於 Claude 訂閱存取，請使用由 `claude setup-token` 產生的長效 token。

請參閱 [/concepts/oauth](/concepts/oauth) 了解完整的 OAuth 流程和儲存配置。

## 建議的 Anthropic 設定 (API key)

如果您直接使用 Anthropic，請使用 API key。

1. 在 Anthropic 控制台建立 API key。
2. 將其放在 **Gateway 主機**（執行 `openclaw gateway` 的機器）上。

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. 如果 Gateway 在 systemd/launchd 下執行，建議將 key 放入 `~/.openclaw/.env` 中，以便背景程式 (daemon) 讀取：

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

然後重啟背景程式（或重啟您的 Gateway 程序）並重新檢查：

```bash
openclaw models status
openclaw doctor
```

如果您不想手動管理環境變數，新手導覽精靈可以儲存 API key 供背景程式使用：`openclaw onboard`。

請參閱 [說明](/help) 了解環境變數繼承的詳細資訊（`env.shellEnv`、`~/.openclaw/.env`、systemd/launchd）。

## Anthropic：setup-token（訂閱驗證）

對於 Anthropic，建議路徑是使用 **API key**。如果您使用的是 Claude 訂閱，也支援 setup-token 流程。在 **Gateway 主機**上執行：

```bash
claude setup-token
```

然後將其貼上到 OpenClaw：

```bash
openclaw models auth setup-token --provider anthropic
```

如果 token 是在其他機器上產生的，請手動貼上：

```bash
openclaw models auth paste-token --provider anthropic
```

如果您看到類似以下的 Anthropic 錯誤：

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…請改用 Anthropic API key。

手動輸入 token（適用於任何供應商；會寫入 `auth-profiles.json` 並更新設定）：

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

自動化友善檢查（過期/缺失時結束代碼為 `1`，即將過期時為 `2`）：

```bash
openclaw models status --check
```

選用的維運指令碼 (systemd/Termux) 記錄在此：[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` 需要互動式 TTY。

## 檢查模型驗證狀態

```bash
openclaw models status
openclaw doctor
```

## 控制使用的憑證

### 每個工作階段（對話指令）

使用 `/model <alias-or-id> @<profileId>` 為當前工作階段固定特定的供應商憑證（例如 profile id：`anthropic:default`、`anthropic:work`）。

使用 `/model`（或 `/model list`）開啟簡易選擇器；使用 `/model status` 查看完整視圖（候選項目 + 下一個驗證設定檔，以及已設定的供應商端點詳情）。

### 每個智慧代理（CLI 覆蓋）

為智慧代理設定明確的驗證設定檔順序覆蓋（儲存在該智慧代理的 `auth-profiles.json` 中）：

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

使用 `--agent <id>` 指定特定的智慧代理；省略則使用設定的預設智慧代理。

## 疑難排解

### 「找不到憑證」

如果缺少 Anthropic token 設定檔，請在 **Gateway 主機**上執行 `claude setup-token`，然後重新檢查：

```bash
openclaw models status
```

### Token 即將過期/已過期

執行 `openclaw models status` 確認哪個設定檔即將過期。如果設定檔缺失，請重新執行 `claude setup-token` 並再次貼上 token。

## 需求

- Claude Max 或 Pro 訂閱（用於 `claude setup-token`）
- 已安裝 Claude Code CLI（可使用 `claude` 指令）
