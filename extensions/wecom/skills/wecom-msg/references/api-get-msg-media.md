# get_msg_media API

获取消息文件内容。根据文件 ID 自动下载文件到本地，返回本地文件路径、文件名称、类型、大小及内容类型。

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `media_id` | string | ✅ | 文件 ID，长度 1~256 |

## 请求示例

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg get_msg_media '{"media_id": "MEDIAID_xxxxxx"}'`

## 返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | Integer | 返回码，`0` 表示成功 |
| `errmsg` | String | 错误信息 |
| `media_item` | Object | 文件内容 |
| `media_item.media_id` | String | 文件 ID |
| `media_item.name` | String | 文件名称 |
| `media_item.type` | String | 文件类型，`image`-图片，`voice`-语音，`video`-视频，`file`-普通文件 |
| `media_item.local_path` | String | 文件下载后的本地路径 |
| `media_item.size` | Integer | 文件大小（字节） |
| `media_item.content_type` | String | 文件 MIME 类型，如 `image/png`、`application/pdf` 等 |

## 响应示例

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "media_item": {
        "media_id": "MEDIAID_xxxxxx",
        "name": "screenshot.png",
        "type": "image",
        "local_path": "xxx/yyy/screenshot.png",
        "size": 102400,
        "content_type": "image/png"
    }
}
```
