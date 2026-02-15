---
summary: "openclaw devices 的 CLI 參考（裝置配對 + 權杖輪換/撤銷）"
read_when:
  - 您正在核准裝置配對請求
  - 您需要輪換或撤銷裝置權杖
title: "devices"
---

# `openclaw devices`

管理裝置配對請求與裝置範圍權杖。

## 指令

### `openclaw devices list`

列出待處理的配對請求與已配對的裝置。

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

為特定角色輪換裝置權杖（可選擇更新範圍）。

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

撤銷特定角色的裝置權杖。

```
openclaw devices revoke --device <deviceId> --role node
```

## 常見選項

- `--url <url>`: Gateway WebSocket URL（設定後預設為 `gateway.remote.url`）。
- `--token <token>`: Gateway 權杖（如果需要）。
- `--password <password>`: Gateway 密碼（密碼認證）。
- `--timeout <ms>`: RPC 逾時。
- `--json`: JSON 輸出（建議用於腳本編寫）。

注意：當您設定 `--url` 時，CLI 不會回退到設定檔或環境變數憑證。請明確傳遞 `--token` 或 `--password`。缺少明確的憑證將會發生錯誤。

## 附註

- 權杖輪換會傳回新的權杖（敏感資訊）。請將其視為秘密。
- 這些指令需要 `operator.pairing`（或 `operator.admin`）範圍。
