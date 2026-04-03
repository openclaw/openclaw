---
name: wecom-schedule
description: 企业微信日程管理技能。适用于用户对企业微信日程的各类管理需求。当用户需要：(1) 查询指定时间范围内的日程列表或获取日程详细信息（标题、时间、地点、参与者等），(2) 创建新日程并设置提醒、参与人等，(3) 修改已有日程的标题、时间、地点等信息或取消日程，(4) 添加或移除日程参与人，(5) 查询多个成员的闲忙状态并分析共同空闲时段以安排会议时使用此技能。
metadata:
  {
    "openclaw": { "emoji": "📅" },
  }
---

# 企业微信日程管理技能

> `wecom_mcp` 是一个 MCP tool，所有操作通过调用该 tool 完成。

> ⚠️ **前置条件**：首次调用 `wecom_mcp` 前，必须按 `wecom-preflight` 技能执行前置条件检查，确保工具已加入白名单。

通过 `wecom_mcp call schedule <接口名> '<json入参>'` 与企业微信日程系统交互。

## 注意事项

- 日程列表查询仅支持**当日前后 30 天**，时间格式 `YYYY-MM-DD` 或 `YYYY-MM-DD HH:MM:SS`
- 涉及参与者 userid 时，需先使用 **wecom-contact-lookup** 技能获取；存在同名时展示候选让用户选择（禁止暴露 userid）
- 创建/修改/取消前，先确认目标日程和参与者信息
- `errcode != 0` 时展示错误信息；返回的 `start_time`/`end_time` 为 Unix 时间戳（秒），需转为可读格式
- **注意时间格式转换**：接口入参使用字符串格式（如 `YYYY-MM-DD HH:MM:SS`），但返回值多为 Unix 时间戳，使用时需进行格式转换

---

## 接口列表

### get_schedule_list_by_range — 查询日程 ID 列表

使用 `wecom_mcp` tool 调用 `wecom_mcp call schedule get_schedule_list_by_range '{"start_time": "YYYY-MM-DD HH:MM:SS", "end_time": "YYYY-MM-DD HH:MM:SS"}'`

返回 `schedule_id_list` 数组。仅支持当日前后 30 天。

### get_schedule_detail — 获取日程详情

使用 `wecom_mcp` tool 调用 `wecom_mcp call schedule get_schedule_detail '{"schedule_id_list": ["SCHEDULE_ID_1", "SCHEDULE_ID_2"]}'`

支持 1~50 个 ID，返回日程标题、时间、地点、参与者等。参见 [API 详情](references/api-get-schedule-detail.md)。

### create_schedule — 创建日程

使用 `wecom_mcp` tool 调用 `wecom_mcp call schedule create_schedule '{"schedule": {"start_time": "YYYY-MM-DD HH:MM:SS", "end_time": "YYYY-MM-DD HH:MM:SS", "summary": "日程标题", "attendees": [{"userid": "USER_ID"}], "reminders": {"is_remind": 1, "remind_before_event_secs": 3600, "timezone": 8}}}'`

参见 [API 详情](references/api-create-schedule.md) | [reminders 字段](references/ref-reminders.md)。

### update_schedule — 修改日程

只需传入需修改的字段，未传字段保持不变。

> ⚠️ **重要**：如果要把全天日程变成普通日程并修改时间，则一定要把 `is_whole_day` 设置为 `0`，否则日程仍会保持全天状态。

使用 `wecom_mcp` tool 调用 `wecom_mcp call schedule update_schedule '{"schedule": {"schedule_id": "SCHEDULE_ID", "summary": "更新后的标题"}}'`

参见 [API 详情](references/api-update-schedule.md)。

### cancel_schedule — 取消日程

使用 `wecom_mcp` tool 调用 `wecom_mcp call schedule cancel_schedule '{"schedule_id": "SCHEDULE_ID"}'`

### add_schedule_attendees / del_schedule_attendees — 管理参与人

- 添加参与人：使用 `wecom_mcp` tool 调用 `wecom_mcp call schedule add_schedule_attendees '{"schedule_id": "SCHEDULE_ID", "attendees": [{"userid": "USER_ID"}]}'`
- 移除参与人：使用 `wecom_mcp` tool 调用 `wecom_mcp call schedule del_schedule_attendees '{"schedule_id": "SCHEDULE_ID", "attendees": [{"userid": "USER_ID"}]}'`

### check_availability — 查询闲忙

