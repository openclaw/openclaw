# smartpage_export_task API

发起智能主页内容导出任务。该接口为异步操作的第一步，调用后返回 `task_id`，需配合 `smartpage_get_export_result` 轮询获取导出结果。

## 技能定义

```json
{
    "name": "smartpage_export_task",
    "description": "发起智能主页内容导出任务（异步）。传入 docid 和 content_type，返回 task_id。需配合 smartpage_get_export_result 轮询查询导出进度，直到任务完成后获取导出文件路径。",
    "inputSchema": {
        "properties": {
            "docid": {
                "description": "智能主页的 docid，由 smartpage_create 返回",
                "title": "Doc ID",
                "type": "string"
            },
            "content_type": {
                "description": "导出内容格式。0: Text，1: Markdown",
                "enum": [0, 1],
                "title": "Content Type",
                "type": "integer"
            }
        },
        "required": ["docid", "content_type"],
        "title": "smartpage_export_taskArguments",
        "type": "object"
    }
}
```

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| docid | string | 是 | 智能主页的 docid |
| content_type | integer | 是 | 导出内容格式：0-Text，1-Markdown |

## 请求示例

```json
{
    "docid": "DOCID",
    "content_type": 1
}
```

## 响应示例

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "task_id": "TASK_ID"
}
```

## 注意事项

- 这是异步操作的第一步，调用后仅返回 `task_id`
- 获取到 `task_id` 后，需调用 `smartpage_get_export_result` 轮询导出进度
- `content_type` 建议使用 `1`（Markdown）以获取可编辑的文本格式
