# smartpage_create API

创建智能主页。支持传入多个子页面，每个子页面可指定标题、内容类型和文件路径。创建成功后返回文档访问链接和 docid。

## 技能定义

```json
{
    "name": "smartpage_create",
    "description": "创建智能主页。支持传入标题和多个子页面配置，每个子页面可指定标题、内容类型（Text/Markdown）和本地文件路径。创建成功后返回 docid 和 url（docid 仅在创建时返回，需妥善保存）。",
    "inputSchema": {
        "properties": {
            "title": {
                "description": "智能主页标题",
                "title": "Title",
                "type": "string"
            },
            "pages": {
                "description": "子页面列表",
                "title": "Pages",
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "page_title": {
                            "description": "子页面标题",
                            "title": "Page Title",
                            "type": "string"
                        },
                        "content_type": {
                            "description": "内容类型。1: Markdown（包含Markdown语法的内容），0: Text（纯文本，不含任何Markdown语法）",
                            "enum": [0, 1],
                            "default": 1,
                            "title": "Content Type",
                            "type": "integer"
                        },
                        "page_filepath": {
                            "description": "子页面内容对应的本地文件路径",
                            "title": "Page Filepath",
                            "type": "string"
                        }
                    }
                }
            }
        },
        "required": ["pages"],
        "title": "smartpage_createArguments",
        "type": "object"
    }
}
```

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| title | string | 否 | 智能主页标题 |
| pages | array | 是 | 子页面列表 |
| pages[].page_title | string | 否 | 子页面标题 |
| pages[].content_type | integer | 否 | 内容类型：1-Markdown，0-Text（纯文本）。**默认应传 1**，仅纯文本内容才传 0 |
| pages[].page_filepath | string | 否 | 子页面内容对应的本地文件路径 |

## ContentType 枚举

| 值 | 含义 | 适用场景 |
|---|---|---|
| 1 | Markdown | 文件内容包含 Markdown 语法（标题、列表、链接、代码块等） |
| 0 | Text（纯文本） | 文件内容为纯文本，不含任何 Markdown 语法 |


## 请求示例

```json
{
    "title": "项目概览",
    "pages": [
        {
            "page_title": "需求文档",
            "content_type": 1,
            "page_filepath": "/path/to/requirements.md"
        },
        {
            "page_title": "设计说明",
            "content_type": 1,
            "page_filepath": "/path/to/design.md"
        }
    ]
}
```

## 响应示例

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "docid": "DOCID",
    "url": "https://doc.weixin.qq.com/smartpage/a1_xxxxxx"
}
```

## 注意事项

- 响应透传 mcp 回包
- `docid` 仅在创建时返回，后续无法再获取，务必保存
- `page_filepath` 指向本地文件，需确保文件存在且可读
- **`content_type` 必须与文件实际内容格式匹配**：`.md` 文件或包含 Markdown 语法的内容必须传 `1`，不要传 `0`
- 每个子页面的 Markdown 文件大小不得超过 **10MB**，超过会导致创建失败；如果文件过大，需先拆分为多个子页面
