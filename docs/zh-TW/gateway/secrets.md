---
summary: >-
  Secrets management: SecretRef contract, runtime snapshot behavior, and safe
  one-way scrubbing
read_when:
  - >-
    Configuring SecretRefs for provider credentials and `auth-profiles.json`
    refs
  - "Operating secrets reload, audit, configure, and apply safely in production"
  - >-
    Understanding startup fail-fast, inactive-surface filtering, and
    last-known-good behavior
title: Secrets Management
---

# Secrets management

OpenClaw 支援加法的 SecretRefs，因此支援的憑證不需要以明文形式儲存在設定中。

明文仍然可以使用。SecretRefs 是每個憑證的選擇性功能。

## 目標與執行時模型

Secrets 會被解析為一個記憶體中的執行時快照。

- 在啟動期間，解析是即時的，而不是在請求路徑上延遲。
- 當無法解析有效的活動 SecretRef 時，啟動會快速失敗。
- 重新加載使用原子交換：完全成功，或保留最後已知的良好快照。
- 執行時請求僅從活動的記憶體快照中讀取。
- 外發傳遞路徑也從該活動快照中讀取（例如 Discord 回覆/主題傳遞和 Telegram 行動發送）；它們在每次發送時不會重新解析 SecretRefs。

這樣可以將秘密提供者的故障排除在熱請求路徑之外。

## 主動表面過濾

SecretRefs 只在實際有效的表面上進行驗證。

- 啟用的表面：未解析的引用會阻止啟動/重新載入。
- 不活躍的表面：未解析的引用不會阻止啟動/重新載入。
- 不活躍的引用會發出非致命的診斷，程式碼為 `SECRETS_REF_IGNORED_INACTIVE_SURFACE`。

[[BLOCK_1]]  
不活躍表面的範例：  
[[BLOCK_1]]

- 停用的頻道/帳戶條目。
- 沒有啟用帳戶繼承的頂層頻道憑證。
- 停用的工具/功能介面。
- 由 `tools.web.search.provider` 選擇的網頁搜尋提供者特定的金鑰未被選擇。
  在自動模式下（提供者未設定），金鑰會根據優先順序進行查詢以自動檢測提供者，直到找到一個有效的金鑰。
  選擇後，未選擇的提供者金鑰將被視為非活動狀態，直到被選擇。
- `gateway.remote.token` / `gateway.remote.password` SecretRefs 在以下情況下是活動的：
  - `gateway.mode=remote`
  - `gateway.remote.url` 已設定
  - `gateway.tailscale.mode` 是 `serve` 或 `funnel`
  - 在本地模式下，沒有那些遠端介面：
    - 當 token 認證可以獲勝且未設定環境/認證 token 時，`gateway.remote.token` 是活動的。
    - 當密碼認證可以獲勝且未設定環境/認證密碼時，`gateway.remote.password` 只有在這種情況下才是活動的。
- `gateway.auth.token` SecretRef 在啟動認證解析時是非活動的，當 `OPENCLAW_GATEWAY_TOKEN`（或 `CLAWDBOT_GATEWAY_TOKEN`）被設定時，因為環境 token 輸入在該執行時中優先。

## Gateway 認證介面診斷

當在 `gateway.auth.token`、`gateway.auth.password`、`gateway.remote.token` 或 `gateway.remote.password` 上設定了 SecretRef 時，網關啟動/重新加載會明確記錄表面狀態：

- `active`: SecretRef 是有效的認證範圍的一部分，必須解析。
- `inactive`: 由於另一個認證範圍優先，或因為遠端認證已禁用/未啟用，因此此執行時會忽略 SecretRef。

這些條目是使用 `SECRETS_GATEWAY_AUTH_SURFACE` 記錄的，並包含了活躍表面政策所使用的原因，因此您可以了解為什麼某個憑證被視為活躍或不活躍。

## Onboarding reference preflight

當啟用互動模式的入門流程並選擇 SecretRef 儲存時，OpenClaw 在儲存之前會執行預檢驗證：

