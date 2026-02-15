```
---
summary: "OpenClaw CLI `devices` 參考 (裝置配對 + token 輪替/撤銷)"
read_when:
  - 您正在核准裝置配對請求
  - 您需要輪替或撤銷裝置 token
title: "devices"
---

# `openclaw devices`

管理裝置配對請求和裝置範圍的 token。

## 命令

### `openclaw devices list`

列出待處理的配對請求和已配對的裝置。

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

核准待處理的裝置配對請求。

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

拒絕待處理的裝置配對請求。

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

輪替特定角色的裝置 token（可選地更新範圍）。

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

撤銷特定角色的裝置 token。

```
openclaw devices revoke --device <deviceId> --role node
```

## 常見選項

- `--url <url>`: Gateway WebSocket URL (預設為 `gateway.remote.url` 如果已設定)。
- `--token <token>`: Gateway token (如果需要)。
- `--password <password>`: Gateway 密碼 (密碼憑證)。
- `--timeout <ms>`: RPC 逾時。
- `--json`: JSON 輸出 (建議用於腳本)。

注意：當您設定 `--url` 時，CLI 不會回退到設定或環境憑證。
請明確傳遞 `--token` 或 `--password`。缺少明確憑證會導致錯誤。

## 備註

- Token 輪替會返回一個新的 token（敏感資訊）。請將其視為機密。
- 這些命令需要 `operator.pairing`（或 `operator.admin`）範圍。
```
