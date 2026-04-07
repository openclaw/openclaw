---
name: wecom-meeting-query
description: 企业微信会议查询技能, 支持查询会议列表, 获取会议详情, 按关键词查找会议. 当用户需要"查看会议", "查询会议列表", "会议详情", "什么时候开会", "有哪些会议", "查找会议"时触发.
---
# 企业微信会议查询技能

> `wecom_mcp` 是一个 MCP tool，所有操作通过调用该 tool 完成。

> ⚠️ **前置条件**：首次调用 `wecom_mcp` 前，必须按 `wecom-preflight` 技能执行前置条件检查，确保工具已加入白名单。

## 概述

wecom-meeting-query 提供企业微信会议查询能力, 包含以下功能:

1. **查询会议列表** - 按用户和时间范围查询会议 ID 列表 (限制: 当日及前后 30 天, 上限 100 个)
2. **获取会议详情** - 通过会议 ID 查询完整会议信息

## 命令调用方式

查看可用命令列表：使用 `wecom_mcp` tool 调用 `wecom_mcp list meeting`

执行指定命令：使用 `wecom_mcp` tool 调用 `wecom_mcp call meeting <tool_name> '<json_params>'`
---

## 命令详细说明

### 1. 查询会议列表 (list_user_meetings)

查询指定用户在时间范围内的会议 ID 列表.

#### 执行命令

使用 `wecom_mcp` tool 调用 `wecom_mcp call meeting list_user_meetings '{"begin_datetime": "2026-03-01 00:00", "end_datetime": "2026-03-31 23:59", "limit": 100}'`

#### 入参说明

| 参数               | 类型    | 必填 | 说明                                    |
| ------------------ | ------- | ---- | --------------------------------------- |
| `begin_datetime` | string  | 否   | 查询起始时间, 格式:`YYYY-MM-DD HH:mm` |
| `end_datetime`   | string  | 否   | 查询结束时间, 格式:`YYYY-MM-DD HH:mm` |
| `cursor`         | string  | 否   | 分页游标, 用于获取下一页数据            |
| `limit`          | integer | 否   | 每页返回条数, 最大 100                  |

> **限制**: 时间范围仅支持当日及前后 30 天.

#### 返回参数

```json
{
  "errcode": 0,
  "errmsg": "ok",
  "next_cursor": "分页游标字符串, 为空表示无更多",
  "meetingid_list": ["会议ID_1", "会议ID_2"]
}
```

| 字段               | 类型   | 说明                           |
| ------------------ | ------ | ------------------------------ |
| `meetingid_list` | array  | 会议 ID 列表                   |
| `next_cursor`    | string | 下一页游标, 为空表示无更多数据 |

---

### 2. 获取会议详情 (get_meeting_info)

通过会议 ID 查询会议的完整详情.

#### 执行命令

使用 `wecom_mcp` tool 调用 `wecom_mcp call meeting get_meeting_info '{"meetingid": "<会议id>"}'`

#### 入参说明

| 参数              | 类型   | 必填 | 说明            |
| ----------------- | ------ | ---- | --------------- |
| `meetingid`     | string | 是   | 会议 ID, 通过 `list_user_meetings` 获取 |
| `meeting_code`  | string | 否   | 会议号码        |
| `sub_meetingid` | string | 否   | 子会议 ID       |

#### 返回参数

