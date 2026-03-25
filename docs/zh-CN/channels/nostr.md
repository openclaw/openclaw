---
read_when:
  - 你想让 OpenClaw 通过 Nostr 接收私信
  - 你正在设置去中心化消息传递
summary: 通过 NIP-04 加密消息实现的 Nostr 私信渠道
title: Nostr
x-i18n:
  generated_at: "2026-03-16T06:20:37Z"
  model: gpt-5.4
  provider: openai
  source_hash: fcce57da49256971420c4bb099aebb7944f8c7e8619b17b163da685add225001
  source_path: channels/nostr.md
  workflow: 15
---

# Nostr

**状态：** 可选插件（默认禁用）。

Nostr 是一种用于社交网络的去中心化协议。此渠道使 OpenClaw 能够通过 NIP-04 接收并回复加密私信。

## 安装（按需）

### 新手引导（推荐）

- 设置向导（`openclaw onboard`）和 `openclaw channels add` 会列出可选渠道插件。
- 选择 Nostr 时，系统会提示你按需安装该插件。

安装默认行为：

- **Dev 渠道 + 可用的 git 检出：** 使用本地插件路径。
- **稳定版 / Beta：** 从 npm 下载。

你始终可以在提示中覆盖该选择。

### 手动安装

```bash
openclaw plugins install @openclaw/nostr
```

使用本地检出（dev 工作流）：

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

安装或启用插件后，重启 Gateway 网关。

### 非交互式设置

```bash
openclaw channels add --channel nostr --private-key "$NOSTR_PRIVATE_KEY"
openclaw channels add --channel nostr --private-key "$NOSTR_PRIVATE_KEY" --relay-urls "wss://relay.damus.io,wss://relay.primal.net"
```

使用 `--use-env` 可将 `NOSTR_PRIVATE_KEY` 保留在环境中，而不是将密钥存储在配置里。

## 快速设置

1. 生成一个 Nostr 密钥对（如有需要）：

```bash
# Using nak
nak key generate
```

2. 添加到配置中：

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. 导出密钥：

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. 重启 Gateway 网关。

## 配置参考

| 键           | 类型     | 默认值                                      | 说明                        |
| ------------ | -------- | ------------------------------------------- | --------------------------- |
| `privateKey` | string   | 必填                                        | `nsec` 或十六进制格式的私钥 |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | 中继 URL（WebSocket）       |
| `dmPolicy`   | string   | `pairing`                                   | 私信访问策略                |
| `allowFrom`  | string[] | `[]`                                        | 允许的发送方公钥            |
| `enabled`    | boolean  | `true`                                      | 启用 / 禁用渠道             |
| `name`       | string   | -                                           | 显示名称                    |
| `profile`    | object   | -                                           | NIP-01 资料元数据           |

## 资料元数据

资料数据会作为 NIP-01 `kind:0` 事件发布。你可以在控制 UI 中管理它（Channels -> Nostr -> Profile），也可以直接在配置中设置。

示例：

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

注意：

- 资料 URL 必须使用 `https://`。
- 从中继导入时会合并字段，并保留本地覆盖项。

## 访问控制

### 私信策略

- **pairing**（默认）：未知发送方会收到一个配对码。
- **allowlist**：只有 `allowFrom` 中的公钥可以发送私信。
- **open**：公开接收入站私信（要求 `allowFrom: ["*"]`）。
- **disabled**：忽略入站私信。

### 允许列表示例

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## 密钥格式

接受的格式：

- **私钥：** `nsec...` 或 64 字符十六进制
- **公钥（`allowFrom`）：** `npub...` 或十六进制

## 中继

默认值：`relay.damus.io` 和 `nos.lol`。

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

提示：

- 使用 2 到 3 个中继以实现冗余。
- 避免使用过多中继（延迟、重复）。
- 付费中继可以提高可靠性。
- 本地中继也适合测试（`ws://localhost:7777`）。

## 协议支持

| NIP    | 状态   | 说明                      |
| ------ | ------ | ------------------------- |
| NIP-01 | 已支持 | 基础事件格式 + 资料元数据 |
| NIP-04 | 已支持 | 加密私信（`kind:4`）      |
| NIP-17 | 计划中 | Gift-wrapped 私信         |
| NIP-44 | 计划中 | 版本化加密                |

## 测试

### 本地中继

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### 手动测试

1. 从日志中记下机器人公钥（npub）。
2. 打开一个 Nostr 客户端（Damus、Amethyst 等）。
3. 向该机器人公钥发送私信。
4. 验证回复。

## 故障排除

### 未接收到消息

- 验证私钥有效。
- 确保中继 URL 可访问，并使用 `wss://`（本地则使用 `ws://`）。
- 确认 `enabled` 不是 `false`。
- 检查 Gateway 网关日志中的中继连接错误。

### 未发送回复

- 检查中继是否接受写入。
- 验证出站连接性。
- 注意中继速率限制。

### 重复回复

- 使用多个中继时这是预期行为。
- 消息会按事件 ID 去重；只有首次投递会触发回复。

## 安全性

- 切勿提交私钥。
- 对密钥使用环境变量。
- 对生产机器人考虑使用 `allowlist`。

## 限制（MVP）

- 仅支持私信（不支持群聊）。
- 不支持媒体附件。
- 仅支持 NIP-04（计划支持 NIP-17 gift-wrap）。
