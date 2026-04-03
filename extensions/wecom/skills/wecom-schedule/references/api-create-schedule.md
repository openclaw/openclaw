# create_schedule API

创建新日程，支持设置标题、时间、地点、参与者、提醒和重复规则。

## 参数说明（`schedule` 对象内）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `start_time` | string | ✅ | 开始时间 |
| `end_time` | string | ✅ | 结束时间 |
| `summary` | string | ❌ | 日程标题，最长 128 字 |
| `description` | string | ❌ | 日程描述，最长 1000 字 |
| `location` | string | ❌ | 地点，最长 128 字 |
| `is_whole_day` | integer | ❌ | 是否全天：`0`-否（默认），`1`-是 |
| `attendees` | array | ❌ | 参与者列表，每项含 `userid` |
| `reminders` | object | ❌ | 提醒与重复设置（见 [reminders 字段参考](ref-reminders.md)） |

## 请求示例

使用 `wecom_mcp` tool 调用 `wecom_mcp call schedule create_schedule '{"schedule": {"start_time": "YYYY-MM-DD HH:MM:SS", "end_time": "YYYY-MM-DD HH:MM:SS", "summary": "日程标题", "attendees": [{"userid": "USER_ID"}], "reminders": {"is_remind": 1, "remind_before_event_secs": 3600, "timezone": 8}, "location": "会议地点"}}'`

## 返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | integer | 返回码，`0` 表示成功 |
| `errmsg` | string | 错误信息 |
| `schedule_id` | string | 创建成功的日程 ID |

## 响应示例

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "schedule_id": "SCHEDULE_ID"
}
```