```json
{
  "errcode": 0,
  "errmsg": "ok",
  "creator_userid": "创建者userid",
  "admin_userid": "会议管理userid (与 creator_userid 有且仅返回一个)",
  "title": "会议标题",
  "meeting_start_datetime": "YYYY-MM-DD HH:mm",
  "meeting_duration": 会议时长秒数,
  "description": "会议描述文本",
  "location": "会议地点文本",
  "main_department": 创建者主部门ID,
  "status": 会议状态枚举值,
  "meeting_type": 会议类型枚举值,
  "attendees": {
    "member": [
      {
        "userid": "内部成员userid",
        "status": 与会状态枚举值,
        "first_join_datetime": "YYYY-MM-DD HH:mm",
        "last_quit_datetime": "YYYY-MM-DD HH:mm",
        "total_join_count": 加入次数,
        "cumulative_time": 累计在会时长秒数
      }
    ],
    "tmp_external_user": [
      {
        "tmp_external_userid": "外部临时用户ID",
        "status": 与会状态枚举值,
        "first_join_datetime": "YYYY-MM-DD HH:mm",
        "last_quit_datetime": "YYYY-MM-DD HH:mm",
        "total_join_count": 加入次数,
        "cumulative_time": 累计在会时长秒数
      }
    ]
  },
  "settings": {
    "remind_scope": 提醒范围枚举值,
    "need_password": 是否需要密码布尔值,
    "password": "会议密码",
    "enable_waiting_room": 是否启用等候室布尔值,
    "allow_enter_before_host": 是否允许提前入会布尔值,
    "enable_enter_mute": 入会静音枚举值,
    "allow_unmute_self": 是否允许自我解除静音布尔值,
    "allow_external_user": 是否允许外部用户布尔值,
    "enable_screen_watermark": 是否开启水印布尔值,
    "watermark_type": 水印类型枚举值,
    "auto_record_type": "录制类型枚举字符串",
    "attendee_join_auto_record": 参会者加入自动录制布尔值,
    "enable_host_pause_auto_record": 主持人可暂停录制布尔值,
    "enable_doc_upload_permission": 允许上传文档布尔值,
    "enable_enroll": 是否开启报名布尔值,
    "enable_host_key": 是否启用主持人密钥布尔值,
    "host_key": "主持人密钥字符串",
    "hosts": {"userid": ["主持人userid列表"]},
    "current_hosts": {"userid": ["当前主持人userid列表"]},
    "co_hosts": {"userid": ["联席主持人userid列表"]},
    "ring_users": {"userid": ["响铃用户userid列表"]}
  },
  "meeting_code": "会议号码字符串",
  "meeting_link": "会议链接URL",
  "has_vote": 是否有投票布尔值,
  "has_more_sub_meeting": 是否有更多子会议枚举值,
  "remain_sub_meetings": 剩余子会议场数,
  "current_sub_meetingid": "当前子会议ID",
  "guests": [
    {
      "area": "国际区号",
      "phone_number": "手机号字符串",
      "guest_name": "嘉宾姓名"
    }
  ],
  "reminders": {
    "is_repeat": 是否周期性枚举值,
    "repeat_type": 重复类型枚举值,
    "repeat_until_type": 结束类型枚举值,
    "repeat_until_count": 限定次数,
    "repeat_until_datetime": "YYYY-MM-DD HH:mm",
    "repeat_interval": 重复间隔数值,
    "is_custom_repeat": 是否自定义重复枚举值,
    "repeat_day_of_week": [星期几数组],
    "repeat_day_of_month": [日期数组],
    "remind_before": [提醒秒数数组]
  },
  "sub_meetings": [
    {
      "sub_meetingid": "子会议ID",
      "status": 子会议状态枚举值,
      "start_datetime": "YYYY-MM-DD HH:mm",
      "end_datetime": "YYYY-MM-DD HH:mm",
      "title": "子会议标题",
      "repeat_id": "周期性会议分段ID"
    }
  ],
  "sub_repeat_list": [
    {
      "repeat_id": "周期性会议分段ID",
      "repeat_type": 重复类型枚举值,
      "repeat_until_type": 结束类型枚举值,
      "repeat_until_count": 限定次数,
      "repeat_until_datetime": "YYYY-MM-DD HH:mm",
      "repeat_interval": 重复间隔数值,
      "is_custom_repeat": 是否自定义重复枚举值,
      "repeat_day_of_week": [星期几数组],
      "repeat_day_of_month": [日期数组]
    }
  ]
}
```

**关键返回字段:**

| 字段                                      | 类型    | 说明                                                                                                          |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `creator_userid`                        | string  | 创建者 userid, 与 `admin_userid` 有且仅返回一个                                                             |
| `admin_userid`                          | string  | 会议管理 userid, 与 `creator_userid` 有且仅返回一个                                                         |
| `title`                                 | string  | 会议标题                                                                                                      |
| `meeting_start_datetime`                | string  | 会议开始时间                                                                                                  |
| `meeting_duration`                      | integer | 会议时长 (秒)                                                                                                 |
| `main_department`                       | integer | 创建者所属主部门                                                                                              |
| `status`                                | integer | 会议状态 (1: 待开始, 2: 会议中, 3: 已结束, 4: 已取消, 5: 已过期)                                              |
| `meeting_type`                          | integer | 会议类型 (0: 一次性会议, 1: 周期性会议, 2: 微信专属会议, 3: Rooms 投屏会议, 5: 个人会议号会议, 6: 网络研讨会) |
| `meeting_code`                          | string  | 会议号码                                                                                                      |
| `meeting_link`                          | string  | 会议链接                                                                                                      |
| `attendees.member`                      | array   | 内部参与者列表                                                                                                |
| `attendees.member[].status`             | integer | 与会状态 (1: 已参与, 2: 未参与)                                                                               |
| `attendees.tmp_external_user`           | array   | 外部参与者 (临时 ID)                                                                                          |
| `attendees.tmp_external_user[].status`  | integer | 与会状态 (1: 已参与, 2: 未参与)                                                                               |
| `guests`                                | array   | 外部嘉宾列表, 每项含 `area`, `phone_number`, `guest_name`                                               |
| `current_sub_meetingid`                 | string  | 当前子会议 ID                                                                                                 |
| `settings.ring_users`                   | object  | 响铃用户列表                                                                                                  |
| `settings.need_password`                | boolean | 是否需要密码 (只读字段)                                                                                       |
| `settings.enable_doc_upload_permission` | boolean | 是否允许成员上传文档                                                                                          |
| `settings.hosts`                        | object  | 主持人列表                                                                                                    |
| `settings.current_hosts`                | object  | 当前主持人列表                                                                                                |
| `settings.co_hosts`                     | object  | 联席主持人列表                                                                                                |
| `reminders`                             | object  | 周期性配置                                                                                                    |
| `has_vote`                              | boolean | 是否有投票 (仅会议创建人和主持人有权限查询)                                                                   |
| `has_more_sub_meeting`                  | integer | 是否还有更多子会议特例 (0: 无更多, 1: 有更多)                                                                 |
| `remain_sub_meetings`                   | integer | 剩余子会议场数                                                                                                |
| `sub_meetings`                          | array   | 子会议列表                                                                                                    |
| `sub_meetings[].status`                 | integer | 子会议状态 (0: 默认/存在, 1: 已删除)                                                                          |
| `sub_meetings[].repeat_id`              | string  | 周期性会议分段 ID, 用于关联子会议所属分段                                                                     |
| `sub_repeat_list`                       | array   | 周期性会议分段信息, 修改周期性会议某一场后可能产生不同分段, 各分段有不同重复规则                              |

