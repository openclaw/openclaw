# OpenClaw DingTalk Channel Plugin

钉钉消息渠道插件，支持私聊、群聊消息收发，AI Card 流式输出，以及日程、待办、文档、通讯录、考勤、审批、项目管理等企业级 Agent Tool 能力。

## 功能特性

### 消息渠道

- 文本 / Markdown 消息收发
- AI Card 流式响应
- 图片 / 文件 / 语音消息支持
- 私聊和群聊（@机器人触发）
- Stream 长连接模式

### AI Agent Tools

插件注册了 8 个 Agent Tool，AI 可在对话中自动识别用户意图并调用：

| Tool                  | 功能          | 支持的操作                                                                                               |
| --------------------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| `dingtalk_calendar`   | 📅 日程管理   | create / list / get / update / delete                                                                    |
| `dingtalk_todo`       | ✅ 待办任务   | create / list / get / complete / update / delete                                                         |
| `dingtalk_doc`        | 📄 知识库文档 | spaces / create / list_nodes / get / delete                                                              |
| `dingtalk_contact`    | 📇 通讯录     | list_departments / get_department / list_users / get_user / get_user_by_staff_id / get_user_by_auth_code |
| `dingtalk_attendance` | ⏰ 考勤       | get_records / get_status / get_leave_records                                                             |
| `dingtalk_approval`   | 📋 OA 审批    | list_templates / create / get / list                                                                     |
| `dingtalk_project`    | 🗂️ 项目管理   | list_spaces / list_tasks / get_task / create_task / update_task                                          |
| `dingtalk_coolapp`    | 🔝 酷应用吊顶 | create_topbox / close_topbox                                                                             |

### 聊天命令

在钉钉对话中直接输入命令即可使用：

| 命令                                        | 说明         |
| ------------------------------------------- | ------------ |
| `/cal create <标题> <开始> <结束> [参与者]` | 创建日程     |
| `/cal list [today\|week]`                   | 查看日程列表 |
| `/cal info <eventId>`                       | 查看日程详情 |
| `/cal delete <eventId>`                     | 删除日程     |
| `/cal help`                                 | 日程命令帮助 |
| `/todo`                                     | 待办任务命令 |
| `/doc`                                      | 文档管理命令 |
| `/group`                                    | 群管理命令   |

---

## 快速开始

### 第 1 步：创建钉钉应用

