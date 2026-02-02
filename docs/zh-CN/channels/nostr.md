---
read_when:
  - 你想让 OpenClaw 通过 Nostr 接收私信
  - 你正在设置去中心化消息
summary: 通过 NIP-04 加密消息的 Nostr 私信渠道
title: Nostr
x-i18n:
  generated_at: "2026-02-01T19:26:55Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 6b9fe4c74bf5e7c0f59bbaa129ec5270fd29a248551a8a9a7dde6cff8fb46111
  source_path: channels/nostr.md
  workflow: 14
---

# Nostr

**状态：** 可选插件（默认禁用）。

Nostr 是一个去中心化的社交网络协议。此渠道使 OpenClaw 能够通过 NIP-04 接收和回复加密私信（私信）。

## 安装（按需）

### 新手引导（推荐）

- 新手引导向导（`openclaw onboard`）和 `openclaw channels add` 会列出可选的渠道插件。
- 选择 Nostr 时会提示你按需安装插件。

安装默认行为：

- **开发渠道 + 可用 git 检出：** 使用本地插件路径。
- **稳定版/测试版：** 从 npm 下载。

你始终可以在提示中覆盖此选择。

### 手动安装

```bash
openclaw plugins install @openclaw/nostr
```

使用本地检出（开发工作流）：

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

安装或启用插件后请重启 Gateway网关。

## 快速设置

1. 生成 Nostr 密钥对（如需要）：

```bash
# 使用 nak
nak key generate
```

2. 添加到配置：

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

4. 重启 Gateway网关。

## 配置参考

| 键           | 类型     | 默认值                                      | 描述                        |
| ------------ | -------- | ------------------------------------------- | --------------------------- |
| `privateKey` | string   | 必填                                        | `nsec` 或十六进制格式的私钥 |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | 中继 URL（WebSocket）       |
| `dmPolicy`   | string   | `pairing`                                   | 私信访问策略                |
| `allowFrom`  | string[] | `[]`                                        | 允许的发送者公钥            |
| `enabled`    | boolean  | `true`                                      | 启用/禁用渠道               |
| `name`       | string   | -                                           | 显示名称                    |
| `profile`    | object   | -                                           | NIP-01 个人资料元数据       |

## 个人资料元数据

个人资料数据作为 NIP-01 `kind:0` 事件发布。你可以从控制 UI（Channels -> Nostr -> Profile）管理它，或直接在配置中设置。

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

注意事项：

- 个人资料 URL 必须使用 `https://`。
- 从中继导入会合并字段并保留本地覆盖。

## 访问控制

### 私信策略

- **pairing**（默认）：未知发送者会收到配对码。
- **allowlist**：只有 `allowFrom` 中的公钥可以发私信。
- **open**：公开入站私信（需要 `allowFrom: ["*"]`）。
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

建议：

- 使用 2-3 个中继以实现冗余。
- 避免使用过多中继（延迟、重复）。
- 付费中继可以提高可靠性。
- 本地中继适用于测试（`ws://localhost:7777`）。

## 协议支持

| NIP    | 状态   | 描述                          |
| ------ | ------ | ----------------------------- |
| NIP-01 | 支持   | 基本事件格式 + 个人资料元数据 |
| NIP-04 | 支持   | 加密私信（`kind:4`）          |
| NIP-17 | 计划中 | Gift-wrapped 私信             |
| NIP-44 | 计划中 | 版本化加密                    |

## 测试

### 本地中继

```bash
# 启动 strfry
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
3. 私信机器人公钥。
4. 验证回复。

## 故障排除

### 无法收到消息

- 验证私钥是否有效。
- 确保中继 URL 可达并使用 `wss://`（本地使用 `ws://`）。
- 确认 `enabled` 未设为 `false`。
- 检查 Gateway网关日志中的中继连接错误。

### 无法发送回复

- 检查中继是否接受写入。
- 验证出站连接。
- 注意中继速率限制。

### 重复回复

- 使用多个中继时属于预期行为。
- 消息按事件 ID 去重；只有第一次投递会触发回复。

## 安全

- 绝不提交私钥。
- 使用环境变量存储密钥。
- 生产机器人请考虑使用 `allowlist`。

## 限制（MVP）

- 仅支持私信（无群聊）。
- 不支持媒体附件。
- 仅支持 NIP-04（计划支持 NIP-17 gift-wrap）。
