# edit_doc_content API

编辑（覆写）文档内容。

## 技能定义

```json
{
    "name": "edit_doc_content",
    "description": "编辑文档内容",
    "inputSchema": {
        "properties": {
            "docid": {
                "description": "文档 id，与 url 二选一传入",
                "title": "Docid",
                "type": "string"
            },
            "url": {
                "description": "文档的访问链接，与 docid 二选一传入",
                "title": "URL",
                "type": "string"
            },
            "content": {
                "description": "覆写的文档内容",
                "title": "Content",
                "type": "string"
            },
            "content_type": {
                "description": "内容类型格式。1:markdown",
                "enum": [1],
                "title": "Content Type",
                "type": "integer"
            }
        },
        "oneOf": [
            { "required": ["docid", "content", "content_type"] },
            { "required": ["url", "content", "content_type"] }
        ],
        "title": "edit_doc_contentArguments",
        "type": "object"
    }
}
```

## 请求示例

```json
{
    "docid": "DOCID",
    "content": "# 标题\n\n正文内容",
    "content_type": 1
}
```

## 响应示例

```json
{
    "errcode": 0,
    "errmsg": "ok"
}
```

## 注意事项

- `content_type` 当前仅支持 `1`（Markdown 格式）
- 此操作为**覆写**，会替换文档全部内容
- 建议先调用 `get_doc_content` 了解当前内容再编辑
