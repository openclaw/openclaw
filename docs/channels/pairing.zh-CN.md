---
summary: "配对概述：批准谁可以给你发 DM + 哪些节点可以加入"
read_when:
  - 设置 DM 访问控制
  - 配对新的 iOS/Android 节点
  - 审查 OpenClaw 安全态势
title: "配对"
---

# 配对

“配对”是 OpenClaw 的明确**所有者批准**步骤。
它用于两个地方：

1. **DM 配对**（谁被允许与机器人交谈）
2. **节点配对**（哪些设备/节点被允许加入网关网络）

安全上下文：[安全](/gateway/security)

## 1) DM 配对（入站聊天访问）

当频道配置了 DM 策略 `pairing` 时，未知发送者会获得一个短代码，他们的消息在您批准之前**不会被处理**。

默认 DM 策略记录在：[安全](/gateway/security)

配对码：

- 8 个字符，大写，无歧义字符（`0O1I`）。
- **1 小时后过期**。机器人仅在创建新请求时发送配对消息（每个发送者大约每小时一次）。
- 待处理的 DM 配对请求默认限制为每个频道**3 个**；额外的请求会被忽略，直到一个过期或被批准。

### 批准发送者

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

支持的频道：`bluebubbles`、`discord`、`feishu`、`googlechat`、`imessage`、`irc`、`line`、`matrix`、`mattermost`、`msteams`、`nextcloud-talk`、`nostr`、`openclaw-weixin`、`signal`、`slack`、`synology-chat`、`telegram`、`twitch`、`whatsapp`、`zalo`、`zalouser`。

### 状态存储位置

存储在 `~/.openclaw/credentials/` 下：

- 待处理请求：`<channel>-pairing.json`
- 批准的允许列表存储：
  - 默认账户：`<channel>-allowFrom.json`
  - 非默认账户：`<channel>-<accountId>-allowFrom.json`

账户范围行为：

- 非默认账户仅读写其范围的允许列表文件。
- 默认账户使用频道范围的无范围允许列表文件。

将这些视为敏感信息（它们控制对您助手的访问）。

重要：此存储用于 DM 访问。群组授权是单独的。批准 DM 配对码不会自动允许该发送者在群组中运行群组命令或控制机器人。对于群组访问，请配置频道的显式群组允许列表（例如 `groupAllowFrom`、`groups` 或根据频道的每群组/每主题覆盖）。

## 2) 节点设备配对（iOS/Android/macOS/无头节点）

节点以 `role: node` 的**设备**身份连接到网关。网关创建必须批准的设备配对请求。

### 通过 Telegram 配对（iOS 推荐）

如果您使用 `device-pair` 插件，您可以完全从 Telegram 进行首次设备配对：

1. 在 Telegram 中，向您的机器人发送消息：`/pair`
2. 机器人回复两条消息：一条指令消息和一条单独的**设置代码**消息（在 Telegram 中易于复制/粘贴）。
3. 在您的手机上，打开 OpenClaw iOS 应用 → 设置 → 网关。
4. 粘贴设置代码并连接。
5. 返回 Telegram：`/pair pending`（查看请求 ID、角色和范围），然后批准。

设置代码是一个 base64 编码的 JSON 有效负载，包含：

- `url`：网关 WebSocket URL（`ws://...` 或 `wss://...`）
- `bootstrapToken`：用于初始配对握手的短期单设备引导令牌

该引导令牌携带内置的配对引导配置文件：

- 主交接的 `node` 令牌保持 `scopes: []`
- 任何交接的 `operator` 令牌保持绑定到引导允许列表：`operator.approvals`、`operator.read`、`operator.talk.secrets`、`operator.write`
- 引导范围检查是角色前缀的，不是一个扁平的范围池：operator 范围条目仅满足 operator 请求，非 operator 角色仍必须在其自己的角色前缀下请求范围

在设置代码有效时，将其视为密码。

### 批准节点设备

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

如果同一设备使用不同的认证详情（例如不同的角色/范围/公钥）重试，之前的待处理请求会被取代，并创建新的 `requestId`。

重要：已配对的设备不会静默获得更广泛的访问权限。如果它重新连接并请求更多范围或更广泛的角色，OpenClaw 会保持现有批准不变，并创建新的待处理升级请求。使用 `openclaw devices list` 在批准之前比较当前批准的访问与新请求的访问。

### 节点配对状态存储

存储在 `~/.openclaw/devices/` 下：

- `pending.json`（短期；待处理请求过期）
- `paired.json`（配对设备 + 令牌）

### 注意

- 旧版 `node.pair.*` API（CLI：`openclaw nodes pending|approve|reject|rename`）是一个单独的网关拥有的配对存储。WS 节点仍然需要设备配对。
- 配对记录是批准角色的持久真实来源。活动设备令牌保持绑定到该批准的角色集；批准角色之外的杂散令牌条目不会创建新的访问权限。

## 相关文档

- 安全模型 + 提示注入：[安全](/gateway/security)
- 安全更新（运行诊断）：[更新](/install/updating)
- 频道配置：
  - Telegram：[Telegram](/channels/telegram)
  - WhatsApp：[WhatsApp](/channels/whatsapp)
  - Signal：[Signal](/channels/signal)
  - BlueBubbles (iMessage)：[BlueBubbles](/channels/bluebubbles)
  - iMessage（旧版）：[iMessage](/channels/imessage)
  - Discord：[Discord](/channels/discord)
  - Slack：[Slack](/channels/slack)
