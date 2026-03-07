---
name: feishu-groups
description: |
  列出飞书机器人所在的群组。发送群消息前先查群 ID 和名称。
  当用户提到查群、列出群组、发群消息等意图时激活。
---

# 飞书群组列表

## 功能

### 1. 列出机器人所在的群

```typescript
import { listGroupsOrSync } from "./src/groups.js";
const result = await listGroupsOrSync({ cfg, accountId });
if ("error" in result) {
  console.log(result.error); // 包含权限开启链接
} else {
  for (const g of result.results) {
    console.log(`${g.name} → ${g.chat_id}`);
  }
}
```

### 2. 按名称搜索群

```typescript
import { searchGroupsLocal } from "./src/groups.js";
const groups = searchGroupsLocal("项目");
```

### 3. 自动同步

本地缓存为空时，自动从飞书 API 拉取群列表并缓存。

## 使用场景

发送群消息前，先调用此 skill 让用户确认目标群：

1. `listGroupsOrSync()` → 列出所有群
2. 用户确认目标群 → 拿到 `chat_id`
3. 用 `feishu-send` skill 发消息

## 权限要求

| Scope              | 说明       | 开启链接                                                  |
| ------------------ | ---------- | --------------------------------------------------------- |
| `im:chat:readonly` | 获取群信息 | `https://open.feishu.cn/app/<APP_ID>/security/permission` |

## 数据存储

SQLite 数据库：`~/.openclaw/data/feishu-contacts.db`（与联系人共享）

```sql
groups (chat_id, name, description, owner_id, member_count)
```
