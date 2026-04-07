---
name: wecom-edit-todo
description: 企业微信待办事项编辑技能，支持创建、更新、删除待办及变更用户处理进度状态。在用户说"帮我创建一个待办"、"把这个任务分派给张三"、"标记待办完成"、"删掉那个待办"、"帮我建个提醒"、"更新一下待办内容"、"把提醒时间改到下周"、"接受这个待办"、"拒绝这个待办"等需要对待办进行写操作的场景时使用。
---

# 企业微信待办事项编辑技能

> `wecom_mcp` 是一个 MCP tool，所有操作通过调用该 tool 完成。

> ⚠️ **前置条件**：首次调用 `wecom_mcp` 前，必须按 `wecom-preflight` 技能执行前置条件检查，确保工具已加入白名单。

通过 `wecom_mcp` tool 对企业微信待办事项进行写操作，支持四种操作：创建待办、更新待办、删除待办、变更用户状态。

## 行为策略

**重试策略**: 遭遇"返回 HTTP 错误"或"HTTP 请求失败"时，主动重试，最多重试三次。

---

## 操作

### 1. 创建待办

创建一个新的待办事项，可指定内容、分派人和提醒时间：

使用 `wecom_mcp` tool 调用 `wecom_mcp call todo create_todo '<json格式的入参>'`

**参数说明：**

需要遵循 “注意事项”中的格式要求：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content` | string | ✅ | 待办内容 |
| `follower_list` | object | ❌ | 分派人列表，格式见注意事项第 7 条 |
| `remind_time` | string | ❌ | 提醒时间，格式：`YYYY-MM-DD HH:mm:ss` |


**调用示例：**

使用 `wecom_mcp` tool 调用 `wecom_mcp call todo create_todo '{"content": "<待办的内容>", "remind_time": "2025-06-01 09:00:00"}'`

**返回格式：**

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "todo_id": "TODO_ID"
}
```

---

### 2. 更新待办

修改已有待办事项的内容、分派人、状态或提醒时间：

使用 `wecom_mcp` tool 调用 `wecom_mcp call todo update_todo '<json格式的入参>'`

**参数说明：**

需要遵循 “注意事项”中的格式要求：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `todo_id` | string | ✅ | 待办 ID |
| `content` | string | ❌ | 新的待办内容 |
| `follower_list` | object | ❌ | 新的分派人列表（全量替换，非追加），格式见注意事项第 7 条。若要新增分派人，需先查出现有分派人，合并后一起提交 |
| `todo_status` | number | ❌ | 新的待办状态：`0`-已完成，`1`-进行中。删除请使用 `delete_todo` |
| `remind_time` | string | ❌ | 新的提醒时间 |

**调用示例：**

使用 `wecom_mcp` tool 调用 `wecom_mcp call todo update_todo '{"todo_id": "TODO_ID", "content": "<待办的内容>", "remind_time": "2025-07-01 09:00:00"}'`

**返回格式：**

```json
{
    "errcode": 0,
    "errmsg": "ok"
}
```

---

### 3. 删除待办

删除指定的待办事项：

使用 `wecom_mcp` tool 调用 `wecom_mcp call todo delete_todo '<json格式的入参>'`

**参数说明：**

需要遵循 “注意事项”中的格式要求：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `todo_id` | string | ✅ | 待办 ID |

**调用示例：**

使用 `wecom_mcp` tool 调用 `wecom_mcp call todo delete_todo '{"todo_id": "TODO_ID"}'`

**返回格式：**

```json
{
    "errcode": 0,
    "errmsg": "ok"
}
```

> 删除操作不可撤销，执行前应向用户确认。
> 注意：`delete_todo` 与 `update_todo` 设置 `todo_status=2` 效果相同，优先使用 `delete_todo`。

---

### 4. 变更用户待办状态

更改当前用户在某个待办中的状态（拒绝/接受/已完成）：

使用 `wecom_mcp` tool 调用 `wecom_mcp call todo change_todo_user_status '<json格式的入参>'`

**参数说明：**

需要遵循 “注意事项”中的格式要求：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `todo_id` | string | ✅ | 待办 ID |
| `user_status` | number | ✅ | 用户状态：`0`-拒绝，`1`-接受，`2`-已完成 |

**调用示例：**

使用 `wecom_mcp` tool 调用 `wecom_mcp call todo change_todo_user_status '{"todo_id": "TODO_ID", "user_status": 2}'`

**返回格式：**

```json
{
    "errcode": 0,
    "errmsg": "ok"
}
```

---

## 典型工作流

### 创建待办并分派给同事

用户问："帮我创建一个待办，让张三下周一前完成需求文档"

1. 第一步：通过 wecom-contact-lookup 技能查询张三的 userid，在返回结果中筛选姓名为"张三"的成员，获取其 userid
2. 第二步：创建待办并分派，使用 `wecom_mcp` tool 调用 `wecom_mcp call todo create_todo '{"content": "<待办的内容>", "follower_list": {"followers": [{"follower_id": "zhangsan", "follower_status": 1}]}, "remind_time": "2025-03-24 09:00:00"}'`