1. 访问 [钉钉开放平台](https://open.dingtalk.com/) 并登录
2. 进入「应用开发」，创建一个**企业内部应用**
3. 在应用信息页面记录 **AppKey**（Client ID）和 **AppSecret**（Client Secret）

### 第 2 步：开通 API 权限

在应用的「权限管理」中，根据需要开通以下权限：

| 功能模块 | 需要的权限              |
| -------- | ----------------------- |
| 消息收发 | 企业内机器人发送消息    |
| 日程管理 | 日历读写权限            |
| 待办任务 | 待办读写权限            |
| 通讯录   | 通讯录部门/成员读取权限 |
| 知识库   | 知识库读写权限          |
| 考勤     | 考勤数据读取权限        |
| OA 审批  | 审批流程读写权限        |
| 项目管理 | 项目任务读写权限        |

### 第 3 步：配置 OpenClaw

```bash
openclaw config set channels.dingtalk '{
  "enabled": true,
  "clientId": "dingxxxxxx",
  "clientSecret": "your-app-secret",
  "enableAICard": true,
  "operatorUserId": "your-dingtalk-union-id"
}' --json
```

### 第 4 步：重启网关

```bash
openclaw gateway restart
```

---

## 配置项说明

| 配置项           | 类型     | 默认值   | 说明                                                           |
| ---------------- | -------- | -------- | -------------------------------------------------------------- |
| `enabled`        | boolean  | `true`   | 是否启用钉钉渠道                                               |
| `clientId`       | string   | —        | 钉钉应用 AppKey                                                |
| `clientSecret`   | string   | —        | 钉钉应用 AppSecret                                             |
| `operatorUserId` | string   | —        | 默认操作者的钉钉 unionId，设置后 Agent Tool 无需每次传 user_id |
| `enableAICard`   | boolean  | `true`   | 是否启用 AI Card 流式输出                                      |
| `replyFinalOnly` | boolean  | `true`   | 仅发送最终回复（非流式）                                       |
| `dmPolicy`       | string   | `"open"` | 私聊策略：`open` / `pairing` / `allowlist`                     |
| `groupPolicy`    | string   | `"open"` | 群聊策略：`open` / `allowlist` / `disabled`                    |
| `requireMention` | boolean  | `true`   | 群聊中是否需要 @机器人才响应                                   |
| `allowFrom`      | string[] | —        | 私聊白名单用户 ID 列表                                         |
| `groupAllowFrom` | string[] | —        | 群聊白名单会话 ID 列表                                         |
| `historyLimit`   | number   | `10`     | 历史消息数量限制                                               |
| `textChunkLimit` | number   | `4000`   | 文本分块大小限制（钉钉单条消息最大 4000 字符）                 |
| `maxFileSizeMB`  | number   | `100`    | 媒体文件大小限制 (MB)                                          |

---

## Agent Tool 使用指南

配置好 `operatorUserId` 后，AI 会自动识别用户意图并调用对应的钉钉 API。以下是各 Tool 的详细说明和自然语言示例。

### 📅 日程管理 (`dingtalk_calendar`)

管理钉钉日历事件，支持创建、查询、修改、删除日程。

**自然语言示例：**

- "帮我安排明天下午 2 点到 3 点的项目评审会"
- "查一下我这周有什么日程"
- "把周五的评审会推迟到下周一"
- "取消明天的站会"

**参数说明：**

| 参数               | 说明                                                    |
| ------------------ | ------------------------------------------------------- |
| `action`           | `create` / `list` / `get` / `update` / `delete`         |
| `summary`          | 日程标题（创建时必填）                                  |
| `start_time`       | 开始时间，ISO 8601 格式，如 `2024-12-31T14:00:00+08:00` |
| `end_time`         | 结束时间，ISO 8601 格式                                 |
| `location`         | 地点                                                    |
| `attendee_ids`     | 参与者 unionId 列表                                     |
| `reminder_minutes` | 提前提醒分钟数，如 `15`                                 |
| `is_all_day`       | 是否全天事件                                            |
| `event_id`         | 日程 ID（get / update / delete 时必填）                 |

### ✅ 待办任务 (`dingtalk_todo`)

管理钉钉待办任务，支持创建、查询、完成、更新、删除。

**自然语言示例：**

- "帮我创建一个待办：明天提交周报"
- "看看我有哪些待办"
- "把提交周报那个待办标记为完成"
- "删除过期的待办任务"

**参数说明：**

| 参数           | 说明                                                         |
| -------------- | ------------------------------------------------------------ |
| `action`       | `create` / `list` / `get` / `complete` / `update` / `delete` |
| `subject`      | 任务标题（创建时必填）                                       |
| `description`  | 任务描述                                                     |
| `due_time`     | 截止时间，ISO 8601 格式                                      |
| `priority`     | 优先级：`10`=低 / `20`=普通 / `30`=重要 / `40`=紧急          |
| `executor_ids` | 执行者 unionId 列表                                          |
| `task_id`      | 任务 ID（get / complete / update / delete 时必填）           |

### 📄 知识库文档 (`dingtalk_doc`)

管理钉钉知识库和文档。

**自然语言示例：**

- "列出所有知识库"
- "在产品知识库里新建一个文档叫项目周报"
- "查看知识库里有哪些文档"

**参数说明：**

| 参数             | 说明                                                  |
| ---------------- | ----------------------------------------------------- |
| `action`         | `spaces` / `create` / `list_nodes` / `get` / `delete` |
| `space_id`       | 知识库 ID（create / list_nodes / delete 时必填）      |
| `name`           | 文档名称（创建时必填）                                |
| `doc_type`       | 文档类型：`alidoc`（默认）/ `folder`                  |
| `parent_node_id` | 父节点 ID（可选，不填则在根目录创建）                 |
| `node_id`        | 节点 ID（get / delete 时必填）                        |

### 📇 通讯录 (`dingtalk_contact`)

查询企业通讯录信息。

**自然语言示例：**

- "查一下研发部有哪些人"
- "帮我查一下张三的联系方式"
- "列出所有部门"

**参数说明：**

| 参数            | 说明                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `action`        | `list_departments` / `get_department` / `list_users` / `get_user` / `get_user_by_staff_id` / `get_user_by_auth_code` |
| `department_id` | 部门 ID（`1` 为根部门）                                                                                              |
| `user_id`       | 用户 unionId（get_user 时必填）                                                                                      |
| `staff_id`      | 用户 staffId/userid（get_user_by_staff_id 时必填）                                                                   |
| `auth_code`     | JSAPI 免登码（get_user_by_auth_code 时必填）                                                                         |

### ⏰ 考勤 (`dingtalk_attendance`)

查询考勤打卡和请假数据。

**自然语言示例：**

- "查一下我昨天的打卡记录"
- "看看本月的考勤异常"
- "查询上周的请假记录"

**参数说明：**

| 参数         | 说明                                                        |
| ------------ | ----------------------------------------------------------- |
| `action`     | `get_records` / `get_status` / `get_leave_records`          |
| `user_ids`   | 要查询的用户 userId 列表（get_records / get_status 时必填） |
| `start_date` | 开始日期，`YYYY-MM-DD` 格式                                 |
| `end_date`   | 结束日期，`YYYY-MM-DD` 格式                                 |

### 📋 OA 审批 (`dingtalk_approval`)

管理钉钉 OA 审批流程。

**自然语言示例：**

- "有哪些审批模板"
- "帮我发起一个请假审批"
- "查一下我上周提交的审批状态"

**参数说明：**

| 参数            | 说明                                              |
| --------------- | ------------------------------------------------- |
| `action`        | `list_templates` / `create` / `get` / `list`      |
| `process_code`  | 审批模板 code（create / list 时必填）             |
| `instance_id`   | 审批实例 ID（get 时必填）                         |
| `form_values`   | 表单字段值数组 `[{name, value}]`（create 时必填） |
| `department_id` | 发起人部门 ID（create 时必填）                    |
| `approvers`     | 审批人 userId 列表（可选，不填使用模板默认）      |

### 🗂️ 项目管理 (`dingtalk_project`)

管理钉钉项目空间和任务。

**自然语言示例：**

- "列出所有项目空间"
- "查看项目里的任务列表"
- "创建一个新任务：完成 API 对接"

**参数说明：**

| 参数          | 说明                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| `action`      | `list_spaces` / `list_tasks` / `get_task` / `create_task` / `update_task` |
| `space_id`    | 项目空间 ID                                                               |
| `task_id`     | 任务 ID                                                                   |
| `subject`     | 任务标题                                                                  |
| `description` | 任务描述                                                                  |

### 🔝 酷应用吊顶 (`dingtalk_coolapp`)

在群聊顶部创建或关闭吊顶卡片（TopBox）。

**参数说明：**

| 参数                   | 说明                                     |
| ---------------------- | ---------------------------------------- |
| `action`               | `create_topbox` / `close_topbox`         |
| `open_conversation_id` | 群聊 openConversationId                  |
| `cool_app_code`        | 酷应用 code，如 `COOLAPP-1-xxxx`         |
| `card_template_id`     | 互动卡片模板 ID（create_topbox 时必填）  |
| `out_track_id`         | 自定义卡片追踪 ID（close_topbox 时必填） |
| `card_data`            | 卡片公共数据 JSON 字符串                 |

---

## 聊天命令详细用法

### 日程命令 `/cal`

时间格式支持：

| 格式               | 示例               | 说明                         |
| ------------------ | ------------------ | ---------------------------- |
| `HH:MM`            | `14:00`            | 今天指定时间（已过则为明天） |
| `tomorrow HH:MM`   | `tomorrow 14:00`   | 明天指定时间                 |
| `YYYY-MM-DD HH:MM` | `2024-12-31 14:00` | 指定日期时间                 |
| `+Nh`              | `+2h`              | N 小时后                     |
| `+Nm`              | `+30m`             | N 分钟后                     |

**示例：**

```
/cal create 项目周会 14:00 15:00 user1,user2
/cal create 年终总结 tomorrow 10:00 tomorrow 12:00
/cal list today
/cal list week
/cal info evt_xxxxx
/cal delete evt_xxxxx
```

---

## 安全策略

| 策略          | 可选值      | 说明                           |
| ------------- | ----------- | ------------------------------ |
| `dmPolicy`    | `open`      | 任何人都可以私聊机器人         |
|               | `pairing`   | 需要配对验证                   |
|               | `allowlist` | 仅 `allowFrom` 列表中的用户    |
| `groupPolicy` | `open`      | 群内任何成员 @机器人 即可触发  |
|               | `allowlist` | 仅 `groupAllowFrom` 列表中的群 |
|               | `disabled`  | 禁用群聊                       |

> ⚠️ `groupPolicy="open"` 时，任何群成员 @机器人 都可触发响应。建议生产环境设为 `allowlist` 并配置 `groupAllowFrom`。

---

## 原始项目信息

- **原项目**: [moltbot-china](https://github.com/BytePioneer-AI/moltbot-china)
- **版本**: 0.1.14
- **许可证**: MIT