---

## 典型工作流

### 工作流 1: 查询会议列表

**示例**: 用户说 "帮我查一下本周有哪些会议"

**步骤:**

1. **确定时间范围**: 根据当前日期计算本周的起止时间.
2. **查询会议 ID 列表**:

使用 `wecom_mcp` tool 调用 `wecom_mcp call meeting list_user_meetings '{"begin_datetime": "2026-03-16 00:00", "end_datetime": "2026-03-22 23:59", "limit": 100}'`

3. **逐个查询会议详情** (对返回的每个 meetingid):

使用 `wecom_mcp` tool 调用 `wecom_mcp call meeting get_meeting_info '{"meetingid": "<会议id1>"}'`
使用 `wecom_mcp` tool 调用 `wecom_mcp call meeting get_meeting_info '{"meetingid": "<会议id2>"}'`

4. **汇总展示**:

```
📋 本周会议列表 (共 3 场):

1. 📅 技术方案评审
   🕐 2026-03-17 10:00 - 11:00
   👥 张三, 李四, 王五

2. 📅 产品需求沟通
   🕐 2026-03-18 14:00 - 15:00
   👥 赵六, 钱七

3. 📅 周五周会
   🕐 2026-03-21 09:00 - 10:00
   👥 全组成员
```

> **分页处理**: 如果 `next_cursor` 不为空, 使用 `cursor` 参数继续拉取下一页.

---

### 工作流 2: 获取会议详情

**示例**: 用户说 "帮我看下技术方案评审会议的详情"

**步骤:**

1. **定位会议**: 先通过会议列表查询找到目标会议的 meetingid (按关键词匹配).
2. **查询详情**:

使用 `wecom_mcp` tool 调用 `wecom_mcp call meeting get_meeting_info '{"meetingid": "<target_meetingid>"}'`

3. **展示结果**:

#会议号: <会议号>

```
📅 <会议标题>

🕐 时间: <开始时间>, 时长 <时长>
📍 地点: <会议地点>
📝 描述: <会议描述>
👤 创建者: <创建者姓名>
👥 参与者: <参与者姓名列表>
🔗 会议链接: <会议链接>
```

---

### 工作流 3: 根据关键词查找会议

**示例**: 用户说 "技术评审会议是什么时候?"

**查询策略:**

1. **确定查询范围**: 默认查当日前后 30 天 (接口限制范围).
2. **拉取会议列表**:

使用 `wecom_mcp` tool 调用 `wecom_mcp call meeting list_user_meetings '{"begin_datetime": "2026-02-15 00:00", "end_datetime": "2026-04-16 23:59", "limit": 100}'`

3. **逐个查询详情并匹配标题关键词**.
4. **找到匹配后停止查询, 展示结果**:

#会议号: <会议号>

```
✅ 找到会议: "<会议标题>"

📅 时间: <开始时间>, 时长 <时长>
📍 地点: <会议地点>
👥 参与者: <参与者姓名列表>
🔗 会议链接: <会议链接>
```

5. **未找到处理**: 告知用户在前后 30 天范围内未找到匹配会议, 请确认会议名称.

---

## 注意事项

- **时间格式**: 统一使用 `YYYY-MM-DD HH:mm` 格式
- **会议列表时间范围限制**: 仅支持查询当日及前后 30 天内的会议
- **查询详情需两步**: 先通过 `list_user_meetings` 获取会议 ID 列表, 再通过 `get_meeting_info` 逐个获取详情