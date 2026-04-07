# get_message API

根据会话类型和会话 ID，拉取指定时间范围内的消息记录。支持文本、图片、文件、语音、视频类型消息。

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `chat_type` | integer | ✅ | 会话类型，`1`-单聊，`2`-群聊 |
| `chatid` | string | ✅ | 会话 ID，单聊时为 userid，群聊时为群 ID，最大 256 字节 |
| `begin_time` | string | ✅ | 拉取开始时间，格式：`YYYY-MM-DD HH:mm:ss`，仅支持请求时刻往前 **7 天**内 |
| `end_time` | string | ✅ | 拉取结束时间，格式：`YYYY-MM-DD HH:mm:ss`，必须 ≥ `begin_time` |
| `cursor` | string | ❌ | 分页游标，首次请求不传，后续传入上次响应的 `next_cursor`，最大 256 字节 |

## 请求示例

单聊：

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg get_message '{"chat_type": 1, "chatid": "zhangsan", "begin_time": "2026-03-17 09:00:00", "end_time": "2026-03-17 18:00:00"}'`

群聊：

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg get_message '{"chat_type": 2, "chatid": "wrxxxxxxxx", "begin_time": "2026-03-17 09:00:00", "end_time": "2026-03-17 18:00:00"}'`

分页请求：

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg get_message '{"chat_type": 1, "chatid": "zhangsan", "begin_time": "2026-03-17 09:00:00", "end_time": "2026-03-17 18:00:00", "cursor": "CURSOR_xxxxxx"}'`

## 返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | Integer | 返回码，`0` 表示成功 |
| `errmsg` | String | 错误信息 |
| `messages` | Array | 消息列表 |
| `messages[].userid` | String | 消息发送者的 userid |
| `messages[].send_time` | String | 消息发送时间（北京时间），格式：`YYYY-MM-DD HH:mm:ss` |
| `messages[].msgtype` | String | 消息类型，`text`-文本消息，`image`-图片消息，`file`-文件消息，`voice`-语音消息，`video`-视频消息 |
| `messages[].text` | Object | 文本消息内容，`msgtype` 为 `text` 时返回 |
| `messages[].text.content` | String | 消息内容 |
| `messages[].image` | Object | 图片消息内容，`msgtype` 为 `image` 时返回 |
| `messages[].image.media_id` | String | 图片的 media_id，可通过 `get_msg_media` 接口下载 |
| `messages[].image.name` | String | 图片文件名称 |
| `messages[].file` | Object | 文件消息内容，`msgtype` 为 `file` 时返回 |
| `messages[].file.media_id` | String | 文件的 media_id，可通过 `get_msg_media` 接口下载 |
| `messages[].file.name` | String | 文件名称 |
| `messages[].voice` | Object | 语音消息内容，`msgtype` 为 `voice` 时返回 |
| `messages[].voice.media_id` | String | 语音的 media_id，可通过 `get_msg_media` 接口下载 |
| `messages[].video` | Object | 视频消息内容，`msgtype` 为 `video` 时返回 |
| `messages[].video.media_id` | String | 视频的 media_id，可通过 `get_msg_media` 接口下载 |
| `next_cursor` | String | 分页游标，为空表示已拉取完毕 |

## 响应示例

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "messages": [
        {
            "userid": "zhangsan",
            "send_time": "2026-03-17 09:30:00",
            "msgtype": "text",
            "text": {
                "content": "你好"
            }
        },
        {
            "userid": "lisi",
            "send_time": "2026-03-17 09:35:00",
            "msgtype": "image",
            "image": {
                "media_id": "MEDIAID_xxxxxx",
                "name": "screenshot.png"
            }
        },
        {
            "userid": "zhangsan",
            "send_time": "2026-03-17 09:40:00",
            "msgtype": "file",
            "file": {
                "media_id": "MEDIAID_yyyyyy",
                "name": "report.pdf"
            }
        }
    ],
    "next_cursor": "CURSOR_xxxxxx"
}
```

## 非文本消息处理

当 `msgtype` 为 `image`、`file`、`voice`、`video` 时，消息体中包含 `media_id`。需要调用 [get_msg_media](api-get-msg-media.md) 接口获取文件的本地路径（`local_path`），再进行展示。