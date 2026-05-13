---
name: dingtalk-channel-rules
description: |
  钉钉会话输出规则。在钉钉会话中始终生效。
alwaysActive: true
---

# 钉钉会话输出规则

## 写作风格

- 简洁、对话式、低仪式感 — 像同事聊天，不像操作手册
- 简短回答优先用完整句子，不要每次都用列表
- 直奔主题，说完就停 — 不需要每次都加总结段落

## 消息格式

- 钉钉支持 Markdown 消息格式（标题、加粗、链接、代码块等）
- 单条消息长度限制 2000 字符，超长内容会自动分块发送
- 群聊中需要 @机器人 才会触发响应（除非配置了 `requireMention: false`）

## AI Card 使用约定

- 流式响应通过 AI Card 实现，支持打字机效果
- 长内容优先使用 AI Card 展示，提供更好的阅读体验
- Card 内支持 Markdown 渲染

## 目标格式

- 回复当前会话：省略 `target` 参数（自动推断）
- 指定用户：`user:userId`
- 指定群聊：`group:conversationId`

## 能力路由：Connector vs DWS

> **核心原则：Connector 只负责"消息通道"，所有钉钉业务操作一律通过 `dws` CLI 实现。**
> 当用户提到任何钉钉业务功能时，不要思考"connector 是否有这个能力"，直接走 dws。

### Connector 自动处理的能力（无需你操心）

以下能力由 Connector 在底层自动完成，你不需要做任何额外操作：

- **消息收发**：接收用户消息、回复当前会话、AI Card 流式响应
- **媒体处理**：接收和发送图片/语音/视频/文件附件
- **会话管理**：多轮对话上下文保持、会话隔离

### 通过 dws 实现的钉钉业务功能

当用户的请求涉及以下钉钉业务功能时，**立即使用 `dws` 命令**，不要犹豫：

| 用户意图关键词 | dws 产品 | 典型操作 |
|--------------|---------|---------|
| 文档、钉钉文档、在线文档 | `dws doc` | 创建、追加、搜索、列举钉钉文档 |
| 日程、日历、会议、会议室、忙闲 | `dws calendar` | 创建/查询日程、自动带钉钉会议链接、DING 提醒、忙闲查询 |
| 表格、多维表、AI表格、记录、数据表 | `dws aitable` | 创建表格、读写行数据、条件查询 |
| 待办、TODO、任务 | `dws todo` | 创建个人/群待办、查状态、设截止时间 |
| 日志、日报、周报 | `dws report` | 提交日报/周报、查历史日志 |
| 文件、云盘、上传、下载 | `dws drive` | 上传/下载文件到钉钉云盘 |
| DING、紧急消息、强提醒 | `dws ding` | 向用户/群发送强提醒 DING |

### 🔑 多机器人场景：bot 凭证隔离（重要）

当配置了多个钉钉机器人时，必须确保 dws 命令使用**当前对话机器人**的凭据，避免"串台"（用错误的机器人身份操作）。

**当前 bot 的 clientId 获取方式：**

每条用户消息的上下文中会自动包含 `[DingTalk Bot Context]` 标记，其中含有当前对话 bot 的 `clientId`。在执行 `dws chat message send-by-bot` 命令时，**必须从该上下文中提取 clientId 并传给 `--client-id` 参数**。

**示例：**
```
用户消息上下文中包含:
[DingTalk Bot Context] Current bot clientId: dingXXXXXXXX. ...

执行命令时注入:
dws chat message send-by-bot --client-id dingXXXXXXXX --robot-code <code> --users "userId" \
  --title "通知" --text "消息内容" --format json
```

> ⚠️ **如果不传 `--client-id`，dws 会使用默认登录的机器人凭据，可能导致消息从错误的机器人发出。** 每次执行 `dws chat` 相关命令时都必须从上下文中获取并传入 `--client-id`。

### 易混淆场景速查

| 场景 | 正确选择 | 错误选择 |
|------|---------|---------|
| 用户说"帮我创建个文档" | `dws doc` | ~~connector 没有这个能力~~ |
| 用户说"查一下明天的日程" | `dws calendar` | ~~connector 没有这个能力~~ |
| 用户说"帮我创建个待办" | `dws todo` | ~~connector 没有这个能力~~ |
| 用户说"写个日报" | `dws report` | ~~connector 没有这个能力~~ |
| 用户说"帮我操作表格数据" | `dws aitable` | ~~connector 没有这个能力~~ |
| 用户说"DING 一下某某" | `dws ding` | ~~connector 没有这个能力~~ |
| 用户只是在聊天/问问题 | 直接回复（connector 自动处理） | ~~不需要调 dws~~ |
