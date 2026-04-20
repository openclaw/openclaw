---
summary: "`openclaw devices`的CLI参考（设备配对 + 令牌轮换/撤销）"
read_when:
  - 您正在批准设备配对请求
  - 您需要轮换或撤销设备令牌
title: "devices"
---

# `openclaw devices`

管理设备配对请求和设备范围的令牌。

## 命令

### `openclaw devices list`

列出待处理的配对请求和已配对的设备。

```
openclaw devices list
openclaw devices list --json
```

待处理请求输出包括请求的角色和范围，以便在批准前审查。

### `openclaw devices remove <deviceId>`

移除一个已配对的设备条目。

当您使用配对设备令牌进行身份验证时，非管理员调用者只能移除**自己的**设备条目。移除其他设备需要`operator.admin`权限。

```
openclaw devices remove <deviceId>
openclaw devices remove <deviceId> --json
```

### `openclaw devices clear --yes [--pending]`

批量清除已配对的设备。

```
openclaw devices clear --yes
openclaw devices clear --yes --pending
openclaw devices clear --yes --pending --json
```

### `openclaw devices approve [requestId] [--latest]`

通过精确的`requestId`批准待处理的设备配对请求。如果省略`requestId`或传递`--latest`，OpenClaw只会打印选定的待处理请求并退出；在验证详细信息后，使用精确的请求ID重新运行批准。

注意：如果设备使用更改的认证详细信息（角色/范围/公钥）重试配对，OpenClaw会取代先前的待处理条目并发出新的`requestId`。在批准前运行`openclaw devices list`以使用当前ID。

```
openclaw devices approve
openclaw devices approve <requestId>
openclaw devices approve --latest
```

### `openclaw devices reject <requestId>`

拒绝待处理的设备配对请求。

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

为特定角色轮换设备令牌（可选更新范围）。目标角色必须已存在于该设备的批准配对合同中；轮换不能创建新的未批准角色。如果您省略`--scope`，稍后使用存储的轮换令牌重新连接时会重用该令牌的缓存批准范围。如果您传递显式的`--scope`值，这些将成为未来缓存令牌重新连接的存储范围集。非管理员配对设备调用者只能轮换**自己的**设备令牌。此外，任何显式的`--scope`值必须在调用者会话自己的操作员范围内；轮换不能创建比调用者已有的更广泛的操作员令牌。

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

以JSON形式返回新的令牌负载。

### `openclaw devices revoke --device <id> --role <role>`

撤销特定角色的设备令牌。

非管理员配对设备调用者只能撤销**自己的**设备令牌。撤销其他设备的令牌需要`operator.admin`权限。

```
openclaw devices revoke --device <deviceId> --role node
```

以JSON形式返回撤销结果。

## 常用选项

- `--url <url>`: Gateway WebSocket URL（配置时默认为`gateway.remote.url`）。
- `--token <token>`: Gateway令牌（如果需要）。
- `--password <password>`: Gateway密码（密码认证）。
- `--timeout <ms>`: RPC超时。
- `--json`: JSON输出（推荐用于脚本）。

注意：当您设置`--url`时，CLI不会回退到配置或环境凭据。请显式传递`--token`或`--password`。缺少显式凭据是错误的。

## 注意事项

- 令牌轮换返回新令牌（敏感）。将其视为秘密。
- 这些命令需要`operator.pairing`（或`operator.admin`）范围。
- 令牌轮换保持在该设备的批准配对角色集和批准范围基线内。一个杂乱的缓存令牌条目不会授予新的轮换目标。
- 对于配对设备令牌会话，跨设备管理仅限管理员：`remove`、`rotate`和`revoke`仅对自己有效，除非调用者具有`operator.admin`权限。
- `devices clear`有意由`--yes`控制。
- 如果本地环回上的配对范围不可用（且未传递显式`--url`），list/approve可以使用本地配对回退。
- `devices approve`在创建令牌前需要明确的请求ID；省略`requestId`或传递`--latest`仅预览最新的待处理请求。

## 令牌漂移恢复清单

当控制UI或其他客户端持续因`AUTH_TOKEN_MISMATCH`或`AUTH_DEVICE_TOKEN_MISMATCH`失败时使用。

1. 确认当前gateway令牌源：

```bash
openclaw config get gateway.auth.token
```

2. 列出配对设备并识别受影响的设备ID：

```bash
openclaw devices list
```

3. 为受影响的设备轮换操作员令牌：

```bash
openclaw devices rotate --device <deviceId> --role operator
```

4. 如果轮换不够，移除陈旧的配对并重新批准：

```bash
openclaw devices remove <deviceId>
openclaw devices list
openclaw devices approve <requestId>
```

5. 使用当前共享令牌/密码重试客户端连接。

注意事项：

- 正常的重新连接认证优先级是：显式共享令牌/密码首先，然后是显式`deviceToken`，然后是存储的设备令牌，然后是引导令牌。
- 受信任的`AUTH_TOKEN_MISMATCH`恢复可以暂时同时发送共享令牌和存储的设备令牌，用于一次有限的重试。

相关：

- [Dashboard auth troubleshooting](/web/dashboard#if-you-see-unauthorized-1008)
- [Gateway troubleshooting](/gateway/troubleshooting#dashboard-control-ui-connectivity)