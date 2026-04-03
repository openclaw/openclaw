# create_doc API

新建文档、表格或智能表格。创建成功后返回文档访问链接和 docid。

## 技能定义

```json
{
    "name": "create_doc",
    "description": "新建文档、表格或智能表格。支持在指定空间和目录下创建，可设置文档管理员。创建成功后返回文档访问链接和 docid（docid 仅在创建时返回，需妥善保存）。注意：创建智能表格（doc_type=10）时，文档会默认包含一个子表，可通过 smartsheet_get_sheet 查询其 sheet_id，无需额外调用 smartsheet_add_sheet。",
    "inputSchema": {
        "properties": {
            "doc_type": {
                "description": "文档类型：3-文档，10-智能表格",
                "enum": [3, 10],
                "title": "Doc Type",
                "type": "integer"
            },
            "doc_name": {
                "description": "文档名字，最多 255 个字符，超过会被截断",
                "title": "Doc Name",
                "type": "string"
            }
        },
        "required": ["doc_type", "doc_name"],
        "title": "create_docArguments",
        "type": "object"
    }
}
```

## 请求示例

```json
{
    "doc_type": 3,
    "doc_name": "项目周报"
}
```

## 响应示例

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "url": "https://doc.weixin.qq.com/doc/xxx",
    "docid": "DOCID"
}
```

## 注意事项

- `doc_type=3` 创建普通文档
- `doc_type=10` 创建智能表格，默认包含一个子表
- docid 仅在创建时返回，后续无法再获取，务必保存
