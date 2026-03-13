---
summary: >-
  Contract for `secrets apply` plans: target validation, path matching, and
  `auth-profiles.json` target scope
read_when:
  - Generating or reviewing `openclaw secrets apply` plans
  - Debugging `Invalid plan target path` errors
  - Understanding target type and path validation behavior
title: Secrets Apply Plan Contract
---

# Secrets 應用計畫合約

此頁面定義了 `openclaw secrets apply` 強制執行的嚴格合約。

如果目標不符合這些規則，則在變更設定之前會應用失敗。

## Plan file shape

`openclaw secrets apply --from <plan.json>` 期望一個 `targets` 陣列的計畫目標：

```json5
{
  version: 1,
  protocolVersion: 1,
  targets: [
    {
      type: "models.providers.apiKey",
      path: "models.providers.openai.apiKey",
      pathSegments: ["models", "providers", "openai", "apiKey"],
      providerId: "openai",
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    },
    {
      type: "auth-profiles.api_key.key",
      path: "profiles.openai:default.key",
      pathSegments: ["profiles", "openai:default", "key"],
      agentId: "main",
      ref: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    },
  ],
}
```

## 支援的目標範圍

計畫目標被接受於支援的憑證路徑中：

- [SecretRef 憑證介面](/reference/secretref-credential-surface)

## 目標類型行為

[[BLOCK_1]]

- `target.type` 必須被識別並且必須符合標準化的 `target.path` 形狀。

相容性別名對於現有計畫仍然被接受：

- `models.providers.apiKey`
- `skills.entries.apiKey`
- `channels.googlechat.serviceAccount`

## 路徑驗證規則

每個目標都會經過以下所有驗證：

- `type` 必須是已識別的目標類型。
- `path` 必須是一個非空的點路徑。
- `pathSegments` 可以省略。如果提供，必須正規化為與 `path` 完全相同的路徑。
- 禁止的段落會被拒絕：`__proto__`、`prototype`、`constructor`。
- 正規化的路徑必須符合目標類型的註冊路徑形狀。
- 如果設定了 `providerId` 或 `accountId`，則必須與路徑中編碼的 id 匹配。
- `auth-profiles.json` 目標需要 `agentId`。
- 在創建新的 `auth-profiles.json` 映射時，請包含 `authProfileProvider`。

## Failure behavior

如果目標未通過驗證，apply 將以錯誤退出，類似於：

```text
Invalid plan target path for models.providers.apiKey: models.providers.openai.baseUrl
```

對於無效的計畫，不會提交任何寫入。

## Runtime 和審計範圍說明

- 只有參考用的 `auth-profiles.json` 專案 (`keyRef`/`tokenRef`) 包含在執行時解析和審核範圍內。
- `secrets apply` 寫入支援的 `openclaw.json` 目標、支援的 `auth-profiles.json` 目標，以及可選的清除目標。

## Operator checks

bash

# 驗證計畫而不進行寫入

openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run

# 然後實際應用

openclaw secrets apply --from /tmp/openclaw-secrets-plan.json

如果應用失敗並顯示無效的目標路徑訊息，請使用 `openclaw secrets configure` 重新生成計畫，或修正目標路徑以符合上述支援的形狀。

## 相關文件

- [秘密管理](/gateway/secrets)
- [CLI `secrets`](/cli/secrets)
- [SecretRef 憑證介面](/reference/secretref-credential-surface)
- [設定參考](/gateway/configuration-reference)
