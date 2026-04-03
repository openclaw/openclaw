---
name: wecom-get-todo-detail
description: 企业微信待办详情批量查询技能，根据待办 ID 列表获取完整信息（包含待办内容和分派人）。在用户说"看看这个待办的详情"、"待办内容是什么"、"这个待办分派给谁了"、"告诉我待办的具体信息"等需要查看待办完整内容的场景时使用。通常配合 wecom-get-todo-list 使用——先获取待办 ID 列表，再用本技能获取详情。
---

# 企业微信待办详情查询技能

> `wecom_mcp` 是一个 MCP tool，所有操作通过调用该 tool 完成。

> ⚠️ **前置条件**：首次调用 `wecom_mcp` 前，必须按 `wecom-preflight` 技能执行前置条件检查，确保工具已加入白名单。

通过 `wecom_mcp` tool 根据待办 ID 列表批量查询完整详情，包含待办内容和分派人信息。

## 行为策略

**人员 ID 转姓名（关键步骤）**: 返回结果中的 `follower_id` 和 `creator_id` 都是系统内部 ID，直接展示给用户毫无意义——用户不认识这些 ID，只认识姓名。因此在向用户展示待办详情之前，必须先调用 `wecom-contact-lookup` 技能获取通讯录，将所有 `follower_id` 和 `creator_id` 匹配为真实姓名。具体做法：

使用 `wecom_mcp` tool 调用 `wecom_mcp call contact get_userlist '{}'` 获取通讯录，在返回的 userlist 中，用 userid 字段匹配 follower_id / creator_id，取对应的 name。

如果通讯录中找不到某个 ID，展示时标注"未知用户(ID: xxx)"即可。

**重试策略**: 遭遇"返回 HTTP 错误"或"HTTP 请求失败"时，主动重试，最多重试三次。

---

## 调用方式

使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_detail '<json格式的入参>'`

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `todo_id_list` | array | ✅ | 待办 ID 列表，最多 20 个 |

**调用示例：**

使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_detail '{"todo_id_list": ["TODO_ID_1", "TODO_ID_2"]}'`

## 返回格式

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "data_list": [
        {
            "todo_id": "TODO_ID",
            "todo_status": 1,
            "content": "完成Q2规划文档",
            "follower_list": {
                "followers": [
                    {
                        "follower_id": "FOLLOWER_ID",
                        "follower_status": 1,
                        "update_time": "2025-01-16 14:20:00"
                    }
                ]
            },
            "creator_id": "CREATOR_ID",
            "user_status": 1,
            "remind_time": "2025-06-01 09:00:00",
            "create_time": "2025-01-15 10:30:00",
            "update_time": "2025-01-16 14:20:00"
        }
    ]
}
```

## 返回字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `data_list` | array | 待办详情列表，最多 20 条 |
| `data_list[].todo_id` | string | 待办 ID |
| `data_list[].todo_status` | number | 待办状态：`0`-已完成，`1`-进行中，`2`-已删除 |
| `data_list[].content` | string | 待办内容 |
| `data_list[].follower_list.followers` | array | 分派人列表 |
| `data_list[].follower_list.followers[].follower_id` | string | 分派人 ID（即 userid）— **展示前需通过 wecom-contact-lookup 转为姓名** |
| `data_list[].follower_list.followers[].follower_status` | number | 分派人状态：`0`-拒绝，`1`-接受，`2`-已完成 |
| `data_list[].follower_list.followers[].update_time` | string | 分派人状态更新时间 |
| `data_list[].creator_id` | string | 创建人 ID — **展示前需通过 wecom-contact-lookup 转为姓名** |
| `data_list[].user_status` | number | 当前用户状态 |
| `data_list[].remind_time` | string | 提醒时间 |
| `data_list[].create_time` | string | 创建时间 |
| `data_list[].update_time` | string | 更新时间 |

---

## 典型工作流

### 列表 + 详情联合查询（三步缺一不可）

用户问："看看我最近的待办" / "我有哪些待办事项？"

1. 第一步：通过 wecom-get-todo-list 获取待办列表。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_list '{}'`
2. 第二步：根据返回的 todo_id 批量获取详情。使用 `wecom_mcp` tool 调用 `wecom_mcp call todo get_todo_detail '{"todo_id_list": ["TODO_ID_1", "TODO_ID_2", "TODO_ID_3"]}'`
3. 第三步（不要跳过！）：通过 wecom-contact-lookup 获取通讯录，将 follower_id / creator_id 转为姓名。用返回的 userlist 中的 userid 匹配 follower_id 和 creator_id，取 name 字段作为展示姓名

> 第三步是展示可读结果的前提。没有这一步，用户看到的是一串无意义的 ID 而非姓名。

**展示格式（注意：分派人和创建人必须显示为姓名，不是 ID）：**

```
📋 您当前的待办事项（共 3 项）

1. 🔵 完成Q2规划文档
   - 待办状态：进行中 | 我的状态：已接受
   - 提醒时间：2025-06-01 09:00
   - 分派人：张三、李四
   - 创建时间：2025-01-15

2. 🔵 提交周报
   - 待办状态：进行中 | 我的状态：已接受
   - 提醒时间：2025-03-17 18:00
   - 创建时间：2025-03-10

3. ☑️ 代码评审
   - 待办状态：已完成 | 我的状态：已完成
   - 创建时间：2025-03-01
```

---

## 注意事项

1. **人员 ID 必须转姓名**
   - 返回结果中的 `follower_id` 和 `creator_id` 是系统内部标识，用户无法识别
   - 展示待办详情前，先使用 `wecom_mcp` tool 调用 `wecom_mcp call contact get_userlist '{}'` 获取通讯录
   - 用通讯录的 `userid` 匹配 `follower_id` / `creator_id`，用 `name` 替换展示

2. **todo_id 来源规则**
   - `todo_id` 必须来自 `wecom-get-todo-list` 返回的结果，禁止自行推测或构造
   - 用户通常提供待办内容描述而非 ID，应先通过 `wecom-get-todo-list` 查列表再匹配

3. **状态值含义**
   - 待办状态（`todo_status`）：`0`-已完成，`1`-进行中，`2`-已删除
   - 用户状态（`user_status`）：`0`-拒绝，`1`-接受，`2`-已完成
   - 分派人状态（`follower_status`）：`0`-拒绝，`1`-接受，`2`-已完成

4. **错误处理**：若 `errcode` 不为 `0`，告知用户 `errmsg` 中的错误信息

5. **单次上限**：`todo_id_list` 最多传 20 个 ID，超过需要分批请求
