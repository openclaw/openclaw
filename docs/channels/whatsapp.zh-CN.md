---
summary: "WhatsApp 通道支持、访问控制、传递行为和操作"
read_when:
  - 处理 WhatsApp/web 通道行为或收件箱路由
title: "WhatsApp"
---

# WhatsApp（Web 通道）

状态：通过 WhatsApp Web（Baileys）生产就绪。网关拥有链接的会话。

## 安装（按需）

- 首次选择 WhatsApp 时，引导流程（`openclaw onboard`）和 `openclaw channels add --channel whatsapp` 会提示安装 WhatsApp 插件。
- 当插件尚未存在时，`openclaw channels login --channel whatsapp` 也会提供安装流程。
- 开发通道 + git 检出：默认为本地插件路径。
- 稳定版/Beta：默认为 npm 包 `@openclaw/whatsapp`。

手动安装仍然可用：

```bash
openclaw plugins install @openclaw/whatsapp
```

<CardGroup cols={3}>
  <Card title="配对" icon="link" href="/channels/pairing">
    对于未知发送者，默认 DM 策略是配对。
  </Card>
  <Card title="通道故障排除" icon="wrench" href="/channels/troubleshooting">
    跨通道诊断和修复手册。
  </Card>
  <Card title="网关配置" icon="settings" href="/gateway/configuration">
    完整的通道配置模式和示例。
  </Card>
</CardGroup>

## 快速设置

