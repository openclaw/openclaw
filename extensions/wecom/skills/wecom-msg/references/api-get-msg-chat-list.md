# get_msg_chat_list API

获取指定时间范围内有消息的会话列表，支持分页查询。

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `begin_time` | string | ✅ | 拉取开始时间，格式：`YYYY-MM-DD HH:mm:ss` |
| `end_time` | string | ✅ | 拉取结束时间，格式：`YYYY-MM-DD HH:mm:ss` |
| `cursor` | string | ❌ | 分页游标，首次请求不传，后续传入上次响应的 `next_cursor`，最大长度 256 |

## 请求示例

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg get_msg_chat_list '{"begin_time": "2026-03-11 00:00:00", "end_time": "2026-03-17 23:59:59"}'`

分页请求：

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg get_msg_chat_list '{"begin_time": "2026-03-11 00:00:00", "end_time": "2026-03-17 23:59:59", "cursor": "NEXT_CURSOR"}'`

## 返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | integer | 返回码，`0` 表示成功 |
| `errmsg` | string | 错误信息 |
| `chats` | array | 会话列表 |
| `chats[].chat_id` | string | 会话 ID |
| `chats[].chat_name` | string | 会话名称 |
| `chats[].last_msg_time` | string | 最后一条消息时间，格式：`YYYY-MM-DD HH:mm:ss` |
| `chats[].msg_count` | integer | 消息数量 |
| `has_more` | boolean | 是否还有更多数据 |
| `next_cursor` | string | 分页游标，用于下一次请求 |

## 响应示例

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "chats": [
        {
            "chat_id": "CHAT_ID",
            "chat_name": "张三",
            "last_msg_time": "2026-03-17 15:30:45",
            "msg_count": 128
        },
        {
            "chat_id": "CHAT_ID_2",
            "chat_name": "项目讨论群",
            "last_msg_time": "2026-03-16 09:12:33",
            "msg_count": 56
        }
    ],
    "has_more": true,
    "next_cursor": "NEXT_CURSOR"
}
```
