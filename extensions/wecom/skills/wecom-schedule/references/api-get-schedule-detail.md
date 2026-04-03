# get_schedule_detail API

通过日程 ID 批量获取日程详细信息。

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `schedule_id_list` | array | ✅ | 日程 ID 列表，1~50 个 |

## 请求示例

使用 `wecom_mcp` tool 调用 `wecom_mcp call schedule get_schedule_detail '{"schedule_id_list": ["SCHEDULE_ID_1", "SCHEDULE_ID_2"]}'`

## 返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | integer | 返回码，`0` 表示成功 |
| `errmsg` | string | 错误信息 |
| `schedule` | array | 日程详情列表 |

### schedule[] 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `schedule_id` | string | 日程唯一 ID |
| `summary` | string | 日程标题 |
| `description` | string | 日程描述 |
| `start_time` | integer | 开始时间（Unix 时间戳，秒） |
| `end_time` | integer | 结束时间（Unix 时间戳，秒） |
| `location` | string | 地点 |
| `status` | integer | `0`-正常，`1`-已取消 |
| `is_whole_day` | integer | `0`-否，`1`-是 |
| `admins` | array | 管理员 userid 列表 |
| `attendees` | array | 参与者列表 |
| `attendees[].userid` | string | 参与者 userid |
| `attendees[].response_status` | integer | 响应状态（见下表） |
| `reminders` | object | 提醒设置（见 [reminders 字段参考](ref-reminders.md)） |

### response_status 枚举

| 值 | 含义 |
|----|------|
| `1` | 待定 |
| `2` | 接受 |
| `3` | 接受单次 |
| `4` | 拒绝 |
| `5` | 接受本次及未来 |
| `6` | 待定单次 |
| `7` | 待定本次及未来 |
| `8` | 拒绝单次 |
| `9` | 拒绝本次及未来 |

## 响应示例

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "schedule": [
        {
            "schedule_id": "SCHEDULE_ID",
            "summary": "日程标题",
            "start_time": 1700000000,
            "end_time": 1700003600,
            "location": "会议室",
            "status": 0,
            "is_whole_day": 0,
            "attendees": [
                {"userid": "USER_ID","tmp_external_userid": "tmp_external_userid_example","response_status": 2}
            ],
            "reminders": {
                "is_remind": 1,
                "remind_before_event_secs": 3600,
                "timezone": 8
            }
        }
    ]
}
```
