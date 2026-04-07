# get_doc_content API

获取企业微信文档的完整内容数据，以 Markdown 格式返回。该接口采用异步轮询机制：首次调用无需传 task_id，接口会返回 task_id；若 task_done 为 false，需携带该 task_id 再次调用，直到 task_done 为 true 时返回完整内容。

## 技能定义

```json
{
    "name": "get_doc_content",
    "description": "获取企业微信文档的完整内容数据，以 Markdown 格式返回。该接口采用异步轮询机制：首次调用无需传 task_id，接口会返回 task_id；若 task_done 为 false，需携带该 task_id 再次调用，直到 task_done 为 true 时返回完整内容。",
    "inputSchema": {
        "properties": {
            "docid": {
                "description": "文档的 docid，与 url 二选一传入",
                "title": "Doc ID",
                "type": "string"
            },
            "url": {
                "description": "文档的访问链接，与 docid 二选一传入",
                "title": "URL",
                "type": "string"
            },
            "type": {
                "description": "内容返回格式。2: Markdown 格式",
                "enum": [2],
                "title": "Type",
                "type": "integer"
            },
            "task_id": {
                "description": "任务 ID，用于异步轮询。初次调用时不填，后续轮询时填写上次返回的 task_id",
                "title": "Task ID",
                "type": "string"
            }
        },
        "oneOf": [
            { "required": ["docid", "type"] },
            { "required": ["url", "type"] }
        ],
        "title": "get_doc_contentArguments",
        "type": "object"
    }
}
```

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| docid | string | 与 url 二选一 | 文档的 docid |
| url | string | 与 docid 二选一 | 文档的访问链接 |
| type | integer | 是 | 内容返回格式，固定传 `2`（Markdown 格式） |
| task_id | string | 否 | 任务 ID，初次调用不填，后续轮询时填写上次返回的 task_id |

## 异步轮询机制

1. **首次调用**：传入 `docid`/`url` 和 `type: 2`，不传 `task_id`
2. **检查响应**：若 `task_done` 为 `false`，记录返回的 `task_id`
3. **轮询调用**：携带 `task_id` 再次调用，直到 `task_done` 为 `true`
4. **获取内容**：当 `task_done` 为 `true` 时，`content` 字段包含完整的 Markdown 内容

## 请求示例

```json
// 首次调用
{
    "docid": "DOCID",
    "type": 2
}

// 轮询调用
{
    "docid": "DOCID",
    "type": 2,
    "task_id": "xxx"
}
```

## 响应示例

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "content": "# 文档标题\n\n文档正文内容...",
    "task_id": "xxxxx",
    "task_done": true
}
```
