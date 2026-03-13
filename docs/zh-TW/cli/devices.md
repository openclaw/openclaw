---
summary: "管理與 Gateway 配對的裝置"
read_when:
  - 核准新的 UI 或代理連接時
  - 撤銷裝置存取權或輪換 token 時
  - 診斷 AUTH_TOKEN_MISMATCH 錯誤時
title: "裝置管理"
---

# 裝置管理 (CLI)

`openclaw devices` 指令集讓您可以管理與 Gateway 配對的客戶端（例如 Web Control UI、行動節點或其他 CLI 實例）。

## 常用指令

```bash
# 列出所有已配對或待核准的裝置
openclaw devices list

# 核准一個待處理的配對請求
openclaw devices approve <device-id>

# 撤銷（刪除）一個已配對的裝置
openclaw devices remove <device-id>

# 清除所有已配對的裝置（需搭配 --yes）
openclaw devices clear --yes
```

## 全域選項

- `--url <url>`：Gateway WebSocket URL（若有設定，預設為 `gateway.remote.url`）。
- `--token <token>`：Gateway token（若需要）。
- `--password <password>`：Gateway 密碼（密碼驗證模式）。
- `--timeout <ms>`：RPC 逾時時間。
- `--json`：JSON 格式輸出（建議用於腳本編寫）。

注意：當您設定了 `--url` 時，CLI 不會自動退回到設定檔或環境變數中的憑證。請明確傳遞 `--token` 或 `--password`。缺少明確憑證將導致錯誤。

---

## 注意事項

- Token 輪換會回傳一個新的 token（敏感資訊）。請將其視為秘密。
- 這些指令需要 `operator.pairing`（或 `operator.admin`）權限範圍。
- `devices clear` 被刻意限制需加上 `--yes` 才能執行。
- 如果本地迴圈（local loopback）上無法取得配對範圍（且未傳遞明確的 `--url`），list/approve 可以使用本地配對退回方案。

---

## Token 偏差修復核對清單

當 Control UI 或其他客戶端持續出現 `AUTH_TOKEN_MISMATCH` 或 `AUTH_DEVICE_TOKEN_MISMATCH` 錯誤時，請使用此清單。

1. 確認目前的 Gateway token 來源：

```bash
openclaw config get gateway.auth.token
```

2. 列出已配對裝置並識別受影響的裝置 ID：

```bash
openclaw devices list
```
