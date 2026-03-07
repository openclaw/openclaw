---
name: feishu-contacts
description: |
  飞书联系人检索与同步。搜索不到时自动从飞书 API 拉取更新。
  当用户提到查找某人、查飞书 ID、联系人等意图时激活。
---

# 飞书联系人检索

## 功能

### 1. 模糊搜索联系人

按 姓名 / 英文名 / 邮箱 模糊匹配，返回 open_id、姓名、邮箱、部门等。

```typescript
import { searchContactsLocal } from "./src/contacts.js";
const results = searchContactsLocal("张三");
// → [{ open_id: "ou_xxx", name: "张三", email: "...", ... }]
```

### 2. 搜索 + 自动同步

本地搜不到时，自动从飞书通讯录 API 拉取全量联系人并缓存，然后重试搜索。

```typescript
import { searchContactsOrSync } from "./src/contacts.js";
const result = await searchContactsOrSync({ keyword: "张三", cfg, accountId });
if ("error" in result) {
  // 权限不足等错误，已包含开启链接
  console.log(result.error);
} else {
  console.log(result.results);
}
```

### 3. 手动触发同步

```typescript
import { syncContactsFromAPI } from "./src/contacts.js";
const result = await syncContactsFromAPI({ cfg, accountId });
```

## 权限要求

| Scope                        | 说明             | 开启链接                                                  |
| ---------------------------- | ---------------- | --------------------------------------------------------- |
| `contact:user.base:readonly` | 获取用户基本信息 | `https://open.feishu.cn/app/<APP_ID>/security/permission` |

权限不足时会返回上述链接，让用户到飞书开放平台开启。

## 数据存储

SQLite 数据库：`~/.openclaw/data/feishu-contacts.db`

```sql
contacts (open_id, name, en_name, email, mobile, department_name, job_title, status)
```
