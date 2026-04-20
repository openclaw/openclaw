---
summary: "通过 signal-cli（JSON-RPC + SSE）的 Signal 支持、设置路径和号码模型"
read_when:
  - 设置 Signal 支持
  - 调试 Signal 发送/接收
title: "Signal"
---

# Signal（signal-cli）

状态：外部 CLI 集成。网关通过 HTTP JSON-RPC + SSE 与 `signal-cli` 通信。

## 先决条件

- 在服务器上安装 OpenClaw（下面的 Linux 流程在 Ubuntu 24 上测试）。
- 网关运行的主机上可用 `signal-cli`。
- 可以接收一条验证短信的电话号码（用于 SMS 注册路径）。
- 注册期间访问 Signal 验证码（`signalcaptchas.org`）的浏览器。

## 快速设置（初学者）

1. 为机器人使用**单独的 Signal 号码**（推荐）。
2. 安装 `signal-cli`（如果使用 JVM 构建，需要 Java）。
3. 选择一个设置路径：
   - **路径 A（QR 链接）**：`signal-cli link -n "OpenClaw"` 并使用 Signal 扫描。
   - **路径 B（SMS 注册）**：使用验证码 + SMS 验证注册专用号码。
4. 配置 OpenClaw 并重启网关。
5. 发送第一条 DM 并批准配对（`openclaw pairing approve signal <CODE>`）。

最小配置：

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

字段参考：

| 字段       | 描述                                       |
| ----------- | ------------------------------------------------- |
| `account`   | 机器人电话号码，E.164 格式（`+15551234567`） |
| `cliPath`   | `signal-cli` 的路径（如果在 `PATH` 中则为 `signal-cli`）  |
| `dmPolicy`  | DM 访问策略（推荐 `pairing`）          |
| `allowFrom` | 允许 DM 的电话号码或 `uuid:<id>` 值 |

## 它是什么

- 通过 `signal-cli` 的 Signal 通道（不是嵌入式 libsignal）。
- 确定性路由：回复始终返回 Signal。
- DM 共享代理的主会话；群组是隔离的（`agent:<agentId>:signal:group:<groupId>`）。

## 配置写入

默认情况下，允许 Signal 写入由 `/config set|unset` 触发的配置更新（需要 `commands.config: true`）。

禁用：

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## 号码模型（重要）

- 网关连接到**Signal 设备**（`signal-cli` 账户）。
- 如果你在**个人 Signal 账户**上运行机器人，它会忽略你自己的消息（循环保护）。
- 对于"我给机器人发短信，它回复"，使用**单独的机器人号码**。

## 设置路径 A：链接现有 Signal 账户（QR）

1. 安装 `signal-cli`（JVM 或原生构建）。
2. 链接机器人账户：
   - `signal-cli link -n "OpenClaw"`，然后在 Signal 中扫描 QR。
3. 配置 Signal 并启动网关。

示例：

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

