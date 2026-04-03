---
name: wecom-doc-manager
description: 企业微信文档管理技能。提供文档和智能主页的创建、读取和编辑能力。支持通过 docid 或文档 URL 操作企业微信文档（doc_type=3）和智能表格（doc_type=10），以及创建智能主页和导出其内容。适用场景：(1) 以 Markdown 格式导出获取文档完整内容（异步轮询） (2) 新建文档或智能表格 (3) 用 Markdown 格式覆写文档内容 (4) 将本地 Markdown 文件创建为智能主页 (5) 异步导出智能主页内容为 Markdown 文件。当用户需要查看文档内容、创建新文档、编辑文档正文、创建智能主页、或获取智能主页内容时触发此 Skill。
---

# 企业微信文档管理

> `wecom_mcp` 是一个 MCP tool，所有操作通过调用该 tool 完成。

> ⚠️ **前置条件**：首次调用 `wecom_mcp` 前，必须按 `wecom-preflight` 技能执行前置条件检查，确保工具已加入白名单。

管理企业微信文档和智能主页的创建、读取和编辑。文档接口支持通过 `docid` 或 `url` 二选一定位文档。

## URL 品类识别与接口路由

企业微信文档有三种品类，**URL 格式不同，读取内容所用的接口也不同**，切勿混用：

| URL 模式 | 品类 | 读取内容接口 |
|---|---|---|
| `https://doc.weixin.qq.com/doc/*` | **文档**（doc_type=3） | `get_doc_content` |
| `https://doc.weixin.qq.com/smartsheet/*` | **智能表格**（doc_type=10） | `get_doc_content` |
| `https://doc.weixin.qq.com/smartpage/*` | **智能主页** | `smartpage_export_task` → `smartpage_get_export_result` |

**判断规则**：
- URL 路径以 `/doc/*` 开头 → 文档 → 用 `get_doc_content`
- URL 路径以 `/smartsheet/*` 开头 → 智能表格 → 用 `get_doc_content`
- URL 路径以 `/smartpage/*` 开头 → 智能主页 → 用 `smartpage_export_task`


## 调用方式

