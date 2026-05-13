# 工作台 (workbench) 命令参考

## 命令总览

### 查看所有工作台应用
```
Usage:
  dws workbench app list [flags]
Example:
  dws workbench app list
```
### 批量获取应用详情
```
Usage:
  dws workbench app get [flags]
Example:
  dws workbench app get --ids <APP_ID_1>,<APP_ID_2>
Flags:
      --ids string   应用 ID 列表 (必填)
```

## 意图判断

用户说"工作台有什么应用/看看应用" → `app list`
用户说"应用详情" → `app get` (需 appId)

## 核心工作流

```bash
# 查看所有应用 — 提取 appId
dws workbench app list --format json

# 获取应用详情
dws workbench app get --ids app1,app2 --format json
```
## 上下文传递表
| 操作 | 提取 | 用于 |
|------|------|------|
| `app list` | `appId` | app get 的 --ids |