- 環境參考: 驗證環境變數名稱並確認在入門過程中可見的非空值。
- 提供者參考 (`file` 或 `exec`): 驗證提供者選擇，解析 `id`，並檢查解析後的值類型。
- 快速啟動重用路徑: 當 `gateway.auth.token` 已經是 SecretRef 時，入門過程在探測/儀表板啟動之前解析它（針對 `env`、`file` 和 `exec` 參考）使用相同的快速失敗閘道。

如果驗證失敗，入門流程會顯示錯誤並讓您重試。

## SecretRef 合約

使用一種物件形狀於所有地方：

```json5
{ source: "env" | "file" | "exec", provider: "default", id: "..." }
```

### `source: "env"`

```json5
{ source: "env", provider: "default", id: "OPENAI_API_KEY" }
```

Validation:

- `provider` 必須與 `^[a-z][a-z0-9_-]{0,63}$` 相符
- `id` 必須與 `^[A-Z][A-Z0-9_]{0,127}$` 相符

### `source: "file"`

```json5
{ source: "file", provider: "filemain", id: "/providers/openai/apiKey" }
```

Validation:

- `provider` 必須與 `^[a-z][a-z0-9_-]{0,63}$` 相符
- `id` 必須是一個絕對的 JSON 指標 (`/...`)
- 段落中的 RFC6901 轉義: `~` => `~0`，`/` => `~1`

### `source: "exec"`

```json5
{ source: "exec", provider: "vault", id: "providers/openai/apiKey" }
```

Validation:

- `provider` 必須與 `^[a-z][a-z0-9_-]{0,63}$` 相符
- `id` 必須與 `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$` 相符
- `id` 不得包含 `.` 或 `..` 作為斜線分隔的路徑段（例如 `a/../b` 是不被接受的）

## Provider config

定義 `secrets.providers` 下的提供者：

```json5
{
  secrets: {
    providers: {
      default: { source: "env" },
      filemain: {
        source: "file",
        path: "~/.openclaw/secrets.json",
        mode: "json", // or "singleValue"
      },
      vault: {
        source: "exec",
        command: "/usr/local/bin/openclaw-vault-resolver",
        args: ["--profile", "prod"],
        passEnv: ["PATH", "VAULT_ADDR"],
        jsonOnly: true,
      },
    },
    defaults: {
      env: "default",
      file: "filemain",
      exec: "vault",
    },
    resolution: {
      maxProviderConcurrency: 4,
      maxRefsPerProvider: 512,
      maxBatchBytes: 262144,
    },
  },
}
```

### Env provider

- 可選的允許清單透過 `allowlist`。
- 缺少或空的環境變數將導致解析失敗。

### File provider

- 從 `path` 讀取本地檔案。
- `mode: "json"` 期望 JSON 物件有效載荷並解析 `id` 作為指標。
- `mode: "singleValue"` 期望參考 ID `"value"` 並返回檔案內容。
- 路徑必須通過擁有權/權限檢查。
- Windows 失敗關閉註解：如果路徑的 ACL 驗證不可用，解析將失敗。僅對受信任的路徑，將 `allowInsecurePath: true` 設定在該提供者上以繞過路徑安全檢查。

### Exec provider

- 執行設定的絕對二進位路徑，不使用 shell。
- 預設情況下，`command` 必須指向一個常規檔案（而不是符號連結）。
- 設定 `allowSymlinkCommand: true` 以允許符號連結命令路徑（例如 Homebrew shims）。OpenClaw 會驗證解析後的目標路徑。
- 將 `allowSymlinkCommand` 與 `trustedDirs` 配對以用於套件管理器路徑（例如 `["/opt/homebrew"]`）。
- 支援超時、無輸出超時、輸出位元組限制、環境允許清單和受信任目錄。
- Windows 失敗關閉注意：如果命令路徑的 ACL 驗證不可用，則解析失敗。僅對受信任的路徑，將 `allowInsecurePath: true` 設定在該提供者上以繞過路徑安全檢查。

Request payload (stdin):

```json
{ "protocolVersion": 1, "provider": "vault", "ids": ["providers/openai/apiKey"] }
```

Response payload (stdout):

```jsonc
{ "protocolVersion": 1, "values": { "providers/openai/apiKey": "<openai-api-key>" } } // pragma: allowlist secret
```

[[BLOCK_1]]  
可選的每個 ID 錯誤：  
[[BLOCK_1]]

