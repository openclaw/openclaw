# smartsheet_get_records API

查询智能表格中指定子表的记录信息。只支持获取全部记录。支持通过 docid 或文档 URL 定位文档，二者传入其一即可。

## 技能定义

```json
{
    "name": "smartsheet_get_records",
    "description": "查询智能表格中指定子表的记录信息。只支持获取全部记录。支持通过 docid 或文档 URL 定位文档，二者传入其一即可。",
    "inputSchema": {
        "properties": {
            "docid": {
                "description": "文档的 docid，与 url 二选一传入",
                "title": "Docid",
                "type": "string"
            },
            "url": {
                "description": "文档的访问链接，与 docid 二选一传入",
                "title": "URL",
                "type": "string"
            },
            "sheet_id": {
                "description": "子表的 sheet_id，用于指定要查询的智能表格中的哪个子表",
                "title": "Sheet Id",
                "type": "string"
            }
        },
        "oneOf": [
            { "required": ["docid", "sheet_id"] },
            { "required": ["url", "sheet_id"] }
        ],
        "title": "smartsheet_get_recordsArguments",
        "type": "object"
    }
}
```

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| docid | string | 与 url 二选一 | 文档的 docid |
| url | string | 与 docid 二选一 | 文档的访问链接 |
| sheet_id | string | 是 | 子表的 sheet_id，用于指定要查询的智能表格中的哪个子表 |

## 请求示例

```json
{
    "docid": "DOCID",
    "sheet_id": "123Abc"
}
```

```json
{
    "url": "https://doc.weixin.qq.com/smartsheet/xxx",
    "sheet_id": "123Abc"
}
```

