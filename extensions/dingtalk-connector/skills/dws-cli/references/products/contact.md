# 通讯录 (contact) 命令参考

## 命令总览

### user (人员查询)

#### 获取当前用户信息
```
Usage:
  dws contact user get-self [flags]
Example:
  dws contact user get-self
```

#### 按关键词搜索用户
```
Usage:
  dws contact user search [flags]
Example:
  dws contact user search --keyword "张三"
Flags:
      --keyword string   搜索关键词 (必填)
```

#### 按手机号搜索用户
```
Usage:
  dws contact user search-mobile [flags]
Example:
  dws contact user search-mobile --mobile 13800138000
Flags:
      --mobile string   手机号 (必填)
```

#### 批量获取用户详情
```
Usage:
  dws contact user get [flags]
Example:
  dws contact user get --ids userId1,userId2
Flags:
      --ids string   用户 ID 列表，逗号分隔 (必填)
```

### dept (部门查询)

#### 搜索部门
```
Usage:
  dws contact dept search [flags]
Example:
  dws contact dept search --keyword "技术部"
Flags:
      --keyword string   搜索关键词 (必填)
```

#### 查看部门成员
```
Usage:
  dws contact dept list-members [flags]
Example:
  dws contact dept list-members --ids 12345,67890
Flags:
      --ids string   部门 ID 列表，逗号分隔 (必填)
```

## 意图判断

用户说"我是谁/我的信息" → `user get-self`
用户说"找人/搜人" → `user search`（按名字）或 `user search-mobile`（按手机号）
用户说"查用户详情" → `user get`（需 userId）
用户说"找部门/哪个部门" → `dept search`
用户说"部门有谁/部门成员" → `dept list-members`（需 deptId）

## 核心工作流

```bash
# 1. 查看自己的信息 — 提取 userId
dws contact user get-self --format json

# 2. 按名字搜索同事 — 提取 userId
dws contact user search --keyword "张三" --format json

# 3. 查看部门结构 — 提取 deptId
dws contact dept search --keyword "技术部" --format json

# 4. 查看部门成员
dws contact dept list-members --ids <deptId> --format json
```

## 上下文传递表

| 操作 | 提取 | 用于 |
|------|------|------|
| `user get-self/search` | `userId` | 其他产品中的 --users/--executor 参数 |
| `user get-self/search` | `orgAuthEmail` | mail message send 的 --to/--cc (跨产品) |
| `dept search` | `deptId` | dept list-members 的 --ids |

## 注意事项

- `user get-self` 是获取 userId 的最快方式，其他产品的 --users/--executor 都需要 userId
- `user get --ids` 和 `dept list-members --ids` 都支持批量查询，逗号分隔

## 自动化脚本

| 脚本 | 场景 | 用法 |
|------|------|------|
| [contact_dept_members.py](../../scripts/contact_dept_members.py) | 按部门名称搜索并列出所有成员 | `python contact_dept_members.py --keyword "技术部"` |