```json
{
  "protocolVersion": 1,
  "values": {},
  "errors": { "providers/openai/apiKey": { "message": "not found" } }
}
```

## Exec 整合範例

### 1Password CLI

```json5
{
  secrets: {
    providers: {
      onepassword_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/op",
        allowSymlinkCommand: true, // required for Homebrew symlinked binaries
        trustedDirs: ["/opt/homebrew"],
        args: ["read", "op://Personal/OpenClaw QA API Key/password"],
        passEnv: ["HOME"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
        apiKey: { source: "exec", provider: "onepassword_openai", id: "value" },
      },
    },
  },
}
```

### HashiCorp Vault CLI

```json5
{
  secrets: {
    providers: {
      vault_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/vault",
        allowSymlinkCommand: true, // required for Homebrew symlinked binaries
        trustedDirs: ["/opt/homebrew"],
        args: ["kv", "get", "-field=OPENAI_API_KEY", "secret/openclaw"],
        passEnv: ["VAULT_ADDR", "VAULT_TOKEN"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
        apiKey: { source: "exec", provider: "vault_openai", id: "value" },
      },
    },
  },
}
```

### `sops`

```json5
{
  secrets: {
    providers: {
      sops_openai: {
        source: "exec",
        command: "/opt/homebrew/bin/sops",
        allowSymlinkCommand: true, // required for Homebrew symlinked binaries
        trustedDirs: ["/opt/homebrew"],
        args: ["-d", "--extract", '["providers"]["openai"]["apiKey"]', "/path/to/secrets.enc.json"],
        passEnv: ["SOPS_AGE_KEY_FILE"],
        jsonOnly: false,
      },
    },
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5", name: "gpt-5" }],
        apiKey: { source: "exec", provider: "sops_openai", id: "value" },
      },
    },
  },
}
```

## 支援的憑證介面

Canonical 支援和不支援的憑證列在：

- [SecretRef 憑證介面](/reference/secretref-credential-surface)

Runtime-minted 或輪換的憑證以及 OAuth 刷新材料故意被排除在只讀 SecretRef 解析之外。

## 必要的行為和優先順序

- 沒有參考的欄位：保持不變。
- 有參考的欄位：在啟用期間必須在活動表面上提供。
- 如果同時存在明文和參考，則在支援的優先路徑中，參考具有優先權。

[[BLOCK_1]]  
警告和審計信號：  
[[BLOCK_1]]

- `SECRETS_REF_OVERRIDES_PLAINTEXT` (執行時警告)
- `REF_SHADOWED` (當 `auth-profiles.json` 憑證優先於 `openclaw.json` 參考時的審計發現)

Google Chat 相容性行為：

- `serviceAccountRef` 優先於純文字 `serviceAccount`。
- 當兄弟引用被設定時，純文字值將被忽略。

## Activation triggers

Secret activation runs on:

- 啟動（預檢加最終啟用）
- 設定重新加載熱應用路徑
- 設定重新加載重啟檢查路徑
- 通過 `secrets.reload` 手動重新加載

[[BLOCK_1]]

- 成功會原子性地交換快照。
- 啟動失敗會中止閘道的啟動。
- 執行時重新載入失敗會保留最後已知的良好快照。
- 提供明確的每次呼叫通道 token 給外部輔助/工具呼叫不會觸發 SecretRef 的啟用；啟用點仍然是啟動、重新載入和明確的 `secrets.reload`。

## 降級與恢復的信號

當重新載入時的啟用在健康狀態後失敗時，OpenClaw 會進入降級的秘密狀態。

[[BLOCK_1]]  
一次性系統事件和日誌程式碼：  
[[BLOCK_1]]

- `SECRETS_RELOADER_DEGRADED`
- `SECRETS_RELOADER_RECOVERED`

[[BLOCK_1]]

- 降級：執行時保持最後已知的良好快照。
- 恢復：在下一次成功啟動後發出一次。
- 在已降級的情況下重複失敗會記錄警告，但不會重複發送事件。
- 啟動快速失敗不會發出降級事件，因為執行時從未變為活動狀態。

## Command-path 解析

命令路徑可以透過網關快照 RPC 選擇支援的 SecretRef 解析。

有兩種廣泛的行為：

