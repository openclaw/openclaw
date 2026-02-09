---
read_when:
  - 你正在批准设备配对请求
  - 你需要轮换或撤销设备 token
summary: "`EasyHub devices` 的 CLI 参考（设备配对 + token 轮换/撤销）"
title: devices
x-i18n:
  generated_at: "2026-02-03T07:44:52Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 52f903817d2886c1dc29b85d30168d1edff7944bd120a1e139159c9d99a1f517
  source_path: cli/devices.md
  workflow: 15
---

# `EasyHub devices`

管理设备配对请求和设备范围的 token。

## 命令

### `EasyHub devices list`

列出待处理的配对请求和已配对的设备。

```
EasyHub devices list
EasyHub devices list --json
```

### `EasyHub devices approve <requestId>`

批准待处理的设备配对请求。

```
EasyHub devices approve <requestId>
```

### `EasyHub devices reject <requestId>`

拒绝待处理的设备配对请求。

```
EasyHub devices reject <requestId>
```

### `EasyHub devices rotate --device <id> --role <role> [--scope <scope...>]`

为特定角色轮换设备 token（可选更新 scope）。

```
EasyHub devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `EasyHub devices revoke --device <id> --role <role>`

为特定角色撤销设备 token。

```
EasyHub devices revoke --device <deviceId> --role node
```

## 通用选项

- `--url <url>`：Gateway 网关 WebSocket URL（配置后默认使用 `gateway.remote.url`）。
- `--token <token>`：Gateway 网关 token（如需要）。
- `--password <password>`：Gateway 网关密码（密码认证）。
- `--timeout <ms>`：RPC 超时。
- `--json`：JSON 输出（推荐用于脚本）。

## 注意事项

- Token 轮换会返回新 token（敏感信息）。请像对待密钥一样对待它。
- 这些命令需要 `operator.pairing`（或 `operator.admin`）scope。
