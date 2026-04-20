---
summary: "通过 NIP-04 加密消息的 Nostr DM 频道"
read_when:
  - 您希望 OpenClaw 通过 Nostr 接收 DM
  - 您正在设置去中心化消息传递
title: "Nostr"
---

# Nostr

**状态：** 可选捆绑插件（默认禁用，需配置后启用）。

Nostr 是一种用于社交网络的去中心化协议。此频道使 OpenClaw 能够通过 NIP-04 接收和响应加密直接消息（DM）。

## 捆绑插件

当前的 OpenClaw 版本将 Nostr 作为捆绑插件提供，因此正常的打包构建不需要单独安装。

### 较旧/自定义安装

- 引导设置（`openclaw onboard`）和 `openclaw channels add` 仍然会从共享频道目录中显示 Nostr。
- 如果您的构建排除了捆绑的 Nostr，请手动安装。

```bash
openclaw plugins install @openclaw/nostr
```

使用本地检出（开发工作流）：

```bash
openclaw plugins install --link <path-to-local-nostr-plugin>
```

安装或启用插件后重启网关。

### 非交互式设置

```bash
openclaw channels add --channel nostr --private-key "$NOSTR_PRIVATE_KEY"
openclaw channels add --channel nostr --private-key "$NOSTR_PRIVATE_KEY" --relay-urls "wss://relay.damus.io,wss://relay.primal.net"
```

使用 `--use-env` 来将 `NOSTR_PRIVATE_KEY` 保留在环境中，而不是将密钥存储在配置中。

## 快速设置

1. 生成 Nostr 密钥对（如果需要）：

```bash
# 使用 nak
nak key generate
```

2. 添加到配置：

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
    },
  },
}
```

3. 导出密钥：

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. 重启网关。

## 配置参考

| 键           | 类型     | 默认值                                      | 描述                        |
| ------------ | -------- | ------------------------------------------- | --------------------------- |
| `privateKey` | string   | required                                    | `nsec` 或十六进制格式的私钥 |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | 中继 URL（WebSocket）       |
| `dmPolicy`   | string   | `pairing`                                   | DM 访问策略                 |
| `allowFrom`  | string[] | `[]`                                        | 允许的发送者公钥            |
| `enabled`    | boolean  | `true`                                      | 启用/禁用频道               |
| `name`       | string   | -                                           | 显示名称                    |
| `profile`    | object   | -                                           | NIP-01 配置文件元数据       |

## 配置文件元数据

配置文件数据作为 NIP-01 `kind:0` 事件发布。您可以从控制 UI（频道 -> Nostr -> 配置文件）管理它，或直接在配置中设置它。

示例：

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
      profile: {
        name: "openclaw",
        displayName: "OpenClaw",
        about: "个人助理 DM 机器人",
        picture: "https://example.com/avatar.png",
        banner: "https://example.com/banner.png",
        website: "https://example.com",
        nip05: "openclaw@example.com",
        lud16: "openclaw@example.com",
      },
    },
  },
}
```

注意：

- 配置文件 URL 必须使用 `https://`。
- 从中继导入会合并字段并保留本地覆盖。

## 访问控制

### DM 策略

- **pairing**（默认）：未知发送者会获得一个配对码。
- **allowlist**：只有 `allowFrom` 中的公钥可以发送 DM。
- **open**：公开入站 DM（需要 `allowFrom: ["*"]`）。
- **disabled**：忽略入站 DM。

实施说明：

- 入站事件签名在发送者策略和 NIP-04 解密之前进行验证，因此伪造的事件会被早期拒绝。
- 配对回复在不处理原始 DM 正文的情况下发送。
- 入站 DM 受到速率限制，过大的有效负载在解密前会被丢弃。

### 允许列表示例

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
      dmPolicy: "allowlist",
      allowFrom: ["npub1abc...", "npub1xyz..."],
    },
  },
}
```

## 密钥格式

接受的格式：

- **私钥：** `nsec...` 或 64 字符十六进制
- **公钥（`allowFrom`）：** `npub...` 或十六进制

## 中继

默认值：`relay.damus.io` 和 `nos.lol`。

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
      relays: ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"],
    },
  },
}
```

提示：

- 使用 2-3 个中继以提高冗余性。
- 避免使用太多中继（延迟、重复）。
- 付费中继可以提高可靠性。
- 本地中继适合测试（`ws://localhost:7777`）。

## 协议支持

| NIP    | 状态 | 描述                          |
| ------ | ---- | ----------------------------- |
| NIP-01 | 支持 | 基本事件格式 + 配置文件元数据 |
| NIP-04 | 支持 | 加密 DM（`kind:4`）           |
| NIP-17 | 计划 | 礼品包装 DM                   |
| NIP-44 | 计划 | 版本化加密                    |

## 测试

### 本地中继

```bash
# 启动 strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json5
{
  channels: {
    nostr: {
      privateKey: "${NOSTR_PRIVATE_KEY}",
      relays: ["ws://localhost:7777"],
    },
  },
}
```

### 手动测试

1. 从日志中记下机器人公钥（npub）。
2. 打开 Nostr 客户端（Damus、Amethyst 等）。
3. 向机器人公钥发送 DM。
4. 验证响应。

## 故障排除

### 未接收消息

- 验证私钥是否有效。
- 确保中继 URL 可访问并使用 `wss://`（本地使用 `ws://`）。
- 确认 `enabled` 不是 `false`。
- 检查网关日志中的中继连接错误。

### 未发送响应

- 检查中继是否接受写入。
- 验证出站连接。
- 注意中继速率限制。

### 重复响应

- 使用多个中继时预期会发生。
- 消息按事件 ID 去重；只有第一次传递会触发响应。

## 安全

- 永远不要提交私钥。
- 使用环境变量存储密钥。
- 考虑为生产机器人使用 `allowlist`。
- 签名在发送者策略之前验证，发送者策略在解密之前强制执行，因此伪造的事件会被早期拒绝，未知发送者无法强制进行完整的加密工作。

## 限制（MVP）

- 仅支持直接消息（无群聊）。
- 无媒体附件。
- 仅支持 NIP-04（计划支持 NIP-17 礼品包装）。

## 相关

- [频道概述](/channels) — 所有支持的频道
- [配对](/channels/pairing) — DM 认证和配对流程
- [群组](/channels/groups) — 群聊行为和提及门控
- [频道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和强化