<Steps>
  <Step title="配置 WhatsApp 访问策略">

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      allowFrom: ["+15551234567"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

  </Step>

  <Step title="链接 WhatsApp（QR）">

```bash
openclaw channels login --channel whatsapp
```

    对于特定账户：

```bash
openclaw channels login --channel whatsapp --account work
```

  </Step>

  <Step title="启动网关">

```bash
openclaw gateway
```

  </Step>

  <Step title="批准第一个配对请求（如果使用配对模式）">

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

    配对请求在 1 小时后过期。待处理请求上限为每个通道 3 个。

  </Step>
</Steps>

<Note>
OpenClaw 建议在可能的情况下在单独的号码上运行 WhatsApp。（通道元数据和设置流程针对该设置进行了优化，但也支持个人号码设置。）
</Note>

## 部署模式

<AccordionGroup>
  <Accordion title="专用号码（推荐）">
    这是最干净的操作模式：

    - OpenClaw 的独立 WhatsApp 身份
    - 更清晰的 DM 允许列表和路由边界
    - 自聊混淆的可能性更低

    最小策略模式：

    ```json5
    {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15551234567"],
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="个人号码回退">
    引导支持个人号码模式，并写入对自聊友好的基线：

    - `dmPolicy: "allowlist"`
    - `allowFrom` 包含你的个人号码
    - `selfChatMode: true`

    在运行时，自聊保护基于链接的自身号码和 `allowFrom`。

  </Accordion>

  <Accordion title="仅 WhatsApp Web 通道范围">
    在当前的 OpenClaw 通道架构中，消息平台通道基于 WhatsApp Web（`Baileys`）。

    内置聊天通道注册表中没有单独的 Twilio WhatsApp 消息通道。

  </Accordion>
</AccordionGroup>

## 运行时模型

- 网关拥有 WhatsApp 套接字和重连循环。
- 出站发送需要目标账户有活跃的 WhatsApp 监听器。
- 忽略状态和广播聊天（`@status`、`@broadcast`）。
- 直接聊天使用 DM 会话规则（`session.dmScope`；默认 `main` 将 DM 折叠到代理主会话）。
- 群组会话是隔离的（`agent:<agentId>:whatsapp:group:<jid>`）。
- WhatsApp Web 传输尊重网关主机上的标准代理环境变量（`HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` / 小写变体）。优先选择主机级代理配置，而不是通道特定的 WhatsApp 代理设置。

## 访问控制和激活

<Tabs>
  <Tab title="DM 策略">
    `channels.whatsapp.dmPolicy` 控制直接聊天访问：

    - `pairing`（默认）
    - `allowlist`
    - `open`（要求 `allowFrom` 包含 `"*"`）
    - `disabled`

    `allowFrom` 接受 E.164 格式的号码（在内部标准化）。

    多账户覆盖：`channels.whatsapp.accounts.<id>.dmPolicy`（和 `allowFrom`）优先于该账户的通道级默认值。

    运行时行为详情：

    - 配对被持久化在通道允许存储中，并与配置的 `allowFrom` 合并
    - 如果未配置允许列表，默认允许链接的自身号码
    - 出站 `fromMe` DM 永远不会自动配对

  </Tab>

  <Tab title="群组策略 + 允许列表">
    群组访问有两层：

    1. **群组成员允许列表**（`channels.whatsapp.groups`）
       - 如果省略 `groups`，所有群组都有资格
       - 如果存在 `groups`，它充当群组允许列表（允许 `"*"`）

    2. **群组发送者策略**（`channels.whatsapp.groupPolicy` + `groupAllowFrom`）
       - `open`：绕过发送者允许列表
       - `allowlist`：发送者必须匹配 `groupAllowFrom`（或 `*`）
       - `disabled`：阻止所有群组入站

    发送者允许列表回退：

    - 如果未设置 `groupAllowFrom`，运行时在可用时回退到 `allowFrom`
    - 发送者允许列表在提及/回复激活之前评估

    注意：如果根本不存在 `channels.whatsapp` 块，运行时群组策略回退为 `allowlist`（带有警告日志），即使设置了 `channels.defaults.groupPolicy`。

  </Tab>

  <Tab title="提及 + /activation">
    默认情况下，群组回复需要提及。

    提及检测包括：

    - 明确的 WhatsApp 提及机器人身份
    - 配置的提及正则表达式模式（`agents.list[].groupChat.mentionPatterns`，回退 `messages.groupChat.mentionPatterns`）
    - 隐式回复机器人检测（回复发送者匹配机器人身份）

    安全注意：

    - 引用/回复仅满足提及门控；它**不**授予发送者授权
    - 使用 `groupPolicy: "allowlist"`，即使非允许列表发送者回复允许列表用户的消息，仍然会被阻止

    会话级激活命令：

    - `/activation mention`
    - `/activation always`

    `activation` 更新会话状态（不是全局配置）。它由所有者门控。

  </Tab>
</Tabs>

## 个人号码和自聊行为

当链接的自身号码也出现在 `allowFrom` 中时，WhatsApp 自聊保护会激活：

- 跳过自聊轮次的已读回执
- 忽略会导致你自己 ping 自己的提及-JID 自动触发行为
- 如果未设置 `messages.responsePrefix`，自聊回复默认为 `[{identity.name}]` 或 `[openclaw]`

## 消息标准化和上下文

<AccordionGroup>
  <Accordion title="入站信封 + 回复上下文">
    传入的 WhatsApp 消息被包装在共享的入站信封中。

    如果存在引用回复，上下文会以以下形式附加：

    ```text
    [Replying to <sender> id:<stanzaId>]
    <quoted body or media placeholder>
    [/Replying]
    ```

    当可用时，也会填充回复元数据字段（`ReplyToId`、`ReplyToBody`、`ReplyToSender`、发送者 JID/E.164）。

  </Accordion>

  <Accordion title="媒体占位符和位置/联系人提取">
    仅媒体的入站消息使用如下占位符标准化：

    - `<media:image>`
    - `<media:video>`
    - `<media:audio>`
    - `<media:document>`
    - `<media:sticker>`

    位置和联系人有效负载在路由之前被标准化为文本上下文。

  </Accordion>

  <Accordion title="待处理群组历史注入">
    对于群组，未处理的消息可以被缓冲并在机器人最终被触发时作为上下文注入。

    - 默认限制：`50`
    - 配置：`channels.whatsapp.historyLimit`
    - 回退：`messages.groupChat.historyLimit`
    - `0` 禁用

    注入标记：

    - `[Chat messages since your last reply - for context]`
    - `[Current message - respond to this]`

  </Accordion>

  <Accordion title="已读回执">
    默认情况下，对于接受的入站 WhatsApp 消息，已读回执是启用的。

    全局禁用：

    ```json5
    {
      channels: {
        whatsapp: {
          sendReadReceipts: false,
        },
      },
    }
    ```

    每个账户覆盖：

    ```json5
    {
      channels: {
        whatsapp: {
          accounts: {
            work: {
              sendReadReceipts: false,
            },
          },
        },
      },
    }
    ```

    即使全局启用，自聊轮次也会跳过已读回执。

  </Accordion>
</AccordionGroup>

## 传递、分块和媒体

<AccordionGroup>
  <Accordion title="文本分块">
    - 默认分块限制：`channels.whatsapp.textChunkLimit = 4000`
    - `channels.whatsapp.chunkMode = "length" | "newline"`
    - `newline` 模式优先段落边界（空行），然后回退到长度安全分块
  </Accordion>

  <Accordion title="出站媒体行为">
    - 支持图像、视频、音频（PTT 语音笔记）和文档有效负载
    - `audio/ogg` 被重写为 `audio/ogg; codecs=opus` 以实现语音笔记兼容性
    - 通过视频发送时的 `gifPlayback: true` 支持动画 GIF 播放
    - 发送多媒体回复有效负载时，标题应用于第一个媒体项目
    - 媒体源可以是 HTTP(S)、`file://` 或本地路径
  </Accordion>

  <Accordion title="媒体大小限制和回退行为">
    - 入站媒体保存上限：`channels.whatsapp.mediaMaxMb`（默认 `50`）
    - 出站媒体发送上限：`channels.whatsapp.mediaMaxMb`（默认 `50`）
    - 每个账户覆盖使用 `channels.whatsapp.accounts.<accountId>.mediaMaxMb`
    - 图像会自动优化（调整大小/质量扫描）以适应限制
    - 在媒体发送失败时，第一个项目回退发送文本警告，而不是静默丢弃响应
  </Accordion>
</AccordionGroup>

## 反应级别

`channels.whatsapp.reactionLevel` 控制代理在 WhatsApp 上使用表情符号反应的广泛程度：

| 级别         | 确认反应 | 代理发起的反应 | 描述                                      |
| ------------- | ------------- | ------------------------- | ------------------------------------------------ |
| `"off"`       | 否            | 否                        | 完全没有反应                              |
| `"ack"`       | 是           | 否                        | 仅确认反应（预回复回执）           |
| `"minimal"`   | 是           | 是（保守）        | 确认 + 代理反应，带有保守指导 |
| `"extensive"` | 是           | 是（鼓励）          | 确认 + 代理反应，带有鼓励指导   |

默认：`"minimal"`。

每个账户覆盖使用 `channels.whatsapp.accounts.<id>.reactionLevel`。

```json5
{
  channels: {
    whatsapp: {
      reactionLevel: "ack",
    },
  },
}
```

## 确认反应

WhatsApp 通过 `channels.whatsapp.ackReaction` 支持入站接收时的即时确认反应。确认反应由 `reactionLevel` 门控 — 当 `reactionLevel` 为 `"off"` 时，它们会被抑制。

```json5
{
  channels: {
    whatsapp: {
      ackReaction: {
        emoji: "👀",
        direct: true,
        group: "mentions", // always | mentions | never
      },
    },
  },
}
```

行为说明：

- 在入站被接受后立即发送（预回复）
- 失败会被记录但不会阻止正常的回复传递
- 群组模式 `mentions` 在提及触发的轮次上反应；群组激活 `always` 作为对此检查的绕过
- WhatsApp 使用 `channels.whatsapp.ackReaction`（此处不使用旧版 `messages.ackReaction`）

## 多账户和凭据

<AccordionGroup>
  <Accordion title="账户选择和默认值">
    - 账户 ID 来自 `channels.whatsapp.accounts`
    - 默认账户选择：如果存在 `default`，否则为第一个配置的账户 ID（已排序）
    - 账户 ID 在内部标准化以进行查找
  </Accordion>

  <Accordion title="凭据路径和旧版兼容性">
    - 当前认证路径：`~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
    - 备份文件：`creds.json.bak`
    - `~/.openclaw/credentials/` 中的旧版默认认证仍然被识别/迁移用于默认账户流程
  </Accordion>

  <Accordion title="登出行为">
    `openclaw channels logout --channel whatsapp [--account <id>]` 清除该账户的 WhatsApp 认证状态。

    在旧版认证目录中，`oauth.json` 被保留，而 Baileys 认证文件被删除。

  </Accordion>
</AccordionGroup>

## 工具、操作和配置写入

- 代理工具支持包括 WhatsApp 反应操作（`react`）。
- 操作门控：
  - `channels.whatsapp.actions.reactions`
  - `channels.whatsapp.actions.polls`
- 通道发起的配置写入默认启用（通过 `channels.whatsapp.configWrites=false` 禁用）。

## 故障排除

<AccordionGroup>
  <Accordion title="未链接（需要 QR）">
    症状：通道状态报告未链接。

    修复：

    ```bash
    openclaw channels login --channel whatsapp
    openclaw channels status
    ```

  </Accordion>

  <Accordion title="已链接但断开连接/重连循环">
    症状：已链接账户，反复断开连接或尝试重连。

    修复：

    ```bash
    openclaw doctor
    openclaw logs --follow
    ```

    如果需要，使用 `channels login` 重新链接。

  </Accordion>

  <Accordion title="发送时无活跃监听器">
    当目标账户不存在活跃的网关监听器时，出站发送会快速失败。

    确保网关正在运行且账户已链接。

  </Accordion>

  <Accordion title="群组消息意外被忽略">
    按以下顺序检查：

    - `groupPolicy`
    - `groupAllowFrom` / `allowFrom`
    - `groups` 允许列表条目
    - 提及门控（`requireMention` + 提及模式）
    - `openclaw.json` 中的重复键（JSON5）：后面的条目覆盖前面的条目，因此每个范围保持单个 `groupPolicy`

  </Accordion>

  <Accordion title="Bun 运行时警告">
    WhatsApp 网关运行时应使用 Node。对于稳定的 WhatsApp/Telegram 网关操作，Bun 被标记为不兼容。
  </Accordion>
</AccordionGroup>

## 配置参考指针

主要参考：

- [配置参考 - WhatsApp](/gateway/configuration-reference#whatsapp)

高信号 WhatsApp 字段：

- 访问：`dmPolicy`、`allowFrom`、`groupPolicy`、`groupAllowFrom`、`groups`
- 传递：`textChunkLimit`、`chunkMode`、`mediaMaxMb`、`sendReadReceipts`、`ackReaction`、`reactionLevel`
- 多账户：`accounts.<id>.enabled`、`accounts.<id>.authDir`、账户级覆盖
- 操作：`configWrites`、`debounceMs`、`web.enabled`、`web.heartbeatSeconds`、`web.reconnect.*`
- 会话行为：`session.dmScope`、`historyLimit`、`dmHistoryLimit`、`dms.<id>.historyLimit`

## 相关

- [配对](/channels/pairing)
- [群组](/channels/groups)
- [安全](/gateway/security)
- [通道路由](/channels/channel-routing)
- [多代理路由](/concepts/multi-agent)
- [故障排除](/channels/troubleshooting)