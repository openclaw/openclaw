# 認證憑證語意

本文件定義了在以下範疇中使用的標準憑證資格和解析語義：

- `resolveAuthProfileOrder`
- `resolveApiKeyForProfile`
- `models status --probe`
- `doctor-auth`

目標是保持選擇時間和執行時行為的一致性。

## 穩定的原因程式碼

- `ok`
- `missing_credential`
- `invalid_expires`
- `expired`
- `unresolved_ref`

## Token 憑證

Token 憑證 (`type: "token"`) 支援內嵌 `token` 和/或 `tokenRef`。

### 申請資格規則

1. 當 `token` 和 `tokenRef` 同時缺失時，token 設定檔不符合資格。
2. `expires` 是可選的。
3. 如果 `expires` 存在，則必須是一個大於 `0` 的有限數字。
4. 如果 `expires` 無效（`NaN`、`0`、負數、非有限或錯誤類型），則該設定檔因 `invalid_expires` 而不符合資格。
5. 如果 `expires` 在過去，則該設定檔因 `expired` 而不符合資格。
6. `tokenRef` 不會繞過 `expires` 驗證。

### 解決規則

1. 解析器語義與 `expires` 的資格語義相符。
2. 對於符合資格的設定檔，token 資料可以從內嵌值或 `tokenRef` 中解析。
3. 無法解析的引用在 `models status --probe` 輸出中產生 `unresolved_ref`。

## 舊版相容的訊息傳遞

為了腳本相容性，探測錯誤請保持這第一行不變：

`Auth profile credentials are missing or expired.`

可以在後續行中添加人性化的詳細資訊和穩定的原因程式碼。
