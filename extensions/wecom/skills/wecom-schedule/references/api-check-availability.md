# check_availability API

查询指定用户在某时间范围内的忙碌时段。

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `check_user_list` | array | ✅ | 用户 ID 列表，1~10 个 |
| `start_time` | string | ✅ | 查询开始时间 |
| `end_time` | string | ✅ | 查询结束时间 |

## 请求示例

使用 `wecom_mcp` tool 调用 `wecom_mcp call schedule check_availability '{"check_user_list": ["USER_ID_1", "USER_ID_2"], "start_time": "YYYY-MM-DD HH:MM:SS", "end_time": "YYYY-MM-DD HH:MM:SS"}'`

## 返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | integer | 返回码，`0` 表示成功 |
| `errmsg` | string | 错误信息 |
| `user_busy_list` | array | 用户忙碌时段列表 |

### user_busy_list[] 数组中每项字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `userid` | string | 用户 ID |
| `busy_slots` | array | 忙碌时段列表 |
| `busy_slots[].start_time` | string | 忙碌时段开始时间 |
| `busy_slots[].end_time` | string | 忙碌时段结束时间 |
| `busy_slots[].schedule_id` | string | 关联的日程 ID |
| `busy_slots[].subject` | string | 日程标题 |

## 响应示例

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "user_busy_list": [
        {
            "userid": "USER_ID",
            "busy_slots": [
                {
                    "start_time": "YYYY-MM-DD HH:MM:SS",
                    "end_time": "YYYY-MM-DD HH:MM:SS",
                    "schedule_id": "SCHEDULE_ID",
                    "subject": "日程标题"
                }
            ]
        }
    ]
}
```