通过 `wecom_mcp` tool 调用，子工具名为 `doc`：

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc <tool_name> '<json_params>'` 调用指定技能

## 返回格式说明

所有接口返回 JSON 对象，包含以下公共字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | integer | 返回码，`0` 表示成功，非 `0` 表示失败 |
| `errmsg` | string | 错误信息，成功时为 `"ok"` |

当 `errcode` 不为 `0` 时，说明接口调用失败，可重试 1 次；若仍失败，将 `errcode` 和 `errmsg` 展示给用户。

### 特殊错误码

| errcode | errmsg | 含义 | 处理方式 |
|---------|--------|------|----------|
| `851002` | `incompatible doc type` | 文档品类与所调用的接口不匹配 | 换用另一种导出方式重试：若当前使用 `get_doc_content` 则改用 `smartpage_export_task`，若当前使用 `smartpage_export_task` 则改用 `get_doc_content` |

## 文档

适用品类：文档（doc_type=3）和智能表格（doc_type=10）
适用 URL：`/doc/*`、`/smartsheet/*`

适用场景：
1. 以 Markdown 格式导出获取文档完整内容（异步轮询）
2. 新建文档（doc_type=3）或智能表格（doc_type=10）
3. 用 Markdown 格式覆写文档内容

### get_doc_content

获取文档完整内容数据，只能以 Markdown 格式返回。采用**异步轮询机制**：首次调用无需传 `task_id`，接口返回 `task_id`；若 `task_done` 为 false，需携带该 `task_id` 再次调用，直到 `task_done` 为 true 时返回完整内容。

- 首次调用（不传 task_id）：使用 `wecom_mcp` tool 调用 `wecom_mcp call doc get_doc_content '{"docid": "DOCID", "type": 2}'`
- 轮询（携带上次返回的 task_id）：使用 `wecom_mcp` tool 调用 `wecom_mcp call doc get_doc_content '{"docid": "DOCID", "type": 2, "task_id": "xxx"}'`
- 或通过 URL：使用 `wecom_mcp` tool 调用 `wecom_mcp call doc get_doc_content '{"url": "https://doc.weixin.qq.com/doc/xxx", "type": 2}'`

参见 [API 详情](references/api-export-document.md)。

### create_doc

新建文档（doc_type=3）或智能表格（doc_type=10）。创建成功返回 url 和 docid。

- 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc create_doc '{"doc_type": 3, "doc_name": "项目周报"}'`
- 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc create_doc '{"doc_type": 10, "doc_name": "任务跟踪表"}'`

**注意**：docid 仅在创建时返回，需妥善保存。创建智能表格时默认包含一个子表，可通过 `smartsheet_get_sheet` 查询其 sheet_id。

参见 [API 详情](references/api-create-doc.md)。

### edit_doc_content

用 Markdown 内容覆写文档正文。`content_type` 固定为 `1`（Markdown）。

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc edit_doc_content '{"docid": "DOCID", "content": "# 标题\n\n正文内容", "content_type": 1}'`

参见 [API 详情](references/api-edit-doc-content.md)。

## 智能主页

适用品类：智能主页
适用 URL：`/smartpage/*`

适用场景：
1. 将本地 Markdown 文件创建为智能主页
2. 异步导出智能主页内容为 Markdown 文件

### smartpage_create

创建智能主页，支持传入标题和多个子页面。每个子页面可指定标题、内容类型和本地文件路径。响应透传 mcp 回包，返回 docid 和 url。

- 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartpage_create '{"title": "项目概览", "pages": [{"page_title": "需求文档", "content_type": 1, "page_filepath": "/path/to/requirements.md"}]}'`

**注意**：
- `content_type` **必须与文件实际内容匹配**：`.md` 文件或包含 Markdown 语法的内容必须传 `1`（Markdown），仅纯文本才传 `0`。绝大多数场景应传 `1`
- docid 仅在创建时返回，需妥善保存
- 每个子页面的 Markdown 文件大小不得超过 **10MB**，超过会导致创建失败。如果文件过大，需先拆分为多个子页面再创建

参见 [API 详情](references/api-smartpage-create.md)。

### smartpage_export_task

发起智能主页内容导出任务（异步）。传入 docid 和 content_type，返回 task_id。这是异步导出的第一步，需配合 `smartpage_get_export_result` 轮询获取导出结果。

- 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartpage_export_task '{"docid": "DOCID", "content_type": 1}'`

参见 [API 详情](references/api-smartpage-export-task.md)。

### smartpage_get_export_result

查询智能主页导出任务进度。传入 task_id 进行轮询，当 `task_done` 为 `true` 时返回 `content_filepath`（导出内容的本地文件路径）。

- 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartpage_get_export_result '{"task_id": "TASK_ID"}'`

当 `task_done` 为 `true` 时，使用 Read 工具读取 `content_filepath` 指向的文件即可获取导出的 Markdown 内容。

参见 [API 详情](references/api-smartpage-get-export-result.md)。

## 典型工作流

> **关键提示**：读取内容前先看 URL 判断品类。`/doc/` 或 `/smartsheet/` → `get_doc_content`；`/smartpage/` → `smartpage_export_task`。

1. **读取文档/智能表格内容**（URL 含 `/doc/` 或 `/smartsheet/`） → 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc get_doc_content '{"docid": "DOCID", "type": 2}'`，若 `task_done` 为 false 则携带 `task_id` 继续轮询
2. **创建新文档** → 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc create_doc '{"doc_type": 3, "doc_name": "文档名"}'`，保存返回的 docid
3. **编辑文档** → 先 get_doc_content 了解当前内容，再 edit_doc_content 覆写
4. **创建智能主页** → 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartpage_create '{"title": "标题", "pages": [{"page_title": "子页面", "content_type": 1, "page_filepath": "/path/to/file.md"}]}'`，保存返回的 docid
5. **获取智能主页内容**（URL 含 `/smartpage/`，异步两步）：
   - **第一步**：使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartpage_export_task '{"docid": "DOCID", "content_type": 1}'`，获取 `task_id`
   - **第二步**：使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartpage_get_export_result '{"task_id": "TASK_ID"}'`，若 `task_done` 为 `false` 则继续轮询，直到 `task_done` 为 `true`
   - **第三步**：使用 Read 工具读取 `content_filepath` 指向的本地文件，获取 Markdown 内容
