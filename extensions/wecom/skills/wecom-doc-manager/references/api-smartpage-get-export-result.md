# smartpage_get_export_result API

查询智能主页导出任务的执行进度。配合 `smartpage_export_task` 使用，通过轮询 `task_id` 获取导出结果。当 `task_done` 为 `true` 时，返回导出内容的本地文件路径。

## 技能定义

```json
{
    "name": "smartpage_get_export_result",
    "description": "查询智能主页导出任务进度。传入 task_id 轮询，当 task_done 为 true 时返回导出内容的本地文件路径 content_filepath，可通过读取该文件获取 Markdown 内容。",
    "inputSchema": {
        "properties": {
            "task_id": {
                "description": "导出任务 ID，由 smartpage_export_task 返回",
                "title": "Task ID",
                "type": "string"
            }
        },
        "required": ["task_id"],
        "title": "smartpage_get_export_resultArguments",
        "type": "object"
    }
}
```

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| task_id | string | 是 | 导出任务 ID，由 `smartpage_export_task` 返回 |

## 请求示例

```json
{
    "task_id": "TASK_ID"
}
```

## 响应示例

任务未完成：

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "task_done": false
}
```

任务完成：

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "task_done": true,
    "content_filepath": "/path/to/exported-content.md"
}
```

## 异步轮询机制

1. **调用 smartpage_export_task** 获取 `task_id`
2. **首次轮询**：传入 `task_id` 调用本接口
3. **检查响应**：若 `task_done` 为 `false`，继续轮询
4. **获取内容**：当 `task_done` 为 `true` 时，读取 `content_filepath` 指向的本地文件获取导出内容

## 注意事项

- `content_filepath` 仅在 `task_done` 为 `true` 时返回
- `content_filepath` 是本地文件路径，使用 Read 工具读取文件内容即可
- 如果轮询多次仍未完成，建议适当增加轮询间隔
