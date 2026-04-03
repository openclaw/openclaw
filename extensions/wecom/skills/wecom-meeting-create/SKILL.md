---
name: wecom-meeting-create
description: 企业微信会议创建技能, 支持创建预约会议. 当用户需要"创建会议", "预约会议", "约会议", "安排会议"时触发.
---
# 企业微信会议创建技能

> `wecom_mcp` 是一个 MCP tool，所有操作通过调用该 tool 完成。

> ⚠️ **前置条件**：首次调用 `wecom_mcp` 前，必须按 `wecom-preflight` 技能执行前置条件检查，确保工具已加入白名单。

## 概述

wecom-meeting-create 提供企业微信预约会议的创建能力, 支持设置会议参数, 邀请参与人等.

## 命令调用方式

查看可用命令列表：使用 `wecom_mcp` tool 调用 `wecom_mcp list meeting`

执行指定命令：使用 `wecom_mcp` tool 调用 `wecom_mcp call meeting <tool_name> '<json_params>'`

---

## 命令详细说明

### 创建预约会议 (create_meeting)

创建一个预约会议, 支持设置会议参数配置等.

#### 执行命令

使用 `wecom_mcp` tool 调用 `wecom_mcp call meeting create_meeting '{"title": "<会议标题>", "meeting_start_datetime": "<会议开始时间>", "meeting_duration": <会议持续时长(秒)>}'`

#### 入参说明

| 参数                       | 类型    | 必填 | 说明                                              |
| -------------------------- | ------- | ---- | ------------------------------------------------- |
| `title`                  | string  | 是   | 会议标题                                          |
| `meeting_start_datetime` | string  | 是   | 会议开始时间, 格式:`YYYY-MM-DD HH:mm`           |
| `meeting_duration`       | integer | 是   | 会议持续时长 (秒), 例如 3600 = 1 小时             |
| `description`            | string  | 否   | 会议描述                                          |
| `location`               | string  | 否   | 会议地点                                          |
| `invitees`               | object  | 否   | 被邀请人, 格式:`{"userid": ["lisi", "wangwu"]}` |
| `settings`               | object  | 否   | 会议设置 (详见下方)                               |

> 被邀请人 userid 通过 `wecom-contact-lookup` 技能获取

**settings 字段:**

| 参数                        | 类型    | 说明                                          |
| --------------------------- | ------- | --------------------------------------------- |
| `password`                | string  | 会议密码                                      |
| `enable_waiting_room`     | boolean | 是否启用等候室                                |
| `allow_enter_before_host` | boolean | 是否允许成员在主持人进入前加入                |
| `enable_enter_mute`       | integer | 入会时静音设置 (枚举: 0: 关闭, 1: 开启)       |
| `allow_external_user`     | boolean | 是否允许外部用户入会                          |
| `enable_screen_watermark` | boolean | 是否开启屏幕水印                              |
| `remind_scope`            | integer | 提醒范围 (1: 不提醒, 2: 仅提醒主持人, 3: 提醒所有成员, 4: 指定部分人响铃, 默认仅提醒主持人) |
| `ring_users`              | object  | 响铃用户, 格式:`{"userid": ["lisi"]}`   |

> 响铃用户 userid 通过 `wecom-contact-lookup` 技能获取

#### 返回参数

```json
{
  "errcode": 0,
  "errmsg": "ok",
  "meetingid": "会议ID字符串",
  "meeting_code": "会议号码字符串",
  "meeting_link": "会议链接URL",
  "excess_users": ["无效会议账号的userid"]
}
```

| 字段             | 类型   | 说明                                                                                                               |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `meetingid`    | string | 会议 ID                                                                                                            |
| `meeting_code` | string | 会议号码, 向用户展示时需在回复**开头**单独一行纯文字展示, 格式 `#会议号: xxx-xxx-xxx` (每3位用 `-` 分隔) |
| `meeting_link` | string | 会议链接                                                                                                           |
| `excess_users` | array  | 参会人中包含无效会议账号的 userid, 仅在购买会议专业版企业由于部分参会人无有效会议账号时返回                        |

---

## 典型工作流

### 工作流 1: 最简创建 (无邀请人)

**用户意图**: "帮我约一个明天下午3点的会议, 主题是周例会, 时长1小时"

**步骤:**

1. **解析用户意图**: 时间 + 主题已有, 邀请人未提及则默认留空, 直接创建.
2. **调用创建命令**:

使用 `wecom_mcp` tool 调用 `wecom_mcp call meeting create_meeting '{"title": "周例会", "meeting_start_datetime": "2026-03-18 15:00", "meeting_duration": 3600}'`

3. **展示结果**:

#会议号: <会议号>

```
✅ 会议创建成功!

📅 <会议标题>
🕐 时间: <开始时间>, 时长 <时长>
🔗 会议链接: <会议链接>
```

### 工作流 2: 带邀请人 + 地点 + 描述

**用户意图**: "帮我约一个明天下午3点的会议, 主题是技术方案评审, 邀请张三和李四, 地点在3楼会议室, 时长1小时"

**步骤:**

1. **解析用户意图**: 有邀请人, 需先查询通讯录获取 userid.
2. **通讯录查询**: 调用 `wecom-contact-lookup` 技能获取通讯录成员, 按姓名筛选出参与者的 userid.

使用 `wecom_mcp` tool 调用 `wecom_mcp call contact get_userlist '{}'`

在返回的 `userlist` 中筛选 `name` 包含 "张三" 和 "李四" 的成员, 获取其 `userid`.

3. **信息已充分, 直接调用创建命令** (禁止暴露内部 ID):

使用 `wecom_mcp` tool 调用 `wecom_mcp call meeting create_meeting '{"title": "技术方案评审", "meeting_start_datetime": "2026-03-18 15:00", "meeting_duration": 3600, "location": "3楼会议室", "invitees": {"userid": ["zhangsan", "lisi"]}}'`

4. **展示结果**:

#会议号: <会议号>

```
✅ 会议创建成功!

📅 <会议标题>
🕐 时间: <开始时间>, 时长 <时长>
👥 参与人: <参与者姓名列表>
🔗 会议链接: <会议链接>
```

---

## 复杂场景样例

按场景按需加载, 避免一次性引入过多无关示例:

| 文件 | 适用场景 |
| ---- | -------- |
| [references/example-security.md](references/example-security.md) | 会议密码, 等候室, 外部用户限制 |
| [references/example-reminder.md](references/example-reminder.md) | 响铃提醒, 指定部分人响铃 |
| [references/example-full.md](references/example-full.md) | 全参数综合场景 (含静音, 屏幕水印, 等候室等设置) |

---

## 注意事项

- **信息追问**: 缺少时间或主题时, 简洁追问用户; 未提及邀请人则默认留空
- **通讯录查询**: 涉及参与人时, 需先通过 `wecom-contact-lookup` 技能的 `get_userlist` 接口获取全量通讯录成员, 再按姓名/别名本地筛选匹配出对应的 `userid`. 该接口无入参, 返回当前用户可见范围内的成员列表 (含 `userid`, `name`, `alias`)
- **直接创建**: 时间 + 主题已知即可直接创建, 邀请人有则带上, 无则留空; 无论信息是一次性提供还是上下文可推断, 非必要则均不请求确认, 直接创建即可
- **时间格式**: 统一使用 `YYYY-MM-DD HH:mm` 格式
