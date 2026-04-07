# update_schedule API

修改已有日程，只需传入需要修改的字段，未传字段保持不变。

## 参数说明（`schedule` 对象内）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `schedule_id` | string | ✅ | 目标日程 ID |
| `start_time` | string | ❌ | 开始时间 |
| `end_time` | string | ❌ | 结束时间 |
| `summary` | string | ❌ | 日程标题，最长 128 字 |
| `description` | string | ❌ | 日程描述，最长 1000 字 |
| `location` | string | ❌ | 地点，最长 128 字 |
| `is_whole_day` | integer | ❌ | 是否全天：`0`-否，`1`-是 |
| `attendees` | array | ❌ | 参与者列表，每项含 `userid` |
| `reminders` | object | ❌ | 提醒与重复设置（见 [reminders 字段参考](ref-reminders.md)） |

> 仅传需修改的字段，其余保持不变。
>
> ⚠️ **重要**：如果要把全天日程变成普通日程并修改时间，则一定要把 `is_whole_day` 设置为 `0`，否则日程仍会保持全天状态。

## 请求示例

使用 `wecom_mcp` tool 调用 `wecom_mcp call schedule update_schedule '{"schedule": {"schedule_id": "SCHEDULE_ID", "summary": "更新后的标题", "start_time": "YYYY-MM-DD HH:MM:SS", "end_time": "YYYY-MM-DD HH:MM:SS"}}'`

## 返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | integer | 返回码，`0` 表示成功 |
| `errmsg` | string | 错误信息 |
