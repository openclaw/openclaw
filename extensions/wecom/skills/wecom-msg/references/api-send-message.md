# send_message API

向单聊或群聊发送文本消息。

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `chat_type` | integer | ✅ | 会话类型，`1`-单聊，`2`-群聊 |
| `chatid` | string | ✅ | 会话 ID，单聊时为 userid，群聊时为群 ID，最大 256 字节 |
| `msgtype` | string | ✅ | 消息类型，目前仅支持 `text` |
| `text` | object | ✅ | 文本消息内容 |
| `text.content` | string | ✅ | 消息内容，最大 2048 字节 |

## 请求示例

单聊：

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg send_message '{"chat_type": 1, "chatid": "zhangsan", "msgtype": "text", "text": {"content": "hello world"}}'`

群聊：

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg send_message '{"chat_type": 2, "chatid": "wrxxxxxxxx", "msgtype": "text", "text": {"content": "大家好"}}'`

## 返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | integer | 返回码，`0` 表示成功 |
| `errmsg` | string | 错误信息 |

## 响应示例

```json
{
    "errcode": 0,
    "errmsg": "ok"
}
```