使用 `wecom_mcp` tool 调用 `wecom_mcp call schedule check_availability '{"check_user_list": ["USER_ID_1", "USER_ID_2"], "start_time": "YYYY-MM-DD HH:MM:SS", "end_time": "YYYY-MM-DD HH:MM:SS"}'`

支持 1~10 个用户，返回各用户的忙碌时段列表。参见 [API 详情](references/api-check-availability.md)。

---

## 典型工作流

### 查询日程

**经典 query 示例：**
- "我今天有哪些日程？"
- "帮我看看这周三下午有没有会议"
- "明天的日程安排是什么？"
- "查一下最近有没有关于项目评审的日程"
- "我下周一到周五的日程都有哪些？"

**流程：**
1. 根据用户意图计算时间范围（如"今天"→当日 00:00:00 至 23:59:59，"这周"→本周一至周日）
2. 调用 `get_schedule_list_by_range` 获取日程 ID 列表
3. 调用 `get_schedule_detail` 批量获取详情，将 Unix 时间戳转为可读时间
4. 若用户提到关键词（如"项目评审"），在 `summary` 中匹配筛选；未找到则逐步扩大范围至前后 30 天上限
5. 展示日程列表时包含标题、时间、地点、参与者等关键信息，方便用户快速了解

### 创建日程

**经典 query 示例：**
- "帮我创建一个明天下午 2 点到 3 点的会议，标题叫需求评审"
- "安排一个周五全天的团建活动"
- "创建日程：后天上午 10 点和张三、李四开产品方案讨论会，地点在 3 楼会议室"
- "帮我建个日程，下周一 14:00-15:00，提前 15 分钟提醒"
- "约一个明天上午的日程，邀请王伟参加"

**流程：**
1. 解析用户意图，提取时间、标题、地点、参与人、提醒设置等信息
2. 若涉及参与人，先通过 **wecom-contact-lookup** 查询 userid；存在同名时展示候选让用户选择
3. 若用户未指定提醒，默认设置提前 15 分钟提醒（`remind_before_event_secs: 900`）
4. 若用户说"全天"，设置 `is_whole_day: 1`，时间设为当天 00:00:00 至 23:59:59
5. 向用户确认日程信息（标题、时间、地点、参与人等）后调用 `create_schedule`

### 修改日程

**经典 query 示例：**
- "把明天的需求评审改到后天下午 3 点"
- "帮我修改下今天下午的会议标题，改成技术方案评审"
- "我今天 14 点的日程地点改成线上腾讯会议"
- "把周五的团建活动推迟一个小时"
- "帮我给明天的周会加个描述：讨论 Q2 规划"

**流程：**
1. 先通过查询工作流定位目标日程（根据用户提到的时间、标题等关键词匹配）
2. 若匹配到多个日程，展示候选列表让用户确认
3. 向用户确认要修改的字段和目标值
4. 调用 `update_schedule`，只传入需修改的字段

### 取消日程

**经典 query 示例：**
- "取消明天下午的需求评审"
- "帮我把周五的团建日程删掉"
- "我不想开今天 15 点的会了，帮我取消"

**流程：**
1. 先通过查询工作流定位目标日程
2. 向用户确认取消的日程信息（标题、时间等），避免误操作
3. 确认后调用 `cancel_schedule`

### 管理参与人

**经典 query 示例：**
- "把张三加到明天的需求评审会议里"
- "帮我把李四从周五的日程里移除"
- "明天下午的会议再邀请一下王伟和赵敏"
- "把我后天那个技术分享的参与人里去掉刘强"

**流程：**
1. 通过 **wecom-contact-lookup** 获取目标人员 userid；存在同名时展示候选让用户选择
2. 通过查询工作流定位目标日程
3. 调用 `add_schedule_attendees` 或 `del_schedule_attendees` 完成添加/移除

### 查询闲忙并安排会议

**经典 query 示例：**
- "帮我看看张三和李四明天下午有没有空"
- "查一下我和王伟这周的空闲时间，想约个会"
- "我想跟产品组的小明、小红开个会，看看大家什么时候有空"
- "找一个明天下午大家都有空的时段，安排一个 1 小时的会议"

**流程：**
1. 通过 **wecom-contact-lookup** 获取相关人员 userid
2. 调用 `check_availability` 查询指定时间范围内各用户的忙碌时段
3. 分析所有用户的忙碌时段，计算出共同空闲时段并推荐给用户
4. 用户确认时段后，调用 `create_schedule` 创建会议并自动添加参与人
