---
summary: "Model authentication: OAuth, API keys, and setup-token"
read_when:
  - Debugging model auth or OAuth expiry
  - Documenting authentication or credential storage
title: Authentication
---

# 認證

OpenClaw 支援 OAuth 和 API 金鑰作為模型提供者的認證方式。對於始終在線的網關主機，API 金鑰通常是最可預測的選擇。當訂閱/OAuth 流程與您的提供者帳戶模型相符時，也支援這些流程。

請參閱 [/concepts/oauth](/concepts/oauth) 以了解完整的 OAuth 流程和儲存佈局。  
對於基於 SecretRef 的身份驗證 (`env`/`file`/`exec` 提供者)，請參閱 [Secrets Management](/gateway/secrets)。  
有關 `models status --probe` 使用的憑證資格/原因碼規則，請參閱 [Auth Credential Semantics](/auth-credential-semantics)。

## 推薦的設置（API 金鑰，任何提供者）

如果您正在執行一個長期執行的網關，請從您選擇的提供者那裡獲取 API 金鑰。對於 Anthropic 來說，API 金鑰身份驗證是安全的選擇，並且建議使用這種方式，而不是訂閱設置的 token 身份驗證。

1. 在您的提供者控制台中創建一個 API 金鑰。
2. 將其放置在 **gateway host**（執行 `openclaw gateway` 的機器上）。

```bash
export <PROVIDER>_API_KEY="..."
openclaw models status
```

3. 如果 Gateway 在 systemd/launchd 下執行，建議將金鑰放在 `~/.openclaw/.env` 中，以便守護進程可以讀取它：

```bash
cat >> ~/.openclaw/.env <<'EOF'
<PROVIDER>_API_KEY=...
EOF
```

然後重新啟動守護進程（或重新啟動您的 Gateway 處理程序）並重新檢查：

```bash
openclaw models status
openclaw doctor
```

如果您不想自己管理環境變數，入門精靈可以儲存用於守護進程的 API 金鑰：`openclaw onboard`。

請參閱 [Help](/help) 以獲取有關環境繼承的詳細資訊 (`env.shellEnv`，`~/.openclaw/.env`，systemd/launchd)。

## Anthropic: setup-token (訂閱認證)

如果您正在使用 Claude 訂閱，則支援 setup-token 流程。請在 **gateway host** 上執行它：

```bash
claude setup-token
```

然後將其粘貼到 OpenClaw：

```bash
openclaw models auth setup-token --provider anthropic
```

如果 token 是在另一台機器上創建的，請手動粘貼它：

```bash
openclaw models auth paste-token --provider anthropic
```

如果您看到類似於 Anthropic 的錯誤：

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…請改用 Anthropic API 金鑰。

<Warning>
Anthropic 的 setup-token 支援僅為技術相容性。Anthropic 過去曾阻止某些訂閱在 Claude Code 之外的使用。僅在您決定政策風險可接受的情況下使用，並自行確認 Anthropic 的當前條款。
</Warning>

手動輸入 token（任何提供者；寫入 `auth-profiles.json` + 更新設定）：

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Auth profile refs 也支援靜態憑證：

- `api_key` 憑證可以使用 `keyRef: { source, provider, id }`
- `token` 憑證可以使用 `tokenRef: { source, provider, id }`

自動化友好的檢查（當過期/缺失時退出 `1`，當即將過期時退出 `2`）：

```bash
openclaw models status --check
```

可選的操作腳本（systemd/Termux）在此處有文件記錄：
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` 需要一個互動式 TTY。

## 檢查模型授權狀態

```bash
openclaw models status
openclaw doctor
```

## API 金鑰輪替行為 (網關)

某些供應商支援在 API 呼叫達到供應商速率限制時，使用替代金鑰重試請求。

- 優先順序：
  - `OPENCLAW_LIVE_<PROVIDER>_KEY` (單一覆蓋)
  - `<PROVIDER>_API_KEYS`
  - `<PROVIDER>_API_KEY`
  - `<PROVIDER>_API_KEY_*`
- Google 提供者還包括 `GOOGLE_API_KEY` 作為額外的備援。
- 相同的金鑰列表在使用前會去重。
- OpenClaw 只會在遇到速率限制錯誤時（例如 `429`, `rate_limit`, `quota`, `resource exhausted`）重試下一個金鑰。
- 非速率限制的錯誤不會使用替代金鑰重試。
- 如果所有金鑰都失敗，將返回最後一次嘗試的最終錯誤。

## 控制使用哪個憑證

### 每次會話（聊天指令）

使用 `/model <alias-or-id>@<profileId>` 來為當前會話固定特定的提供者憑證（範例設定檔 ID: `anthropic:default`, `anthropic:work`）。

使用 `/model`（或 `/model list`）來顯示緊湊的選擇器；使用 `/model status` 來顯示完整視圖（候選者 + 下一個授權檔案，以及在設定時的提供者端點詳細資訊）。

### 每個代理 (CLI 覆蓋)

為代理設定明確的身份驗證設定檔順序覆蓋（儲存在該代理的 `auth-profiles.json` 中）：

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

使用 `--agent <id>` 來針對特定代理；如果省略它，則使用已設定的預設代理。

## 故障排除

### “未找到憑證”

如果缺少 Anthropic token 設定檔，請在 **gateway host** 上執行 `claude setup-token`，然後重新檢查：

```bash
openclaw models status
```

### Token 到期/已過期

執行 `openclaw models status` 以確認哪個設定檔即將過期。如果設定檔缺失，請重新執行 `claude setup-token` 並再次貼上 token。

## Requirements

- Anthropic 訂閱帳戶 (用於 `claude setup-token`)
- 已安裝 Claude Code CLI (`claude` 命令可用)