> `follower_id` 必须来自 `wecom-contact-lookup` 技能的 `get_userlist` 接口返回的 `userid`，禁止自行猜测。若搜索结果有多个同名人员，需展示候选列表让用户确认。

### 标记待办完成

需要区分两种场景：**标记待办本身完成**（改 `todo_status`）和**标记我的参与状态为完成**（改 `user_status`）。

#### 场景 A：标记待办本身完成

用户问："把'完成Q2规划文档'这个待办标记为完成" / "关闭这个待办"

1. 第一步：通过 wecom-get-todo-list 获取待办列表，找到目标待办的 todo_id。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_list '{}'`
2. 第二步：通过 wecom-get-todo-detail 获取详情，确认是目标待办。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_detail '{"todo_id_list": ["TODO_ID"]}'`
3. 第三步：确认后，将待办状态改为已完成。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo update_todo '{"todo_id": "TODO_ID", "todo_status": 0}'`

#### 场景 B：标记我的参与状态为完成

用户问："我已经完成了这个待办" / "标记我的部分为完成"

1. 第一步：通过 wecom-get-todo-list 获取待办列表，找到目标待办的 todo_id。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_list '{}'`
2. 第二步：通过 wecom-get-todo-detail 获取详情，确认是目标待办。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_detail '{"todo_id_list": ["TODO_ID"]}'`
3. 第三步：确认后，变更当前用户的参与状态为已完成。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo change_todo_user_status '{"todo_id": "TODO_ID", "user_status": 2}'`

> **如何判断用户意图：** 如果用户说"标记完成"且该待办是自己创建的、没有其他分派人，通常指场景 A（标记待办本身完成）。如果该待办有多个参与人，用户可能只是想标记自己那部分完成（场景 B）。不确定时应向用户确认。

> 用户提供的是待办内容描述而非 ID，所以需要先通过 wecom-get-todo-list 和 wecom-get-todo-detail 查找再匹配。匹配到多个相似待办时，列出候选项让用户确认。

### 更新待办内容或提醒时间

用户问："把那个需求文档的待办提醒时间改到下周五"

1. 第一步：查找目标待办。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_list '{}'`，再使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_detail '{"todo_id_list": ["TODO_ID_1", "TODO_ID_2"]}'`
2. 第二步：确认目标后更新。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo update_todo '{"todo_id": "TODO_ID", "remind_time": "2025-03-28 09:00:00"}'`

### 删除待办

用户问："删掉'代码评审'那个待办"

1. 第一步：查找目标待办。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_list '{}'`，再使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_detail '{"todo_id_list": ["TODO_ID"]}'`
2. 第二步：向用户确认后删除。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo delete_todo '{"todo_id": "TODO_ID"}'`

> 删除前必须向用户确认，确认措辞示例："确认删除待办'代码评审'吗？删除后不可恢复。"

---

## 注意事项

1. **todo_id 来源规则**
   - `todo_id` 必须来自 `wecom-get-todo-list` 返回的结果，禁止自行推测或构造
   - 用户通常提供待办内容描述而非 ID，应先通过 wecom-get-todo-list 查列表再匹配
   - 若匹配到多个相似待办，展示候选列表让用户确认

2. **follower_id 来源规则**
   - `follower_id` 即 `userid`，必须通过 `wecom-contact-lookup` 技能的 `get_userlist` 接口获取
   - 禁止根据用户姓名自行猜测 userid
   - 若搜索结果有多个同名人员，展示候选列表让用户选择

3. **时间格式**
   - 所有时间参数使用 `YYYY-MM-DD HH:mm:ss` 格式
   - 用户说"明天"、"下周一"等相对时间时，根据当前日期推算具体日期

4. **状态值含义**
   - 待办状态（`todo_status`）：`0`-已完成，`1`-进行中，`2`-已删除
   - 用户状态（`user_status`）：`0`-拒绝，`1`-接受，`2`-已完成
   - 分派人状态（`follower_status`）：`0`-拒绝，`1`-接受，`2`-已完成

5. **破坏性操作确认**
   - 删除待办（`delete_todo`）前必须向用户确认
   - 变更状态为"拒绝"（`user_status=0`）前建议向用户确认

6. **错误处理**
   - 若 `errcode` 不为 `0`，说明接口调用失败，告知用户 `errmsg` 中的错误信息

7. **follower_list** 的格式（作为输入参数的时候）

    ```json
    "follower_list": {                    // 分派人列表
        "followers": [                    // 注意里面还有一层是 "followers"，它的value才是真正的列表数组
            {
                "follower_id": "FOLLOWER_ID",      // 分派人id
                "follower_status": 1              // 分派人状态：0-拒绝, 1-接受, 2-已完成
            }
        ]
    }
    ```
    > `follower_id` 即 userid，需要通过 `wecom-contact-lookup` 查询获取，禁止自行猜测或构造。

## 相关技能

- **获取待办列表**：`wecom-get-todo-list` — 查询待办概要列表，获取 todo_id
- **获取待办详情**：`wecom-get-todo-detail` — 根据 todo_id 获取完整内容
- **通讯录查询**：`wecom-contact-lookup` 的 `get_userlist` — 获取成员 userid，用于 `follower_id`
