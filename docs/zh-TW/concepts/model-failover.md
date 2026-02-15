---
summary: "OpenClaw 如何輪換憑證設定檔並在不同模型間回退"
read_when:
  - 診斷憑證設定檔輪換、冷卻時間或模型回退行為
  - 更新憑證設定檔或模型的回退規則
title: "模型回退"
---

# 模型回退

OpenClaw 處理失敗分兩個階段：

1. 目前供應商內的**憑證設定檔輪換**。
2. **模型回退**到 `agents.defaults.model.fallbacks` 中的下一個模型。

這份文件解釋了執行時規則和支援這些規則的資料。

## 憑證儲存 (金鑰 + OAuth)

OpenClaw 使用**憑證設定檔**來處理 API 金鑰和 OAuth 權杖。

- 密鑰儲存在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (舊版：`~/.openclaw/agent/auth-profiles.json`)。
- 設定 `auth.profiles` / `auth.order` 僅為**中繼資料 + 路由**（不含密鑰）。
- 僅供匯入的舊版 OAuth 檔案：`~/.openclaw/credentials/oauth.json`（首次使用時會匯入 `auth-profiles.json`）。

了解詳情：[/concepts/oauth](/concepts/oauth)

憑證類型：

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }`（部分供應商還有 `projectId`/`enterpriseUrl`）

## 設定檔 ID

OAuth 登入會建立不同的設定檔，以便多個帳戶可以同時存在。

- 預設：當沒有電子郵件可用時為 `provider:default`。
- 帶有電子郵件的 OAuth：`provider:<email>`（例如 `google-antigravity:user@gmail.com`）。

設定檔儲存在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` 中的 `profiles` 下。

## 輪換順序

當供應商有多個設定檔時，OpenClaw 會依照以下順序選擇：

1. **明確設定**：`auth.order[provider]`（如果已設定）。
2. **已設定的設定檔**：`auth.profiles` 依供應商篩選。
3. **已儲存的設定檔**：`auth-profiles.json` 中該供應商的項目。

如果沒有設定明確順序，OpenClaw 會使用循環（round‑robin）順序：

- **主要金鑰**：設定檔類型（**OAuth 在 API 金鑰之前**）。
- **次要金鑰**：`usageStats.lastUsed`（每個類型中最早使用的優先）。
- **冷卻/停用的設定檔**會移到最後，依最近的過期時間排序。

### 工作階段黏性 (快取友善)

OpenClaw **將每個工作階段選定的憑證設定檔固定**，以保持供應商快取活躍。
它**不會**在每個請求上輪換。固定的設定檔會重複使用，直到：

- 工作階段重設（`/new` / `/reset`）
- 壓縮完成（壓縮計數增加）
- 設定檔處於冷卻/停用狀態

透過 `/model … @<profileId>` 手動選擇會為該工作階段設定**使用者覆蓋**，並且在新的工作階段開始之前不會自動輪換。

自動固定的設定檔（由工作階段路由選定）被視為**偏好**：它們會首先被嘗試，但 OpenClaw 可能會在達到速率限制/逾時時輪換到另一個設定檔。使用者固定的設定檔則保持鎖定；如果它失敗並且配置了模型回退，OpenClaw 將移動到下一個模型，而不是切換設定檔。

### 為何 OAuth 可能會「看起來遺失」

如果您為同一個供應商同時擁有 OAuth 設定檔和 API 金鑰設定檔，除非固定，否則循環可能會在不同訊息之間切換。要強制使用單一設定檔：

- 使用 `auth.order[provider] = ["provider:profileId"]` 固定，或
- 透過 `/model …` 使用每工作階段覆蓋（當您的 UI/聊天介面支援時）。

## 冷卻時間

當設定檔因憑證/速率限制錯誤（或看起來像速率限制的逾時）而失敗時，OpenClaw 會將其標記為冷卻狀態，並移至下一個設定檔。格式/無效請求錯誤（例如 Cloud Code Assist 工具呼叫 ID 驗證失敗）也被視為需要回退，並使用相同的冷卻時間。

冷卻時間使用指數退避：

- 1 分鐘
- 5 分鐘
- 25 分鐘
- 1 小時（上限）

狀態儲存在 `auth-profiles.json` 的 `usageStats` 下：

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

## 帳務停用

帳務/信用失敗（例如「信用額度不足」/「信用餘額過低」）被視為需要回退，但它們通常不是暫時性的。OpenClaw 會將設定檔標記為**停用**（並延長退避時間），而不是短暫冷卻，然後輪換到下一個設定檔/供應商。

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

- 帳務退避時間從**5 小時**開始，每次帳務失敗加倍，上限為**24 小時**。
- 如果設定檔在**24 小時**內沒有失敗，退避計數器會重設（可設定）。

## 模型回退

如果供應商的所有設定檔都失敗，OpenClaw 會移至 `agents.defaults.model.fallbacks` 中的下一個模型。這適用於憑證失敗、速率限制和耗盡設定檔輪換的逾時（其他錯誤不會觸發回退）。

當執行以模型覆蓋（hooks 或 CLI）開始時，回退仍會在嘗試任何已設定的回退後，結束於 `agents.defaults.model.primary`。

## 相關設定

有關以下內容，請參閱 [Gateway 設定](/gateway/configuration)：

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` 路由

有關更廣泛的模型選擇和回退概覽，請參閱 [模型](/concepts/models)。
