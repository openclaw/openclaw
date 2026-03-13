---
summary: How OpenClaw rotates auth profiles and falls back across models
read_when:
  - "Diagnosing auth profile rotation, cooldowns, or model fallback behavior"
  - Updating failover rules for auth profiles or models
title: Model Failover
---

# 模型故障轉移

OpenClaw 以兩個階段處理失敗：

1. 在當前供應商內進行 **認證設定輪替**。
2. **模型回退** 至 `agents.defaults.model.fallbacks` 中的下一個模型。

本文檔說明執行時規則及其背後的資料。

## 認證儲存（金鑰 + OAuth）

OpenClaw 使用 **認證設定** 來管理 API 金鑰和 OAuth token。

- 機密資料存放於 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（舊版為 `~/.openclaw/agent/auth-profiles.json`）。
- 設定 `auth.profiles` / `auth.order` 僅包含 **元資料與路由資訊**（不含機密）。
- 舊版僅匯入的 OAuth 檔案：`~/.openclaw/credentials/oauth.json`（首次使用時匯入至 `auth-profiles.json`）。

更多細節請參考：[/concepts/oauth](/concepts/oauth)

認證類型：

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }`（部分供應商另含 `projectId`/`enterpriseUrl`）

## 設定 ID

OAuth 登入會建立獨立設定，讓多個帳號能共存。

- 預設：無電子郵件時為 `provider:default`。
- 有電子郵件的 OAuth：`provider:<email>`（例如 `google-antigravity:user@gmail.com`）。

設定存放於 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` 下的 `profiles`。

## 輪替順序

當一個提供者有多個設定檔時，OpenClaw 會依照以下順序選擇：

1. **明確設定**：`auth.order[provider]`（如果有設定）。
2. **已設定的設定檔**：`auth.profiles` 中依提供者篩選。
3. **儲存的設定檔**：`auth-profiles.json` 中該提供者的條目。

如果沒有明確設定順序，OpenClaw 會使用輪詢（round‑robin）順序：

- **主要鍵**：設定檔類型（**OAuth 優先於 API 金鑰**）。
- **次要鍵**：`usageStats.lastUsed`（每種類型中以最舊的優先）。
- **冷卻/停用的設定檔**會被移到最後，依照最早過期時間排序。

### 會話黏著性（快取友好）

OpenClaw **會將選定的認證設定檔固定於每個會話**，以保持提供者快取的熱度。
它**不會在每次請求時輪換**。固定的設定檔會重複使用，直到：

- 會話被重置（`/new` / `/reset`）
- 完成一次壓縮（壓縮計數增加）
- 設定檔處於冷卻或停用狀態

透過 `/model …@<profileId>` 手動選擇會為該會話設定**使用者覆寫**，
且在新會話開始前不會自動輪換。

自動固定的設定檔（由會話路由器選擇）被視為一種**偏好**：
它們會優先嘗試，但在遇到速率限制或逾時時，OpenClaw 可能會切換到其他設定檔。
使用者固定的設定檔則會保持鎖定；若該設定檔失敗且有模型備援設定，
OpenClaw 會切換到下一個模型，而非更換設定檔。

### 為什麼 OAuth 會「看起來失聯」

如果你對同一提供者同時有 OAuth 設定檔和 API 金鑰設定檔，輪詢機制會在訊息間切換它們，除非有固定設定。要強制使用單一設定檔：

- 使用 `auth.order[provider] = ["provider:profileId"]` 進行固定，或
- 透過 `/model …` 以設定檔覆寫進行每會話覆寫（當你的 UI/聊天介面支援時）。

## 冷卻機制

當設定檔因認證錯誤、速率限制錯誤（或類似速率限制的逾時）失敗時，OpenClaw 會將其標記為冷卻狀態並切換到下一個設定檔。
格式錯誤或無效請求錯誤（例如 Cloud Code Assist 工具呼叫 ID 驗證失敗）會被視為可切換的失敗，並使用相同的冷卻機制。
OpenAI 相容的停止原因錯誤，如 `Unhandled stop reason: error`、`stop reason: error` 和 `reason: error`，被歸類為逾時/切換信號。

冷卻機制採用指數退避：

- 1 分鐘
- 5 分鐘
- 25 分鐘
- 1 小時（上限）

狀態儲存在 `auth-profiles.json` 底下的 `usageStats`：

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

## 計費停用

計費／信用失敗（例如「信用不足」／「信用餘額過低」）會被視為可切換備援的失敗，但通常不是短暫性的。OpenClaw 不會採用短暫冷卻，而是將該設定檔標記為**停用**（並採用較長的退避時間），然後切換到下一個設定檔／供應商。

狀態儲存在 `auth-profiles.json`：

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

- 計費退避從 **5 小時** 開始，每次計費失敗加倍，最高上限為 **24 小時**。
- 若設定檔在 **24 小時** 內未失敗，退避計數器會重置（可設定）。

## 模型回退

如果某供應商的所有設定檔都失敗，OpenClaw 會切換到 `agents.defaults.model.fallbacks` 中的下一個模型。此規則適用於授權失敗、速率限制，以及耗盡設定檔輪替的逾時（其他錯誤不會觸發回退）。

當執行時使用模型覆寫（hooks 或 CLI）時，嘗試完所有設定的回退後，回退仍會在 `agents.defaults.model.primary` 結束。

## 相關設定

請參考 [Gateway configuration](/gateway/configuration) 了解：

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` 路由

請參考 [Models](/concepts/models) 以了解更廣泛的模型選擇與備援概述。