- 嚴格的指令路徑（例如 `openclaw memory` 遠端記憶體路徑和 `openclaw qr --remote`）會從當前快照中讀取，並在所需的 SecretRef 不可用時快速失敗。
- 只讀指令路徑（例如 `openclaw status`、`openclaw status --all`、`openclaw channels status`、`openclaw channels resolve`，以及只讀的 doctor/config 修復流程）也偏好使用當前快照，但在該指令路徑中當目標 SecretRef 不可用時會降級而不是中止。

[[BLOCK_1]] 只讀行為：[[BLOCK_1]]

- 當網關執行時，這些命令會首先從活動快照中讀取。
- 如果網關解析不完整或網關不可用，它們會嘗試針對特定命令介面的本地回退。
- 如果目標 SecretRef 仍然不可用，命令將繼續以降級的唯讀輸出和明確的診斷資訊，例如「已設定但在此命令路徑中不可用」。
- 這種降級行為僅限於命令本身。它不會削弱執行時啟動、重新加載或發送/驗證路徑。

其他備註：

- 後端密鑰輪替後的快照刷新由 `openclaw secrets reload` 處理。
- 這些命令路徑使用的 Gateway RPC 方法為: `secrets.resolve`。

## 審核與設定工作流程

Default operator flow:

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

### `secrets audit`

[[BLOCK_1]]  
發現包括：  
[[BLOCK_1]]

- 靜態的明文值 (`openclaw.json`, `auth-profiles.json`, `.env`，以及生成的 `agents/*/agent/models.json`)
- 生成的 `models.json` 專案中的明文敏感提供者標頭殘留
- 未解決的引用
- 優先權遮蔽 (`auth-profiles.json` 優先於 `openclaw.json` 引用)
- 遺留殘留 (`auth.json`，OAuth 提醒)

Header residue note:

- 敏感提供者標頭檢測是基於名稱的啟發式方法（常見的身份驗證/憑證標頭名稱和片段，例如 `authorization`、`x-api-key`、`token`、`secret`、`password` 和 `credential`）。

### `secrets configure`

[[BLOCK_1]]

- 設定 `secrets.providers` 首先 (`env`/`file`/`exec`，新增/編輯/移除)
- 讓你在 `openclaw.json` 中選擇支援的秘密承載欄位，以及 `auth-profiles.json` 針對一個代理範圍
- 可以直接在目標選擇器中創建新的 `auth-profiles.json` 映射
- 捕捉 SecretRef 詳細資訊 (`source`、`provider`、`id`)
- 執行預檢解析
- 可以立即應用

[[BLOCK_1]]

- `openclaw secrets configure --providers-only`
- `openclaw secrets configure --skip-provider-setup`
- `openclaw secrets configure --agent <id>`

`configure` 應用預設值：

- 從 `auth-profiles.json` 中刪除針對特定提供者的靜態憑證
- 從 `auth.json` 中刪除舊版靜態 `api_key` 條目
- 從 `<config-dir>/.env` 中刪除匹配的已知秘密行

### `secrets apply`

應用已儲存的計畫：

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
```

有關嚴格的目標/路徑合約細節和確切的拒絕規則，請參見：

- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)

## 單向安全政策

OpenClaw 故意不寫入包含歷史明文秘密值的回滾備份。

[[BLOCK_1]]

- 必須在寫入模式之前成功執行預檢
- 在提交之前驗證執行時啟用
- 使用原子檔案替換和最佳努力恢復失敗時應用更新檔案

## Legacy auth 兼容性說明

對於靜態憑證，執行時不再依賴明文的舊版身份驗證儲存。

- 執行時憑證來源是解析後的記憶體快照。
- 當發現時，舊版靜態 `api_key` 專案會被清除。
- 與 OAuth 相關的相容性行為保持獨立。

## Web UI 注意事項

某些 SecretInput 聯合在原始編輯器模式下比在表單模式下更容易設定。

## 相關文件

- CLI 指令: [secrets](/cli/secrets)
- 計畫合約詳細資訊: [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)
- 憑證表面: [SecretRef Credential Surface](/reference/secretref-credential-surface)
- 認證設定: [Authentication](/gateway/authentication)
- 安全性姿態: [Security](/gateway/security)
- 環境優先順序: [Environment Variables](/help/environment)
