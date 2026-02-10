---
summary: "企业微信 WeCom 插件支持状态、功能和配置"
read_when:
  - 您想要连接企业微信
  - 您正在配置 WeCom 渠道
title: 企业微信 WeCom
---

# 企业微信 WeCom

状态：生产就绪，支持 Bot 与 Agent 双模式。

---

## 需要插件

安装 WeCom 插件：

```bash
openclaw plugins install @openclaw/wecom
openclaw plugins enable wecom
```

本地 checkout（在 git 仓库内运行）：

```bash
openclaw plugins install ./extensions/wecom
openclaw plugins enable wecom
```

---

## 快速开始

添加 WeCom 渠道有两种方式：

### 方式一：通过安装向导添加（推荐）

```bash
openclaw channels add
```

### 方式二：通过命令行配置

```bash
openclaw config set channels.wecom.enabled true
```

---

## 企业微信接入指南

开始前，请先登录企业微信管理后台：

![企业微信管理后台登录](https://yosuai.oss-cn-beijing.aliyuncs.com/openclaw/register.png)

### Bot 模式（智能机器人）

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame#/manageTools)
2. 进入「安全与管理」->「管理工具」->「智能机器人」
3. 创建机器人并选择 API 模式
4. 配置回调 URL：`https://your-domain.com/wecom/bot`
5. 记录 `token` 与 `encodingAESKey`

![Bot 入口：管理工具中的智能机器人](https://yosuai.oss-cn-beijing.aliyuncs.com/openclaw/01.bot-add.png)

![Bot 配置：填写回调 URL、Token 和 EncodingAESKey](https://yosuai.oss-cn-beijing.aliyuncs.com/openclaw/01.bot-setp2.png)

### Agent 模式（自建应用，推荐同时开启）

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame#/apps)
2. 创建自建应用并获取 `corpId`、`corpSecret`、`agentId`
3. 配置接收消息回调 URL：`https://your-domain.com/wecom/agent`
4. 记录回调 `token` 与 `encodingAESKey`
5. 在「企业可信 IP」中加入网关出口 IP

![Agent 创建：新建自建应用](https://yosuai.oss-cn-beijing.aliyuncs.com/openclaw/02.agent.add.png)

![Agent 配置：进入设置 API 接收](https://yosuai.oss-cn-beijing.aliyuncs.com/openclaw/02.agent.api-set.png)

### 动态 IP 与代理出口

如果网关运行在动态 IP 或内网穿透环境，可能出现 `60020 not allow to access from your ip`。
可配置固定出口代理：

```bash
openclaw config set channels.wecom.network.egressProxyUrl "http://proxy.company.local:3128"
```

### 接入完成后验证

```bash
openclaw gateway restart
openclaw channels status
openclaw logs --follow
```

---

## 配置 OpenClaw

### Bot 最小配置

```json5
{
  channels: {
    wecom: {
      enabled: true,
      bot: {
        token: "YOUR_BOT_TOKEN",
        encodingAESKey: "YOUR_BOT_AES_KEY",
      },
    },
  },
}
```

### Bot + Agent 双模式配置（推荐）

```json5
{
  channels: {
    wecom: {
      enabled: true,
      bot: {
        token: "YOUR_BOT_TOKEN",
        encodingAESKey: "YOUR_BOT_AES_KEY",
        receiveId: "",
        streamPlaceholderContent: "正在思考...",
        welcomeText: "你好！我是 AI 助手",
        dm: { policy: "open", allowFrom: ["*"] },
      },
      agent: {
        corpId: "YOUR_CORP_ID",
        corpSecret: "YOUR_CORP_SECRET",
        agentId: 1000001,
        token: "YOUR_CALLBACK_TOKEN",
        encodingAESKey: "YOUR_CALLBACK_AES_KEY",
        welcomeText: "欢迎使用智能助手",
        dm: { policy: "open", allowFrom: ["*"] },
      },
      network: {
        egressProxyUrl: "http://proxy.company.local:3128",
      },
    },
  },
}
```

### DM 策略

- `pairing`：默认策略。WeCom 不支持 `openclaw pairing` CLI 审批流程，实际行为按 allowlist 处理命令门禁。
- `allowlist`：仅 `dm.allowFrom` 中的用户可使用受限命令。
- `open`：允许所有用户（等价于 `allowFrom=["*"]`）。
- `disabled`：禁用私聊命令。

---

## 渠道行为说明

### 回调路径

- Bot： `/wecom/bot`
- Agent：`/wecom/agent`

### Bot 优先，Agent 兜底

- 群内默认由 Bot 交付文本/图片/Markdown。
- 当输出包含非图片文件时，自动切换 Agent 私信兜底并给出群内提示。
- 长任务接近 6 分钟窗口时，自动提示并切到 Agent 私信继续交付。

### A2UI 交互卡片

- Agent 输出 `{"template_card": ...}` 时，单聊尝试发送真实交互卡片。
- 触发 `template_card_event` 时会回调并去重处理。
- 群聊或无 `response_url` 时降级为文本描述。

---

## Cron 与主动发送

### 推荐用法

通过 `openclaw cron` 调度定时通知：

```bash
openclaw cron add \
  --name "wecom-morning-brief" \
  --cron "0 9 * * 1-5" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "早安，今日简报如下" \
  --announce \
  --channel wecom \
  --to "party:1"
```

### 目标格式

- `user:zhangsan`：用户
- `party:1`：部门
- `tag:Ops`：标签
- `group:wrxxxx`：群聊 ID（注意主动发送的权限边界）

### 当前主动发送限制

WeCom Agent 主动发送链路默认拦截普通群 `chatid` 目标，建议优先使用用户/部门/标签，或让 Bot 在群内交付。

---

## 支持的消息类型

### 接收

- Bot：文本、图片、语音、文件、图文引用
- Agent：文本、图片、语音、视频、位置、链接（文件回调受官方限制）

### 发送

- Bot：文本、图片、Markdown（被动流式）
- Agent：文本、图片、语音、视频、文件（主动发送）

---

## 常用命令

| 命令     | 说明       |
| -------- | ---------- |
| `/new`   | 开启新会话 |
| `/reset` | 重置会话   |

---

## 高级配置

### 动态 Agent 路由

```json5
{
  channels: {
    wecom: {
      dynamicAgents: {
        enabled: true,
        dmCreateAgent: true,
        groupEnabled: true,
        adminUsers: ["zhangsan"],
      },
    },
  },
}
```

### 媒体大小上限

```bash
openclaw config set channels.wecom.media.maxBytes 52428800
```

---

## 故障排除

### 机器人收不到回调

1. 检查网关是否运行：`openclaw gateway status`
2. 检查回调 URL 是否可达且路径正确
3. 检查 Token 与 EncodingAESKey 是否一致
4. 查看实时日志：`openclaw logs --follow`

### 报错 60020

1. 检查企业可信 IP 是否包含网关出口 IP
2. 动态 IP 场景使用 `channels.wecom.network.egressProxyUrl`

### 群里触发后文件没有发出

1. 确认已配置 Agent 模式
2. 确认触发者存在 `userid`
3. 查看日志中的 fallback 与 media 错误信息

---

## 配置参考

| 配置项                                        | 说明                 | 默认值     |
| --------------------------------------------- | -------------------- | ---------- |
| `channels.wecom.enabled`                      | 启用/禁用 WeCom      | `true`     |
| `channels.wecom.bot.token`                    | Bot 回调 Token       | -          |
| `channels.wecom.bot.encodingAESKey`           | Bot 回调 AESKey      | -          |
| `channels.wecom.bot.receiveId`                | Bot 接收者 ID        | `""`       |
| `channels.wecom.bot.streamPlaceholderContent` | 流式占位文案         | -          |
| `channels.wecom.bot.welcomeText`              | Bot 欢迎语           | -          |
| `channels.wecom.bot.dm.policy`                | Bot DM 策略          | `pairing`  |
| `channels.wecom.bot.dm.allowFrom`             | Bot DM 白名单        | -          |
| `channels.wecom.agent.corpId`                 | 企业 ID              | -          |
| `channels.wecom.agent.corpSecret`             | 应用 Secret          | -          |
| `channels.wecom.agent.agentId`                | 应用 AgentId         | -          |
| `channels.wecom.agent.token`                  | Agent 回调 Token     | -          |
| `channels.wecom.agent.encodingAESKey`         | Agent 回调 AESKey    | -          |
| `channels.wecom.agent.welcomeText`            | Agent 欢迎语         | -          |
| `channels.wecom.agent.dm.policy`              | Agent DM 策略        | `pairing`  |
| `channels.wecom.agent.dm.allowFrom`           | Agent DM 白名单      | -          |
| `channels.wecom.network.egressProxyUrl`       | 出口代理 URL         | -          |
| `channels.wecom.media.maxBytes`               | 媒体下载上限（字节） | 实现默认值 |
| `channels.wecom.dynamicAgents.enabled`        | 启用动态 Agent       | `false`    |
| `channels.wecom.dynamicAgents.dmCreateAgent`  | 私聊自动分配 Agent   | `true`     |
| `channels.wecom.dynamicAgents.groupEnabled`   | 群聊自动分配 Agent   | `true`     |
| `channels.wecom.dynamicAgents.adminUsers`     | 管理员绕过列表       | `[]`       |
