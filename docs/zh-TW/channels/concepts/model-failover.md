---
summary: How OpenClaw rotates auth profiles and falls back across models
read_when:
  - "Diagnosing auth profile rotation, cooldowns, or model fallback behavior"
  - Updating failover rules for auth profiles or models
title: Model Failover
---

# Model failover

OpenClaw 對失敗的處理分為兩個階段：

1. **當前提供者內的身份驗證設定輪換**。
2. **模型回退**至 `agents.defaults.model.fallbacks` 中的下一個模型。

這份文件解釋了執行時規則及其背後的數據。

## Auth storage (keys + OAuth)

OpenClaw 使用 **auth profiles** 來管理 API 金鑰和 OAuth token。

- Secrets 存放在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (舊版: `~/.openclaw/agent/auth-profiles.json`)。
- Config `auth.profiles` / `auth.order` 僅為 **metadata + routing** (不包含 secrets)。
- 僅供匯入的舊版 OAuth 檔案: `~/.openclaw/credentials/oauth.json` (在首次使用時匯入到 `auth-profiles.json` 中)。

More detail: [/concepts/oauth](/concepts/oauth)

Credential types:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` 針對某些供應商)

## Profile IDs

OAuth 登入會創建獨立的個人資料，因此可以讓多個帳戶共存。

- 預設: `provider:default` 當沒有可用的電子郵件時。
- 使用電子郵件的 OAuth: `provider:<email>` （例如 `google-antigravity:user@gmail.com`）。

Profiles 生活在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` 下的 `profiles`。

## Rotation order

當一個提供者有多個檔案時，OpenClaw 會選擇以下順序：

1. **明確設定**: `auth.order[provider]`（如果已設定）。
2. **已設定的設定檔**: `auth.profiles` 依提供者過濾。
3. **儲存的設定檔**: `auth-profiles.json` 中的條目，針對該提供者。

如果未設定明確的順序，OpenClaw 將使用輪詢順序：

- **主鍵：** 設定檔類型 (**OAuth 在 API 金鑰之前**).
- **次要鍵：** `usageStats.lastUsed` (每種類型內按最舊的優先排序).
- **冷卻/禁用的設定檔** 被移至最後，按最早到期的順序排列.

### Session stickiness (cache-friendly)

OpenClaw **將所選的身份驗證設定檔釘選在每個會話中**，以保持提供者快取的熱度。它**不會**在每個請求中進行輪換。釘選的設定檔會重複使用，直到：

- 會話已重置 (`/new` / `/reset`)
- 一次壓縮完成（壓縮計數增加）
- 設定檔處於冷卻/禁用狀態

透過 `/model …@<profileId>` 手動選擇會為該會話設置 **使用者覆蓋**，並且在新的會話開始之前不會自動輪換。

自動固定的設定檔（由會話路由器選擇）被視為一種 **偏好**：
它們會優先嘗試，但 OpenClaw 可能會因為速率限制或超時而切換到其他設定檔。
用戶固定的設定檔則會鎖定在該設定檔上；如果該設定檔失敗且已設定模型回退，OpenClaw 會轉向下一個模型，而不是切換設定檔。

### 為什麼 OAuth 會「看起來迷失」

如果您對同一提供者擁有 OAuth 設定檔和 API 金鑰設定檔，則圓形輪詢可以在消息之間切換它們，除非已固定。要強制使用單一設定檔：

- 使用 `auth.order[provider] = ["provider:profileId"]` 釘選，或
- 透過 `/model …` 使用每個會話的覆蓋，並使用設定檔覆蓋（當您的 UI/聊天介面支援時）。

## 冷卻時間

當一個設定檔因為身份驗證/速率限制錯誤（或看起來像是速率限制的超時）而失敗時，OpenClaw 會將其標記為冷卻狀態並移動到下一個設定檔。格式/無效請求錯誤（例如 Cloud Code Assist 工具呼叫 ID 驗證失敗）被視為可容錯的，並使用相同的冷卻時間。與 OpenAI 兼容的停止原因錯誤，如 `Unhandled stop reason: error`、`stop reason: error` 和 `reason: error` 被分類為超時/容錯信號。

冷卻時間使用指數退避：

- 1 分鐘
- 5 分鐘
- 25 分鐘
- 1 小時（上限）

State 是儲存在 `auth-profiles.json` 下的 `usageStats`：

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## Billing disables

計費/信用失敗（例如「信用不足」/「信用餘額過低」）被視為值得進行故障轉移，但它們通常不是暫時性的。OpenClaw 不會進行短暫的冷卻，而是將該設定檔標記為 **已禁用**（並進行較長的退避），然後轉換到下一個設定檔/提供者。

狀態儲存在 `auth-profiles.json`:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

Defaults:

- 計費退避從 **5 小時** 開始，因計費失敗而加倍，最高限制為 **24 小時**。
- 如果設定的設定中，該個人資料在 **24 小時** 內未發生失敗，退避計數器將重置。

## Model fallback

如果所有提供者的設定檔都失敗，OpenClaw 將移至 `agents.defaults.model.fallbacks` 中的下一個模型。這適用於身份驗證失敗、速率限制和耗盡設定檔輪換的逾時（其他錯誤不會推進回退）。

當執行以模型覆蓋（hooks 或 CLI）開始時，回退仍然會在 `agents.defaults.model.primary` 結束，這是在嘗試任何已設定的回退之後。

## 相關設定

請參閱 [Gateway configuration](/gateway/configuration) 以獲取：

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` routing

請參閱 [Models](/concepts/models) 以獲取更廣泛的模型選擇和回退概述。
