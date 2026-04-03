---
name: wecom-get-todo-list
description: 企业微信待办列表查询技能，支持按创建时间和提醒时间过滤，支持分页。在用户说"看看我的待办列表"、"我有哪些待办"、"这周的待办有哪些"、"最近有什么待办"、"查一下我的待办"、"列出所有待办"等需要浏览待办概览的场景时使用。注意：此技能仅返回待办概要信息（不含内容和分派人），如需完整详情请配合 wecom-get-todo-detail 使用。
---

# 企业微信待办列表查询技能

> `wecom_mcp` 是一个 MCP tool，所有操作通过调用该 tool 完成。

> ⚠️ **前置条件**：首次调用 `wecom_mcp` 前，必须按 `wecom-preflight` 技能执行前置条件检查，确保工具已加入白名单。

通过 `wecom_mcp` tool 查询企业微信待办列表，支持按时间过滤和分页。

## 行为策略

**查完列表必须查详情**: 本接口只返回待办 ID 和状态等概要信息，不包含待办的实际内容和分派人。对用户来说，没有内容的待办列表毫无用处——他们想知道的是"要做什么"，而不是一串 ID。因此，每次调用 get_todo_list 拿到结果后，都要紧接着用返回的 todo_id 列表调用 `wecom-get-todo-detail` 获取完整详情（内容、分派人等），然后再向用户展示。这不是可选步骤，而是完成用户请求的必要环节。

**分页未拉完时必须提醒用户**: 接口是分页的，不要求一次性拉完所有数据。但如果响应中 `has_more` 为 `true`，说明后面还有待办没有返回——这时你在展示当前结果的同时，必须明确告诉用户"还有更多待办未显示，是否需要继续查看？"。用户可能不知道后面还有数据，如果你不说，他们会以为看到的就是全部，这会导致遗漏重要待办。这是一个容易被忽略但后果严重的点，请务必执行。

**重试策略**: 遭遇"返回 HTTP 错误"或"HTTP 请求失败"时，主动重试，最多重试三次。

---

## 调用方式

使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_list '<json格式的入参>'`

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `create_begin_time` | string | ❌ | 创建开始时间，格式：`YYYY-MM-DD HH:mm:ss` |
| `create_end_time` | string | ❌ | 创建结束时间，格式：`YYYY-MM-DD HH:mm:ss` |
| `remind_begin_time` | string | ❌ | 提醒开始时间，格式：`YYYY-MM-DD HH:mm:ss` |
| `remind_end_time` | string | ❌ | 提醒结束时间，格式：`YYYY-MM-DD HH:mm:ss` |
| `limit` | number | ❌ | 最大返回数量，默认 10，最大 20 |
| `cursor` | string | ❌ | 分页游标，首次请求不传，后续传入上次响应的 `next_cursor` |

## 返回格式

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "index_list": [
        {
            "todo_id": "TODO_ID",
            "todo_status": 1,
            "user_status": 1,
            "creator_id": "CREATOR_ID",
            "remind_time": "2025-06-01 09:00:00",
            "create_time": "2025-01-15 10:30:00",
            "update_time": "2025-01-16 14:20:00"
        }
    ],
    "next_cursor": "NEXT_CURSOR",
    "has_more": false
}
```

## 返回字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `index_list` | array | 待办列表 |
| `index_list[].todo_id` | string | 待办唯一 ID |
| `index_list[].todo_status` | number | 待办状态：`0`-已完成，`1`-进行中，`2`-已删除 |
| `index_list[].user_status` | number | 用户状态：`0`-拒绝，`1`-接受，`2`-已完成 |
| `index_list[].creator_id` | string | 创建人 ID |
| `index_list[].remind_time` | string | 提醒时间 |
| `index_list[].create_time` | string | 创建时间 |
| `index_list[].update_time` | string | 更新时间 |
| `next_cursor` | string | 下一页游标 |
| `has_more` | boolean | 是否还有更多记录 |

> 列表返回的是待办概要信息（不含内容和分派人）。拿到列表后，必须调用 `wecom-get-todo-detail` 获取完整详情再展示给用户。

---

## 典型工作流

### 查看待办列表（标准两步流程）

用户问："看看我最近的待办" / "我有哪些待办事项？" / "我还有多少事要做？"

1. 第一步：获取待办列表（只有 ID 和状态，没有内容）。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_list '{}'`
2. 第二步（禁止跳过！）：用返回的 todo_id 列表调用 wecom-get-todo-detail 获取完整详情。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_detail '{"todo_id_list": ["返回的TODO_ID_1", "返回的TODO_ID_2"]}'`

两步缺一不可——只有拿到详情后，才能向用户展示有意义的待办内容。

3. 第三步（条件执行）：检查第一步返回的 `has_more` 字段。如果为 `true`，在展示结果时必须提醒用户："以上是部分待办，还有更多待办未显示，需要我继续查看吗？"——不提醒的话，用户会以为这就是全部。

### 按时间范围查询

用户问："这个月创建的待办有哪些？"

使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_list '{"create_begin_time": "2025-03-01 00:00:00", "create_end_time": "2025-03-31 23:59:59"}'`

### 分页获取大量待办

当待办数量超过单页上限时，通过 `cursor` 循环分页拉取：

- 首次请求（不传 cursor）：使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_list '{"limit": 20}'`，如果没有拉取完，还有更多的待办，会返回 has_more=true, next_cursor="CURSOR_1"
- 第二次请求（传入上次的 next_cursor）：使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_list '{"limit": 20, "cursor": "CURSOR_1"}'`，返回 has_more=false，拉取完毕

**分页规则：**
- 首次请求不传 `cursor`
- `has_more` 为 `true` 时，将 `next_cursor` 作为下次请求的 `cursor` 传入
- `has_more` 为 `false` 时停止请求
- 分页过程中时间过滤参数保持不变
- **如果选择不继续翻页（比如当前页数据已经够用），必须告诉用户还有更多待办未显示，问用户是否需要继续查看**

---

## 注意事项

1. **时间格式**：所有时间参数使用 `YYYY-MM-DD HH:mm:ss` 格式，用户说"明天"、"下周一"等相对时间时，根据当前日期推算具体日期

2. **状态值含义**
   - 待办状态（`todo_status`）：`0`-已完成，`1`-进行中，`2`-已删除
   - 用户状态（`user_status`）：`0`-拒绝，`1`-接受，`2`-已完成

3. **错误处理**：若 `errcode` 不为 `0`，告知用户 `errmsg` 中的错误信息

4. **必须查详情**：本接口返回的是概要信息（不含内容和分派人），拿到列表后必须紧接着调用 `wecom-get-todo-detail` 获取完整内容再展示给用户，不要只展示列表概要

5. **分页未拉完必须提醒**：如果返回的 `has_more` 为 `true`，在向用户展示结果时必须明确说明"还有更多待办未显示"并询问用户是否需要继续查看。用户不知道后面还有数据，不提醒会导致遗漏
