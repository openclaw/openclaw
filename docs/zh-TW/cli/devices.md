---
summary: "「openclaw devices」的 CLI 參考（裝置配對＋權杖輪替／撤銷）"
read_when:
  - 你正在核准裝置配對請求
  - 你需要輪替或撤銷裝置權杖
title: "裝置"
x-i18n:
  source_path: cli/devices.md
  source_hash: ac7d130ecdc5d429
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:20Z
---

# `openclaw devices`

管理裝置配對請求與以裝置為範圍的權杖。

## Commands

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

為特定角色輪替裝置權杖（可選擇更新範圍）。

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

為特定角色撤銷裝置權杖。

```
openclaw devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`：Gateway 閘道器 WebSocket URL（已設定時預設為 `gateway.remote.url`）。
- `--token <token>`：Gateway 閘道器權杖（若需要）。
- `--password <password>`：Gateway 閘道器密碼（密碼驗證）。
- `--timeout <ms>`：RPC 逾時。
- `--json`：JSON 輸出（建議用於指令碼）。

注意：當你設定 `--url` 時，CLI 不會回退使用設定或環境中的認證。
請明確傳遞 `--token` 或 `--password`。缺少明確的認證將視為錯誤。

## Notes

- 權杖輪替會回傳新的權杖（敏感）。請像對待祕密一樣妥善保管。
- 這些指令需要 `operator.pairing`（或 `operator.admin`）範圍。