多账户支持：使用 `channels.signal.accounts` 与每个账户的配置和可选 `name`。请参阅 [`gateway/configuration`](/gateway/configuration-reference#multi-account-all-channels) 了解共享模式。

## 设置路径 B：注册专用机器人号码（SMS，Linux）

当你想要专用机器人号码而不是链接现有 Signal 应用账户时使用此方法。

1. 获取可以接收 SMS（或座机语音验证）的号码。
   - 使用专用机器人号码以避免账户/会话冲突。
2. 在网关主机上安装 `signal-cli`：

```bash
VERSION=$(curl -Ls -o /dev/null -w %{url_effective} https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')
curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-native.tar.gz"
sudo tar xf "signal-cli-${VERSION}-Linux-native.tar.gz" -C /opt
sudo ln -sf /opt/signal-cli /usr/local/bin/
signal-cli --version
```

如果你使用 JVM 构建（`signal-cli-${VERSION}.tar.gz`），请先安装 JRE 25+。
保持 `signal-cli` 更新；上游注意到旧版本可能会随着 Signal 服务器 API 的变化而中断。

3. 注册并验证号码：

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register
```

如果需要验证码：

1. 打开 `https://signalcaptchas.org/registration/generate.html`。
2. 完成验证码，从"Open Signal"复制 `signalcaptcha://...` 链接目标。
3. 尽可能从与浏览器会话相同的外部 IP 运行。
4. 立即重新运行注册（验证码令牌很快过期）：

```bash
signal-cli -a +<BOT_PHONE_NUMBER> register --captcha '<SIGNALCAPTCHA_URL>'
signal-cli -a +<BOT_PHONE_NUMBER> verify <VERIFICATION_CODE>
```

4. 配置 OpenClaw，重启网关，验证通道：

```bash
# 如果你作为用户 systemd 服务运行网关：
systemctl --user restart openclaw-gateway.service

# 然后验证：
openclaw doctor
openclaw channels status --probe
```

5. 配对你的 DM 发送者：
   - 向机器人号码发送任何消息。
   - 在服务器上批准代码：`openclaw pairing approve signal <PAIRING_CODE>`。
   - 在手机上将机器人号码保存为联系人，以避免"未知联系人"。

重要：使用 `signal-cli` 注册电话号码账户可能会使该号码的主要 Signal 应用会话失效。首选专用机器人号码，或如果你需要保留现有的手机应用设置，则使用 QR 链接模式。

上游参考：

- `signal-cli` README：`https://github.com/AsamK/signal-cli`
- 验证码流程：`https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha`
- 链接流程：`https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning)`

## 外部守护进程模式（httpUrl）

如果你想自己管理 `signal-cli`（慢速 JVM 冷启动、容器初始化或共享 CPU），请单独运行守护进程并将 OpenClaw 指向它：

```json5
{
  channels: {
    signal: {
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
    },
  },
}
```

这会跳过 OpenClaw 内的自动生成和启动等待。对于自动生成时的慢速启动，设置 `channels.signal.startupTimeoutMs`。

## 访问控制（DM + 群组）

DM：

- 默认：`channels.signal.dmPolicy = "pairing"`。
- 未知发送者会收到配对代码；消息在批准前被忽略（代码 1 小时后过期）。
- 通过以下方式批准：
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- 配对是 Signal DM 的默认令牌交换。详情：[配对](/channels/pairing)
- 仅 UUID 发送者（来自 `sourceUuid`）在 `channels.signal.allowFrom` 中存储为 `uuid:<id>`。

群组：

- `channels.signal.groupPolicy = open | allowlist | disabled`。
- `channels.signal.groupAllowFrom` 控制设置 `allowlist` 时谁可以在群组中触发。
- `channels.signal.groups["<group-id>" | "*"]` 可以用 `requireMention`、`tools` 和 `toolsBySender` 覆盖群组行为。
- 在多账户设置中，使用 `channels.signal.accounts.<id>.groups` 进行每个账户的覆盖。
- 运行时注意：如果 `channels.signal` 完全缺失，运行时会回退到 `groupPolicy="allowlist"` 进行群组检查（即使设置了 `channels.defaults.groupPolicy`）。

## 工作原理（行为）

- `signal-cli` 作为守护进程运行；网关通过 SSE 读取事件。
- 入站消息被标准化为共享通道信封。
- 回复始终路由回同一个号码或群组。

## 媒体 + 限制

- 出站文本被分块到 `channels.signal.textChunkLimit`（默认 4000）。
- 可选的换行分块：设置 `channels.signal.chunkMode="newline"` 以在长度分块之前按空行（段落边界）分割。
- 支持附件（从 `signal-cli` 获取的 base64）。
- 默认媒体上限：`channels.signal.mediaMaxMb`（默认 8）。
- 使用 `channels.signal.ignoreAttachments` 跳过下载媒体。
- 群组历史上下文使用 `channels.signal.historyLimit`（或 `channels.signal.accounts.*.historyLimit`），回退到 `messages.groupChat.historyLimit`。设置 `0` 以禁用（默认 50）。

## 输入 + 已读回执

- **输入指示器**：OpenClaw 通过 `signal-cli sendTyping` 发送输入信号，并在回复运行时刷新它们。
- **已读回执**：当 `channels.signal.sendReadReceipts` 为 true 时，OpenClaw 转发允许的 DM 的已读回执。
- Signal-cli 不暴露群组的已读回执。

## 反应（消息工具）

- 使用 `message action=react` 和 `channel=signal`。
- 目标：发送者 E.164 或 UUID（使用配对输出中的 `uuid:<id>`；裸 UUID 也可以）。
- `messageId` 是你要反应的消息的 Signal 时间戳。
- 群组反应需要 `targetAuthor` 或 `targetAuthorUuid`。

示例：

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

配置：

- `channels.signal.actions.reactions`：启用/禁用反应操作（默认 true）。
- `channels.signal.reactionLevel`：`off | ack | minimal | extensive`。
  - `off`/`ack` 禁用代理反应（消息工具 `react` 将出错）。
  - `minimal`/`extensive` 启用代理反应并设置指导级别。
- 每个账户覆盖：`channels.signal.accounts.<id>.actions.reactions`、`channels.signal.accounts.<id>.reactionLevel`。

## 交付目标（CLI/cron）

- DM：`signal:+15551234567`（或纯 E.164）。
- UUID DM：`uuid:<id>`（或裸 UUID）。
- 群组：`signal:group:<groupId>`。
- 用户名：`username:<name>`（如果你的 Signal 账户支持）。

## 故障排除

首先运行此阶梯：

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

然后根据需要确认 DM 配对状态：

```bash
openclaw pairing list signal
```

常见故障：

- 守护进程可访问但无回复：验证账户/守护进程设置（`httpUrl`、`account`）和接收模式。
- DM 被忽略：发送者等待配对批准。
- 群组消息被忽略：群组发送者/提及门控阻止传递。
- 编辑后的配置验证错误：运行 `openclaw doctor --fix`。
- 诊断中缺少 Signal：确认 `channels.signal.enabled: true`。

额外检查：

```bash
openclaw pairing list signal
pgrep -af signal-cli
grep -i "signal" "/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log" | tail -20
```

如需分类流程：[/channels/troubleshooting](/channels/troubleshooting)。

## 安全注意事项

- `signal-cli` 在本地存储账户密钥（通常 `~/.local/share/signal-cli/data/`）。
- 在服务器迁移或重建之前备份 Signal 账户状态。
- 保持 `channels.signal.dmPolicy: "pairing"`，除非你明确想要更广泛的 DM 访问。
- SMS 验证仅在注册或恢复流程中需要，但失去对号码/账户的控制可能会使重新注册变得复杂。

## 配置参考（Signal）

完整配置：[配置](/gateway/configuration)

提供者选项：

- `channels.signal.enabled`：启用/禁用通道启动。
- `channels.signal.account`：机器人账户的 E.164。
- `channels.signal.cliPath`：`signal-cli` 的路径。
- `channels.signal.httpUrl`：完整的守护进程 URL（覆盖主机/端口）。
- `channels.signal.httpHost`、`channels.signal.httpPort`：守护进程绑定（默认 127.0.0.1:8080）。
- `channels.signal.autoStart`：自动生成守护进程（如果 `httpUrl` 未设置，默认 true）。
- `channels.signal.startupTimeoutMs`：启动等待超时（毫秒，上限 120000）。
- `channels.signal.receiveMode`：`on-start | manual`。
- `channels.signal.ignoreAttachments`：跳过附件下载。
- `channels.signal.ignoreStories`：忽略来自守护进程的故事。
- `channels.signal.sendReadReceipts`：转发已读回执。
- `channels.signal.dmPolicy`：`pairing | allowlist | open | disabled`（默认：pairing）。
- `channels.signal.allowFrom`：DM 允许列表（E.164 或 `uuid:<id>`）。`open` 需要 `"*"`。Signal 没有用户名；使用电话/UUID ID。
- `channels.signal.groupPolicy`：`open | allowlist | disabled`（默认：allowlist）。
- `channels.signal.groupAllowFrom`：群组发送者允许列表。
- `channels.signal.groups`：按 Signal 群组 ID（或 `"*"`）键控的每个群组覆盖。支持的字段：`requireMention`、`tools`、`toolsBySender`。
- `channels.signal.accounts.<id>.groups`：多账户设置中 `channels.signal.groups` 的每个账户版本。
- `channels.signal.historyLimit`：作为上下文包含的最大群组消息数（0 禁用）。
- `channels.signal.dmHistoryLimit`：用户轮次中的 DM 历史限制。每个用户覆盖：`channels.signal.dms["<phone_or_uuid>"].historyLimit`。
- `channels.signal.textChunkLimit`：出站分块大小（字符）。
- `channels.signal.chunkMode`：`length`（默认）或 `newline` 以在长度分块之前按空行（段落边界）分割。
- `channels.signal.mediaMaxMb`：入站/出站媒体上限（MB）。

相关全局选项：

- `agents.list[].groupChat.mentionPatterns`（Signal 不支持原生提及）。
- `messages.groupChat.mentionPatterns`（全局回退）。
- `messages.responsePrefix`。

## 相关

- [通道概述](/channels) — 所有支持的通道
- [配对](/channels/pairing) — DM 认证和配对流程
- [群组](/channels/groups) — 群组聊天行为和提及门控
- [通道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和强化