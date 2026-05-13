# 日志 (report) 命令参考

## 命令总览

### 获取日志模版列表
```
Usage:
  dws report template list [flags]
Example:
  dws report template list
```

### 获取日志模版详情
```
Usage:
  dws report template detail [flags]
Example:
  dws report template detail --name <templateName>
Flags:
      --name string   模版名称 (必填)
```

### 创建日志
```
Usage:
  dws report create [flags]
Example:
  dws report create --template-id <templateId> \
    --contents '[{"key":"今日完成","sort":"0","content":"完成了需求评审","contentType":"markdown","type":"1"}]' \
    --format json
  dws report create --template-id <templateId> \
    --contents '[{"key":"今日完成","sort":"0","content":"内容","contentType":"markdown","type":"1"}]' \
    --dd-from "script" --to-chat --to-user-ids "userId1,userId2" --format json
Flags:
      --template-id string   日志模版 ID (必填)，从 template list 返回中取
      --contents string      日志内容 JSON 数组 (必填)，每项须含 key/sort/content/contentType/type
      --dd-from string       创建来源标识 (默认 dws)
      --to-chat string       是否发送到日志接收人单聊 (传 "true" 发送)
      --to-user-ids string   接收人 userId，逗号分隔 (可选)
```

**`contents` 数组元素**（与 MCP `create_report` 一致）：

| 字段 | 说明 |
|------|------|
| `key` | 控件标题，与 template detail 一致 |
| `sort` | 控件排序，与 template detail 一致 |
| `content` | 填写值；文本类可写 Markdown |
| `contentType` | `type` 为文本 (`1`) 时用 `markdown`，其余类型用 `origin` |
| `type` | `1` 文本、`2` 数字、`3` 单选、`5` 日期、`7` 多选 |

shell 中传 `--contents` 时外层建议用**单引号**包住整段 JSON。

### 获取日志详情
```
Usage:
  dws report detail [flags]
Example:
  dws report detail --report-id <reportId>
Flags:
      --report-id string   日志 ID (必填)
```

### 日志收件箱列表
```
Usage:
  dws report list [flags]
Example:
  dws report list --start "2026-03-10T00:00:00+08:00" --end "2026-03-10T23:59:59+08:00" --cursor 0 --size 20
Flags:
      --cursor string   分页游标 (必填)
      --end string      结束时间 ISO-8601 (如 2026-03-10T23:59:59+08:00) (必填)
      --size string     每页大小 (必填)
      --start string    开始时间 ISO-8601 (如 2026-03-10T00:00:00+08:00) (必填)
```

### 获取日志统计数据
```
Usage:
  dws report stats [flags]
Example:
  dws report stats --report-id <reportId>
Flags:
      --report-id string   日志 ID (必填)
```

### 查询当前人创建的日志列表
```
Usage:
  dws report sent [flags]
Example:
  dws report sent --cursor 0 --size 20
  dws report sent --cursor 0 --size 20 --start "2026-03-10T00:00:00+08:00" --end "2026-03-10T23:59:59+08:00"
  dws report sent --cursor 0 --size 20 --template-name "日报"
Flags:
      --cursor string         分页游标，首次传 0 (默认 0)
      --size string           每页条数，最大 20 (默认 20)
      --start string          创建开始时间 ISO-8601 (默认最近 30 天)
      --end string            创建结束时间 ISO-8601 (默认最近 30 天)
      --modified-start string 修改开始时间 ISO-8601 (可选)
      --modified-end string   修改结束时间 ISO-8601 (可选)
      --template-name string  日志模版名称 (可选，不传查全部)
```

## 意图判断

用户说"查日志/看日报" → `list` 获取列表，再 `detail`
用户说"写日报/提交周报/发日志/填日志" → 先 `template list` / `template detail` 取 `templateId` 与各控件 `key`/`sort`/类型，拼 `--contents` JSON，再 `create`
用户说"日志统计/已读统计" → `stats`
用户说"有什么日志模版" → `template list` 或 `template detail`
用户说"我发过的日志/我创建的日志" → `sent`

关键区分: report(钉钉日志模版汇报，含创建) vs doc(文档编辑) vs todo(待办任务)

## 核心工作流

```bash
# 1. 获取当前用户可用的日志模版
dws report template list --format json

# 2. 按名称查看模版详情（含字段定义）
dws report template detail --name "日报" --format json

# 2b. 创建日志（从步骤 1/2 取 templateId 与 contents 字段）
dws report create --template-id <templateId> \
  --contents '[{"key":"今日完成","sort":"0","content":"完成了需求评审","contentType":"markdown","type":"1"}]' \
  --format json

# 3. 查看收件箱日志列表 — 提取 reportId
dws report list --start "2026-03-10T00:00:00+08:00" --end "2026-03-10T23:59:59+08:00" \
  --cursor 0 --size 20 --format json

# 4. 查看日志详情
dws report detail --report-id <reportId> --format json

# 5. 查看日志统计（已读/未读）
dws report stats --report-id <reportId> --format json

# 6. 查看当前人创建的日志列表
dws report sent --cursor 0 --size 20 --format json
```

## 上下文传递表

| 操作 | 从返回中提取 | 用于 |
|------|-------------|------|
| `template list` | template 名称 | template detail 的 --name |
| `template list` | `templateId`（或等价字段） | `create` 的 --template-id |
| `template detail` | 各控件 `key`、`sort`、类型 | 拼 `create` 的 --contents JSON（含 contentType/type） |
| `list` | `reportId` | detail / stats 的 --report-id |

## 注意事项

- `--start` / `--end` 使用 ISO-8601 格式（如 `2026-03-10T00:00:00+08:00`）
- `template list` 不需要参数，直接返回当前用户可用的所有日志模版
- `create` 前必须先查模版，勿猜测 `templateId` 或 `contents` 中的 `key`/`sort`；多控件时数组须覆盖模版必填项

## 自动化脚本

| 脚本 | 场景 | 用法 |
|------|------|------|
| [report_inbox_today.py](../../scripts/report_inbox_today.py) | 查看今天收到的日志列表及详情 | `python report_inbox_today.py` |
