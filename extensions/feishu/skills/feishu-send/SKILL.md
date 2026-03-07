---
name: feishu-send
description: |
  飞书代发消息：文本、文件、@全体。找人→确认→发送→审计。
  当用户提到给某人发消息、通知某人、转发、发文件等意图时激活。
---

# 飞书代发消息

## 执行流程

### 1. 解析目标

- **发给个人**：用 `feishu-contacts` skill 把人名解析为 `open_id`
- **发到群聊**：用 `feishu-groups` skill 列出群，确认 `chat_id`

多人匹配时列出候选让用户确认。

### 2. 发送消息

#### 文本消息

```typescript
import { sendTextMessage } from "./src/proactive-send.js";
const result = await sendTextMessage({
  cfg,
  receiveId: "ou_xxx",
  receiveIdType: "open_id",
  text: "你好",
});
```

#### 文件消息

```typescript
import { sendFileMessage } from "./src/proactive-send.js";
const result = await sendFileMessage({
  cfg,
  receiveId: "ou_xxx",
  receiveIdType: "open_id",
  filePath: "/path/to/file.pdf",
});
```

#### @全体消息（仅群聊）

```typescript
import { sendMentionAll } from "./src/proactive-send.js";
const result = await sendMentionAll({
  cfg,
  chatId: "oc_xxx",
  text: "重要通知内容",
});
```

### 3. 结果确认

返回 `{ messageId }` 或 `{ error }` — 错误信息包含权限开启链接。

## 安全规则

1. 发送前确认目标人和内容
2. 23:00-08:00 非紧急消息需二次确认
3. 文件发送前确认文件路径和接收者

## 权限要求

| Scope                    | 说明                      |
| ------------------------ | ------------------------- |
| `im:message:send_as_bot` | 以应用身份发消息          |
| `im:resource`            | 上传/下载消息中的资源文件 |
