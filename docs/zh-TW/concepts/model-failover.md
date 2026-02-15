---
summary: "OpenClaw 如何輪替憑證設定檔並在模型間進行回退"
read_when:
  - 診斷憑證設定檔輪替、冷卻時間或模型回退行為
  - 更新憑證設定檔或模型的容錯移轉規則
title: "模型容錯移轉"
---

# 模型容錯移轉

OpenClaw 分兩個階段處理故障：

1. **憑證設定檔輪替**：在目前供應商（provider）內切換。
2. **模型回退**：回退至 `agents.defaults.model.fallbacks` 中的下一個模型。

本文件說明執行階段的規則以及其背後的數據。

## 憑證儲存 (金鑰 + OAuth)

OpenClaw 使用 **憑證設定檔 (auth profiles)** 來管理 API 金鑰與 OAuth 權杖。

- 機密資訊儲存於 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (舊版路徑：`~/.openclaw/agent/auth-profiles.json`)。
- 設定中的 `auth.profiles` / `auth.order` 僅為 **元數據與路由** (不含機密資訊)。
- 舊版僅供匯入的 OAuth 檔案：`~/.openclaw/credentials/oauth.json` (於首次使用時匯入至 `auth-profiles.json`)。

了解詳情：[/concepts/oauth](/concepts/oauth)

憑證類型：

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (部分供應商包含 `projectId`/`enterpriseUrl`)

## 設定檔 ID

OAuth 登入會建立獨特的設定檔，以便多個帳號並存。

- 預設值：無可用電子郵件時為 `provider:default`。
- 帶電子郵件的 OAuth：`provider:<email>` (例如 `google-antigravity:user@gmail.com`)。

設定檔儲存在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` 的 `profiles` 欄位下。

## 輪替順序

當一個供應商有多個設定檔時，OpenClaw 會依以下順序選擇：

1. **明確設定**：`auth.order[provider]` (若有設定)。
2. **已設定的設定檔**：依供應商過濾後的 `auth.profiles`。
3. **儲存的設定檔**：`auth-profiles.json` 中該供應商的項目。

若未設定明確順序，OpenClaw 會使用輪詢 (round‑robin) 順序：

- **主要排序依據：** 設定檔類型 (**OAuth 優於 API 金鑰**)。
- **次要排序依據：** `usageStats.lastUsed` (每一種類型中，最久未使用的優先)。
- **冷卻中/已停用的設定檔**會移至最後，並依最快到期時間排序。

### 工作階段固定性 (快取友善)

OpenClaw **會針對每個工作階段 (session) 固定選擇的憑證設定檔**，以維持供應商快取的熱度。
它**不會**在每次請求時輪替。固定的設定檔會持續使用，直到：

- 工作階段被重設 (`/new` / `/reset`)
- compaction 完成 (compaction 計數增加)
- 設定檔處於冷卻或停用狀態

透過 `/model … @<profileId>` 手動選擇會為該工作階段設定**使用者覆蓋 (user override)**，且在新的工作階段開始前不會自動輪替。

自動固定的設定檔 (由工作階段路由器選擇) 被視為一種**偏好**：
系統會先嘗試使用它們，但在遇到速率限制 (rate limits) 或逾時時，OpenClaw 可能會輪替至另一個設定檔。使用者手動固定的設定檔則會鎖定在該設定檔；若失敗且已設定模型回退，OpenClaw 會直接進入下一個模型，而非切換設定檔。

### 為何 OAuth 有時會「消失」

若同一個供應商同時擁有 OAuth 設定檔與 API 金鑰設定檔，在未固定的情況下，輪詢機制可能會在不同訊息間切換。若要強制使用單一設定檔：

- 使用 `auth.order[provider] = ["provider:profileId"]` 進行固定，或
- 透過 `/model …` 使用特定設定檔覆蓋該工作階段 (若您的 UI/聊天介面支援)。

## 冷卻時間

當設定檔因憑證/速率限制錯誤 (或看起來像速率限制的逾時) 而失敗時，OpenClaw 會將其標記為冷卻中並移至下一個設定檔。格式錯誤或無效請求錯誤 (例如 Cloud Code Assist 工具呼叫 ID 驗證失敗) 也被視為符合容錯移轉條件，並使用相同的冷卻機制。

冷卻時間使用指數退避 (exponential backoff)：

- 1 分鐘
- 5 分鐘
- 25 分鐘
- 1 小時 (上限)

狀態儲存在 `auth-profiles.json` 的 `usageStats` 欄位中：

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

## 帳單停用

帳單或額度錯誤 (例如「餘額不足」/「額度過低」) 被視為符合容錯移轉條件，但這些通常不是暫時性錯誤。OpenClaw 不會使用短暫的冷卻時間，而是將設定檔標記為**已停用** (搭配較長的退避時間)，並輪替至下一個設定檔或供應商。

狀態儲存在 `auth-profiles.json` 中：

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

預設值：

- 帳單退避從 **5 小時**開始，每次帳單失敗加倍，上限為 **24 小時**。
- 若設定檔在 **24 小時**內未發生失敗，退避計數器將會重設 (可調整設定)。

## 模型回退

若供應商的所有設定檔皆失敗，OpenClaw 會移動至 `agents.defaults.model.fallbacks` 中的下一個模型。這適用於憑證錯誤、速率限制以及已耗盡設定檔輪替的逾時 (其他錯誤不會觸發回退)。

當啟動時帶有模型覆蓋 (透過 hooks 或 CLI) 時，在嘗試完所有設定的回退模型後，最終仍會回到 `agents.defaults.model.primary`。

## 相關設定

請參閱 [Gateway 設定](/gateway/configuration) 以了解：

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` 路由

請參閱 [模型](/concepts/models) 以了解更廣泛的模型選擇與回退概觀。
