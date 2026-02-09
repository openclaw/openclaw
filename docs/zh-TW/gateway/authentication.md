---
summary: "模型身分驗證：OAuth、API 金鑰與 setup-token"
read_when:
  - 偵錯模型身分驗證或 OAuth 到期問題
  - 撰寫身分驗證或憑證儲存文件
title: "Authentication"
---

# Authentication

OpenClaw 支援模型提供者的 OAuth 與 API 金鑰。對於 Anthropic
帳戶，我們建議使用 **API 金鑰**。若要存取 Claude 訂閱，
請使用由 `claude setup-token` 建立的長效權杖。 For Anthropic
accounts, we recommend using an **API key**. For Claude subscription access,
use the long‑lived token created by `claude setup-token`.

完整的 OAuth 流程與儲存配置，請參閱 [/concepts/oauth](/concepts/oauth)。

## 建議的 Anthropic 設定（API 金鑰）

若您直接使用 Anthropic，請使用 API 金鑰。

1. 在 Anthropic Console 建立一個 API 金鑰。
2. 將它放在 **Gateway 閘道器主機**（執行 `openclaw gateway` 的機器）上。

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. 若 Gateway 在 systemd／launchd 下執行，建議將金鑰放在
   `~/.openclaw/.env`，以便常駐程式可讀取：

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

接著重新啟動常駐程式（或重新啟動您的 Gateway 程序）並再次檢查：

```bash
openclaw models status
openclaw doctor
```

If you’d rather not manage env vars yourself, the onboarding wizard can store
API keys for daemon use: `openclaw onboard`.

關於環境變數繼承（`env.shellEnv`、`~/.openclaw/.env`、systemd／launchd）的詳細資訊，請參閱 [Help](/help)。

## Anthropic：setup-token（訂閱身分驗證）

For Anthropic, the recommended path is an **API key**. If you’re using a Claude
subscription, the setup-token flow is also supported. Run it on the **gateway host**:

```bash
claude setup-token
```

接著將其貼到 OpenClaw：

```bash
openclaw models auth setup-token --provider anthropic
```

若權杖是在另一台機器上建立，請手動貼上：

```bash
openclaw models auth paste-token --provider anthropic
```

若您看到如下的 Anthropic 錯誤：

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

……請改用 Anthropic API 金鑰。

手動輸入權杖（任何提供者；寫入 `auth-profiles.json` 並更新設定）：

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

自動化友善的檢查（到期／缺失時以 `1` 結束，將到期時以 `2` 結束）：

```bash
openclaw models status --check
```

選用的營運腳本（systemd／Termux）文件在此：
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` 需要互動式 TTY。

## 檢查模型身分驗證狀態

```bash
openclaw models status
openclaw doctor
```

## 控制使用哪一個憑證

### 依工作階段（聊天指令）

使用 `/model <alias-or-id>@<profileId>` 為目前工作階段固定特定提供者的憑證（範例設定檔 ID：`anthropic:default`、`anthropic:work`）。

使用 `/model`（或 `/model list`）取得精簡選擇器；使用 `/model status` 取得完整檢視（候選項目 + 下一個身分驗證設定檔，並在已設定時顯示提供者端點細節）。

### 依代理程式（CLI 覆寫）

為代理程式設定明確的身分驗證設定檔排序覆寫（儲存在該代理程式的 `auth-profiles.json`）：

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

使用 `--agent <id>` 指定特定代理程式；省略則使用已設定的預設代理程式。

## Troubleshooting

### 「找不到任何憑證」

若缺少 Anthropic 權杖設定檔，請在
**Gateway 閘道器主機** 上執行 `claude setup-token`，然後再次檢查：

```bash
openclaw models status
```

### Token expiring/expired

Run `openclaw models status` to confirm which profile is expiring. If the profile
is missing, rerun `claude setup-token` and paste the token again.

## 需求

- Claude Max 或 Pro 訂閱（用於 `claude setup-token`）
- 已安裝 Claude Code CLI（可使用 `claude` 指令）
