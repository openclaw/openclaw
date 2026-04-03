---
name: wecom-smartsheet-schema
description: 企业微信智能表格结构管理技能。提供子表（Sheet）和字段（Field/列）的增删改查能力。适用场景：(1) 查询智能表格的子表列表 (2) 添加、更新、删除子表 (3) 查询子表的字段/列信息 (4) 添加、更新、删除字段/列。当用户需要管理智能表格的表结构、列定义、子表配置时触发此 Skill。支持通过 docid 或文档 URL 定位文档。
---

# 企业微信智能表格结构管理

> `wecom_mcp` 是一个 MCP tool，所有操作通过调用该 tool 完成。

> ⚠️ **前置条件**：首次调用 `wecom_mcp` 前，必须按 `wecom-preflight` 技能执行前置条件检查，确保工具已加入白名单。

管理智能表格的子表和字段（列）结构。所有接口支持通过 `docid` 或 `url` 二选一定位文档。

##  调用方式

通过 `wecom_mcp` tool 调用，品类为 `doc`：

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc <tool_name> '<json_params>'` 调用指定技能

## 返回格式说明

所有接口返回 JSON 对象，包含以下公共字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | integer | 返回码，`0` 表示成功，非 `0` 表示失败 |
| `errmsg` | string | 错误信息，成功时为 `"ok"` |

当 `errcode` 不为 `0` 时，说明接口调用失败，可重试 1 次；若仍失败，将 `errcode` 和 `errmsg` 展示给用户。

## 子表管理

### smartsheet_get_sheet

查询文档中所有子表信息，返回 sheet_id、title、类型等。

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_get_sheet '{"docid": "DOCID"}'`

### smartsheet_add_sheet

添加空子表。新子表不含视图、记录和字段，需通过其他接口补充。

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_add_sheet '{"docid": "DOCID", "properties": {"title": "新子表"}}'`

**注意**：新建智能表格文档默认已含一个子表，仅需多个子表时调用。

### smartsheet_update_sheet

修改子表标题。需提供 sheet_id 和新 title。

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_update_sheet '{"docid": "DOCID", "properties": {"sheet_id": "SHEETID", "title": "新标题"}}'`

### smartsheet_delete_sheet

永久删除子表，**操作不可逆**。

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_delete_sheet '{"docid": "DOCID", "sheet_id": "SHEETID"}'`

## 字段管理

### smartsheet_get_fields

查询子表的所有字段信息，返回 field_id、field_title、field_type。

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_get_fields '{"docid": "DOCID", "sheet_id": "SHEETID"}'`

### smartsheet_add_fields

向子表添加一个或多个字段。单个子表最多 150 个字段。

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_add_fields '{"docid": "DOCID", "sheet_id": "SHEETID", "fields": [{"field_title": "任务名称", "field_type": "FIELD_TYPE_TEXT"}]}'`

支持的字段类型参见 [字段类型参考](references/field-types.md)。

### smartsheet_update_fields

更新字段标题。**只能改名，不能改类型**（field_type 必须传原始类型）。field_title 不能更新为原值。

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_update_fields '{"docid": "DOCID", "sheet_id": "SHEETID", "fields": [{"field_id": "FIELDID", "field_title": "新标题", "field_type": "FIELD_TYPE_TEXT"}]}'`

### smartsheet_delete_fields

删除一列或多列字段，**操作不可逆**。field_id 可通过 `smartsheet_get_fields` 获取。

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_delete_fields '{"docid": "DOCID", "sheet_id": "SHEETID", "field_ids": ["FIELDID"]}'`

## 典型工作流

1. **了解表结构** → 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_get_sheet` → 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc smartsheet_get_fields`
2. **创建表结构** → `smartsheet_add_sheet` 添加子表 → `smartsheet_add_fields` 定义列
3. **修改表结构** → `smartsheet_update_fields` 改列名 / `smartsheet_delete_fields` 删列

