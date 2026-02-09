---
summary: "OpenClaw 如何輪替身分驗證設定檔並在模型之間進行後備切換"
read_when:
  - 4. 診斷驗證設定檔輪替、冷卻時間或模型回退行為
  - 更新身分驗證設定檔或模型的失敗切換規則
title: "模型失敗切換"
---

# 模型失敗切換

OpenClaw 以兩個階段處理失敗：

1. 5. 目前供應商內的 **驗證設定檔輪替**。
2. **模型後備切換** 到 `agents.defaults.model.fallbacks` 中的下一個模型。

6) 本文件說明執行階段規則及其背後支撐的資料。

## 身分驗證儲存（金鑰 + OAuth）

OpenClaw 對 API 金鑰與 OAuth 權杖皆使用 **身分驗證設定檔**。

- 祕密資料儲存在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（舊版：`~/.openclaw/agent/auth-profiles.json`）。
- 設定檔 `auth.profiles` / `auth.order` 僅包含 **中繼資料 + 路由**（不含祕密）。
- 舊版僅匯入用的 OAuth 檔案：`~/.openclaw/credentials/oauth.json`（首次使用時匯入到 `auth-profiles.json`）。

更多細節：[/concepts/oauth](/concepts/oauth)

憑證類型：

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }`（部分提供者還有 `projectId`/`enterpriseUrl`）

## 設定檔 ID

OAuth 登入會建立不同的設定檔，讓多個帳號可以共存。

- 預設：當沒有電子郵件時使用 `provider:default`。
- 含電子郵件的 OAuth：`provider:<email>`（例如 `google-antigravity:user@gmail.com`）。

設定檔位於 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` 的 `profiles` 底下。

## 輪替順序

當某個提供者有多個設定檔時，OpenClaw 會依下列順序選擇：

1. **明確設定**：`auth.order[provider]`（若有設定）。
2. **已設定的設定檔**：`auth.profiles`（依提供者過濾）。
3. **已儲存的設定檔**：該提供者在 `auth-profiles.json` 中的項目。

若未設定明確順序，OpenClaw 會使用輪詢（round‑robin）順序：

- **主要鍵值：** 設定檔類型（**OAuth 先於 API 金鑰**）。
- **次要鍵值：** `usageStats.lastUsed`（在各類型內由舊到新）。
- **冷卻中／停用的設定檔** 會被移到最後，並依最早到期時間排序。

### 7. 工作階段黏著性（快取友善）

8. OpenClaw **會在每個工作階段固定所選的驗證設定檔**，以保持供應商快取溫熱。
9. 它**不會**在每次請求時輪替。 10. 固定的設定檔會被重複使用，直到：

- 11. 工作階段被重置（`/new` / `/reset`）
- 12. 一次壓縮完成（壓縮計數遞增）
- 13. 設定檔進入冷卻/被停用

14. 透過 `/model …@<profileId>` 進行的手動選擇，會為該工作階段設定 **使用者覆寫**
    並且在新的工作階段開始之前不會自動輪替。

15. 自動固定的設定檔（由工作階段路由器選擇）被視為一種 **偏好**：
    會優先嘗試，但在遇到速率限制/逾時時，OpenClaw 可能會輪替到另一個設定檔。
16. 使用者固定的設定檔會鎖定在該設定檔；若其失敗且已設定模型回退，
    OpenClaw 會改用下一個模型，而不是切換設定檔。

### 為什麼 OAuth 會「看起來不見」

如果同一提供者同時有 OAuth 設定檔與 API 金鑰設定檔，未固定時，輪詢可能在訊息之間切換它們。若要強制使用單一設定檔： 17. 強制使用單一設定檔：

- 使用 `auth.order[provider] = ["provider:profileId"]` 固定，或
- 18. 使用 `/model …` 的每工作階段覆寫並指定設定檔覆寫（當你的 UI/聊天介面支援時）。

## 19. 冷卻時間

20. 當設定檔因驗證/速率限制錯誤（或看起來像速率限制的逾時）而失敗時，
    OpenClaw 會將其標記為冷卻中，並移至下一個設定檔。
21. 格式/無效請求錯誤（例如 Cloud Code Assist 工具呼叫 ID 驗證失敗）會被視為值得回退，並使用相同的冷卻機制。

22. 冷卻時間使用指數退避：

- 1 分鐘
- 5 分鐘
- 25 分鐘
- 1 小時（上限）

狀態儲存在 `auth-profiles.json` 的 `usageStats` 之下：

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

23. 計費/點數失敗（例如「點數不足」/「點數餘額過低」）被視為值得回退，但通常不是暫時性的。 24. 不採用短冷卻時間，OpenClaw 會將設定檔標記為 **停用**（使用較長的退避），並輪替到下一個設定檔/供應商。

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

25. 預設：

- 計費退避起始為 **5 小時**，每次計費失敗倍增，並在 **24 小時** 封頂。
- 若設定檔 **24 小時** 內未再失敗（可設定），退避計數會重設。

## 模型後備

若某個提供者的所有設定檔都失敗，OpenClaw 會移動到
`agents.defaults.model.fallbacks` 中的下一個模型。這適用於身分驗證失敗、速率限制，
以及已耗盡設定檔輪替的逾時（其他錯誤不會推進後備）。 26. 這適用於驗證失敗、速率限制，以及
已耗盡設定檔輪替的逾時（其他錯誤不會推進回退）。

當一次執行以模型覆寫（hooks 或 CLI）開始時，
在嘗試任何已設定的後備後，後備仍會在 `agents.defaults.model.primary` 結束。

## 相關設定

請參閱 [Gateway 閘道器設定](/gateway/configuration) 以了解：

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` 路由

另請參閱 [Models](/concepts/models) 以取得更完整的模型選擇與後備概覽。
