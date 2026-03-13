---
summary: >-
  CLI reference for `openclaw devices` (device pairing + token
  rotation/revocation)
read_when:
  - You are approving device pairing requests
  - You need to rotate or revoke device tokens
title: devices
---

# `openclaw devices`

管理設備配對請求和設備範圍的 token。

## Commands

### `openclaw devices list`

列出待處理的配對請求和已配對的裝置。

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices remove <deviceId>`

刪除一個配對設備條目。

```
openclaw devices remove <deviceId>
openclaw devices remove <deviceId> --json
```

### `openclaw devices clear --yes [--pending]`

批次清除配對的裝置。

```
openclaw devices clear --yes
openclaw devices clear --yes --pending
openclaw devices clear --yes --pending --json
```

### `openclaw devices approve [requestId] [--latest]`

批准一個待處理的設備配對請求。如果 `requestId` 被省略，OpenClaw 將自動批准最近的待處理請求。

```
openclaw devices approve
openclaw devices approve <requestId>
openclaw devices approve --latest
```

### `openclaw devices reject <requestId>`

拒絕一個待處理的設備配對請求。

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

為特定角色旋轉設備token（可選擇性地更新範圍）。

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

撤銷特定角色的裝置 token。

```
openclaw devices revoke --device <deviceId> --role node
```

## 常見選項

- `--url <url>`: 網關 WebSocket URL（在設定時預設為 `gateway.remote.url`）。
- `--token <token>`: 網關 token（如果需要）。
- `--password <password>`: 網關密碼（密碼驗證）。
- `--timeout <ms>`: RPC 超時。
- `--json`: JSON 輸出（建議用於腳本編寫）。

注意：當你設置 `--url` 時，CLI 不會回退到設定或環境憑證。請明確傳遞 `--token` 或 `--password`。缺少明確的憑證將會導致錯誤。

## Notes

- token輪換會返回一個新的token（敏感）。請將其視為秘密。
- 這些命令需要 `operator.pairing`（或 `operator.admin`）範圍。
- `devices clear` 是故意受到 `--yes` 限制的。
- 如果在本地回環上無法使用配對範圍（且未傳遞明確的 `--url`），則列表/批准可以使用本地配對備用方案。

## Token 漂移恢復檢查清單

當控制 UI 或其他用戶端不斷出現 `AUTH_TOKEN_MISMATCH` 或 `AUTH_DEVICE_TOKEN_MISMATCH` 錯誤時，請使用此方法。

1. 確認當前的網關 token 來源：

```bash
openclaw config get gateway.auth.token
```

2. 列出配對的裝置並識別受影響的裝置 ID：

```bash
openclaw devices list
```

3. 旋轉受影響裝置的操作員 token：

```bash
openclaw devices rotate --device <deviceId> --role operator
```

4. 如果旋轉不夠，請移除過期的配對並再次批准：

```bash
openclaw devices remove <deviceId>
openclaw devices list
openclaw devices approve <requestId>
```

5. 使用當前共享的 token/密碼重試用戶端連接。

[[BLOCK_1]]

- [儀表板認證故障排除](/web/dashboard#if-you-see-unauthorized-1008)
- [閘道故障排除](/gateway/troubleshooting#dashboard-control-ui-connectivity)
