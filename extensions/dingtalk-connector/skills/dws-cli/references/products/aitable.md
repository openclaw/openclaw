# AI表格 (aitable) 命令参考

## 文档地址 (URI)

所有 AI 表格操作完成后，可通过以下 URI 直接访问对应文档：

| 资源 | URI 格式 |
|------|----------|
| Base 文档 | `https://alidocs.dingtalk.com/i/nodes/{baseId}` |
| 模板预览 | `https://docs.dingtalk.com/table/template/{templateId}` |

> 💡 **操作后请返回文档 URI**：每次执行 base list/search/create/get 操作后，从返回数据中提取 `baseId`，拼接为 `https://alidocs.dingtalk.com/i/nodes/{baseId}` 返回给用户，方便直接点击打开。

## 命令总览

### base (Base 管理)

#### 获取 AI 表格列表
```
Usage:
  dws aitable base list [flags]
Example:
  dws aitable base list
  dws aitable base list --limit 5 --cursor NEXT_CURSOR
Flags:
      --cursor string   分页游标，首次不传
      --limit int       每页数量，默认 10，最大 10
```

返回 baseId 与 baseName。

> 📎 **操作后返回文档链接**：遍历返回的每个 base，拼接 `https://alidocs.dingtalk.com/i/nodes/{baseId}` 返回给用户。

> ⚠️ **注意**：`base list` 仅返回**最近访问过**的 Base，不是全部 Base。
> 新创建的 Base 如果尚未在钉钉前端打开过，可能不会出现在此列表中。
> 如需查找特定 Base，请使用 `base search`；如果刚创建完，直接使用 `create` 返回的 `baseId` 即可。

#### 搜索 AI 表格
```
Usage:
  dws aitable base search [flags]
Example:
  dws aitable base search --query "项目管理"
Flags:
      --cursor string   分页游标，首次不传
      --query string    Base 名称关键词，建议至少 2 个字符 (必填)
```

#### 获取 AI 表格信息
```
Usage:
  dws aitable base get [flags]
Example:
  dws aitable base get --base-id <BASE_ID>
Flags:
      --base-id string   Base 唯一标识 (必填)
```

返回 baseName、tables、dashboards 的 summary 信息（不含字段与记录详情）。
后续如需 tableId，优先从这里读取。

> 📎 **文档地址**：`https://alidocs.dingtalk.com/i/nodes/{baseId}`

#### 创建 AI 表格
```
Usage:
  dws aitable base create [flags]
Example:
  dws aitable base create --name "项目跟踪"
Flags:
      --name string          Base 名称，1-50 字符 (必填)
      --template-id string   模板 ID (可选，可通过 template search 获取)
```

> 💡 **创建后直接使用返回的 `baseId`**，无需再调用 `base list` 或 `base search` 查找。
> 后续可直接 `base get --base-id <返回的baseId>` 获取 tableId，或 `table create --base-id <返回的baseId>` 创建数据表。
>
> 📎 **文档地址**：`https://alidocs.dingtalk.com/i/nodes/{返回的baseId}`

#### 更新 AI 表格
```
Usage:
  dws aitable base update [flags]
Example:
  dws aitable base update --base-id <BASE_ID> --name "新名称"
Flags:
      --base-id string   目标 Base ID (必填)
      --desc string      备注文本
      --name string      新名称，1-50 字符 (必填)
```

#### 删除 AI 表格
```
Usage:
  dws aitable base delete [flags]
Example:
  dws aitable base delete --base-id <BASE_ID> --yes
Flags:
      --base-id string   待删除 Base ID (必填)
      --reason string    删除原因
```

高风险操作，不可逆。

### table (数据表管理)

#### 获取数据表
```
Usage:
  dws aitable table get [flags]
Example:
  dws aitable table get --base-id <BASE_ID>
  dws aitable table get --base-id <BASE_ID> --table-ids tbl1,tbl2
Flags:
      --base-id string     所属 Base ID (必填)
      --table-ids string   Table ID 列表，逗号分隔，单次最多 10 个
```

返回 tableId、tableName、description、fields 目录、views 目录。不传 table-ids 返回全部表。

> 📎 **文档地址**：`https://alidocs.dingtalk.com/i/nodes/{baseId}`

#### 创建数据表
```
Usage:
  dws aitable table create [flags]
Example:
  dws aitable table create --base-id <BASE_ID> --name "任务表" \
    --fields '[{"fieldName":"任务名称","type":"text"},{"fieldName":"优先级","type":"singleSelect","config":{"options":[{"name":"高"},{"name":"中"},{"name":"低"}]}}]'
Flags:
      --base-id string   目标 Base ID (必填)
      --fields string    初始字段 JSON 数组，至少 1 个，单次最多 15 个 (必填)
      --name string      表格名称，1-100 字符 (必填)
```

> 💡 **创建后直接使用返回的 `tableId`**，无需再调 `table get` 查找。
> 后续可直接 `field create --table-id <返回的tableId>` 补充字段，或 `record create` 写入数据。
>
> 📎 **文档地址**：`https://alidocs.dingtalk.com/i/nodes/{baseId}`

#### 更新数据表
```
Usage:
  dws aitable table update [flags]
Example:
  dws aitable table update --base-id <BASE_ID> --table-id <TABLE_ID> --name "新表名"
Flags:
      --base-id string    所属 Base ID (必填)
      --name string       新表名 (必填)
      --table-id string   目标 Table ID (必填)
```

#### 删除数据表
```
Usage:
  dws aitable table delete [flags]
Example:
  dws aitable table delete --base-id <BASE_ID> --table-id <TABLE_ID> --yes
Flags:
      --base-id string    目标 Base ID (必填)
      --reason string     删除原因
      --table-id string   将被删除的 Table ID (必填)
```

不可逆。若为 Base 中最后一张表，删除会失败。

### field (字段管理)

#### 获取字段详情
```
Usage:
  dws aitable field get [flags]
Example:
  dws aitable field get --base-id <BASE_ID> --table-id <TABLE_ID>
  dws aitable field get --base-id <BASE_ID> --table-id <TABLE_ID> --field-ids fld1,fld2
Flags:
      --base-id string     Base ID (必填)
      --field-ids string   字段 ID 列表，逗号分隔，单次最多 10 个
      --table-id string    Table ID (必填)
```

返回字段的完整配置（含 options 等）。在 table get 拿到字段目录后，按需展开少量字段的完整配置。

#### 创建字段
```
Usage:
  dws aitable field create [flags]
Example:
  dws aitable field create --base-id <BASE_ID> --table-id <TABLE_ID> \
    --fields '[{"fieldName":"状态","type":"singleSelect","config":{"options":[{"name":"待办"},{"name":"进行中"},{"name":"已完成"}]}}]'
Flags:
      --base-id string    Base ID (必填)
      --fields string     待新增字段 JSON 数组，至少 1 个，单次最多 15 个 (必填)
      --table-id string   Table ID (必填)
```

允许部分成功，返回结果逐项标明成功/失败状态。

#### 更新字段
```
Usage:
  dws aitable field update [flags]
Example:
  dws aitable field update --base-id <BASE_ID> --table-id <TABLE_ID> --field-id <FIELD_ID> --name "新字段名"
  dws aitable field update --base-id <BASE_ID> --table-id <TABLE_ID> --field-id <FIELD_ID> --config '{"options":[{"name":"A"},{"name":"B"}]}'
Flags:
      --base-id string    Base ID (必填)
      --config string     字段配置 JSON (不修改时省略)
      --field-id string   Field ID (必填)
      --name string       新字段名称 (不修改时省略)
      --table-id string   Table ID (必填)
```

不可变更字段类型。更新 singleSelect/multipleSelect 的 options 时需传入完整列表，已有选项应回传原 id。

#### 删除字段
```
Usage:
  dws aitable field delete [flags]
Example:
  dws aitable field delete --base-id <BASE_ID> --table-id <TABLE_ID> --field-id <FIELD_ID> --yes
Flags:
      --base-id string    Base ID (必填)
      --field-id string   待删除字段 ID (必填)
      --table-id string   Table ID (必填)
```

不可逆。禁止删除主字段和最后一个字段。

### record (记录管理)

#### 查询记录
```
Usage:
  dws aitable record query [flags]
Example:
  dws aitable record query --base-id <BASE_ID> --table-id <TABLE_ID>
  dws aitable record query --base-id <BASE_ID> --table-id <TABLE_ID> --record-ids rec1,rec2
  dws aitable record query --base-id <BASE_ID> --table-id <TABLE_ID> --keyword "关键词" --limit 50
Flags:
      --base-id string      Base ID (必填)
      --cursor string       分页游标，首次不传
      --field-ids string    返回字段 ID 列表，逗号分隔，单次最多 100 个
      --filters string      结构化过滤条件 JSON
      --keyword string     全文关键词搜索
      --limit int           单次最大记录数，默认 100，最大 100
      --record-ids string   指定记录 ID 列表，逗号分隔，单次最多 100 个
      --sort string         排序条件 JSON 数组
      --table-id string     Table ID (必填)
```

两种模式: 按 ID 取（传 record-ids，忽略 filters/sort）或条件查（filters+sort+cursor 分页）。

filters 结构：`{"operator":"and|or","operands":[{"operator":"<op>","operands":["<fieldId>","<value>"]}]}`

> 💡 **singleSelect/multipleSelect 过滤**：filters 中可传 option id 或 option name，但建议优先用 **option id**（通过 `field get` 获取），更可靠。
> 写入时（record create/update）可直接传 option name。

> 💡 **减少响应体积**：字段较多时，用 `--field-ids` 仅返回需要的字段，可显著减少返回数据量。

#### 新增记录
```
Usage:
  dws aitable record create [flags]
Example:
  dws aitable record create --base-id <BASE_ID> --table-id <TABLE_ID> \
    --records '[{"cells":{"fldTextId":"文本内容","fldNumId":123}}]'
Flags:
      --base-id string    Base ID (必填)
      --records string    记录列表 JSON 数组，单次最多 100 条 (必填)
      --table-id string   Table ID (必填)
```

> ⚠️ **常见错误（严格避免）**：
> - **参数名是 `--records`**，不是 `--data`
> - **cells 的 key 必须是 fieldId**（如 `fldXXX`），**不是字段名称**（如 `"课程名称"`）
> - 必须先 `table get` 获取 fieldId，再写入记录

```bash
# 正确流程：先获取 fieldId
dws aitable table get --base-id <BASE_ID> --table-id <TABLE_ID> --format json
# 从返回中提取 fieldId（如 fldABC123）

# 再用 fieldId 写入记录
dws aitable record create --base-id <BASE_ID> --table-id <TABLE_ID> \
  --records '[{"cells":{"fldABC123":"Python入门"}}]' --format json
```

#### 更新记录
```
Usage:
  dws aitable record update [flags]
Example:
  dws aitable record update --base-id <BASE_ID> --table-id <TABLE_ID> \
    --records '[{"recordId":"recXXX","cells":{"fldStatusId":"已完成"}}]'
Flags:
      --base-id string    Base ID (必填)
      --records string    待更新记录 JSON 数组，单次最多 100 条 (必填)
      --table-id string   Table ID (必填)
```

只需传入需修改的字段，未传入的保持原值。每条记录必须含 recordId 和 cells。

#### 删除记录
```
Usage:
  dws aitable record delete [flags]
Example:
  dws aitable record delete --base-id <BASE_ID> --table-id <TABLE_ID> --record-ids rec1,rec2 --yes
Flags:
      --base-id string      Base ID (必填)
      --record-ids string   待删除记录 ID 列表，逗号分隔，最多 100 条 (必填)
      --table-id string     Table ID (必填)
```

不可逆。调用前建议先 record query 确认目标记录。

### attachment (附件管理)

> 🛑 **STOP — 不要使用钉盘 (drive) 上传！** 钉盘 fileId 无法写入 attachment 字段。必须使用以下流程。

#### 准备附件上传
```
Usage:
  dws aitable attachment upload [flags]
Example:
  dws aitable attachment upload --base-id <BASE_ID> --file-name report.xlsx --size 204800
  dws aitable attachment upload --base-id <BASE_ID> --file-name photo.png --size 1024 --mime-type image/png
Flags:
      --base-id string     Base ID (必填)
      --file-name string   文件名，必须含扩展名 (必填)
      --size int           文件大小（字节），>0 (必填)
      --mime-type string   MIME type（不传时根据扩展名推断）
```

#### 附件上传完整流程（推荐：使用脚本，2 步完成）

```bash
# 步骤 1: 使用脚本一键上传（内部自动完成 prepare + PUT）
python3 scripts/upload_attachment.py <BASE_ID> /path/to/report.pdf
# 输出: { "fileToken": "ft_xxx", "fileName": "report.pdf", "size": 204800 }

# 步骤 2: 在 record create/update 中使用 fileToken 写入
dws aitable record create --base-id <BASE_ID> --table-id <TABLE_ID> \
  --records '[{"cells":{"fldAttachId":[{"fileToken":"ft_xxx"}]}}]' --format json
```

> ⚠️ `uploadUrl` 有时效性（`expiresAt`），脚本会自动在获取后立即上传。

### template (模板搜索)

#### 搜索模板
```
Usage:
  dws aitable template search [flags]
Example:
  dws aitable template search --query "项目管理"
Flags:
      --cursor string   分页游标，首次不传
      --limit int       每页返回数量，默认 10，最大 30
      --query string    模板名称关键词 (必填)
```

返回 templateId 可用于 `base create --template-id`。

> 📎 **模板预览地址**：`https://docs.dingtalk.com/table/template/{templateId}`

## 意图判断

用户说"表格/多维表/AI表格":
- 查看/列表 → `base list`
- 搜索 → `base search`
- 详情 → `base get`
- 创建 → `base create`
- 修改 → `base update`
- 删除 → `base delete` [危险]

用户说"数据表/子表/table":
- 查看 → `table get`
- 创建 → `table create`
- 重命名 → `table update`
- 删除 → `table delete` [危险]

用户说"字段/列/column":
- 查看 → `field get`
- 添加 → `field create`
- 修改 → `field update`
- 删除 → `field delete` [危险]

用户说"记录/行/数据/row":
- 查看/搜索 → `record query`（先 `table get` 获取 fieldId）
- 添加/写入 → `record create`（先 `table get` 必须!）
- 修改/更新 → `record update`（需 recordId，先 `record query`）
- 删除 → `record delete` [危险]（需 recordId）

用户说"模板" → `template search`

关键区分: base=表格文件, table=数据表, field=列, record=行

## 核心工作流

```bash
# 1. 搜索/列出 Base — 提取 baseId
dws aitable base search --query "项目" --format json

# 2. 获取 Base 信息 — 提取 tableId
dws aitable base get --base-id <BASE_ID> --format json

# 3. 获取表结构 — 提取 fieldId
dws aitable table get --base-id <BASE_ID> --table-id <TABLE_ID> --format json

# 4. 查询记录
dws aitable record query --base-id <BASE_ID> --table-id <TABLE_ID> --format json

# 5. 新增记录 (cells 用 fieldId 作 key)
dws aitable record create --base-id <BASE_ID> --table-id <TABLE_ID> \
  --records '[{"cells":{"fldXXX":"值"}}]' --format json
```

## 上下文传递表

| 操作 | 从返回中提取 | 用于 |
|------|-------------|------|
| `base list/search` | `baseId` | 所有后续命令的 --base-id，拼接文档 URI |
| `base create` | `baseId` | 后续命令 + 文档 URI |
| `base get` | `tables[].tableId` | --table-id |
| `table get` | `fields[].fieldId` | record 操作的 cells key, field get/update/delete |
| `record query` | `recordId` | record update/delete |
| `template search` | `templateId` | base create --template-id，拼接模板预览 URI |

## 注意事项

- 所有操作使用 ID（baseId/tableId/fieldId/recordId），不使用名称
- records 的 cells key 是 fieldId，不是字段名称

### cells 写入/读取格式速查

| 字段类型 | 写入格式 | 读取返回格式 |
|---------|---------|------------|
| text | `"字符串"` | `"字符串"` |
| number | `123` | `"123"` |
| singleSelect | `"选项名"` 或 `{"id":"xxx"}` | `{"id":"xxx","name":"选项名"}` |
| multipleSelect | `["选项A","选项B"]` | `[{"id":"x","name":"选项A"},...]` |
| date | `"2026-03-13"` 或时间戳 | ISO 日期字符串 |
| checkbox | `true`/`false` | `true`/`false` |
| user | `[{"userId":"xxx"}]` | `[{"corpId":"xxx","userId":"xxx"}]` |
| attachment | `[{"fileToken":"ft_xxx"}]` ⚠️需先走 attachment upload 3步流程 | `[{"url":"...","filename":"...","size":N}]` |
| url | `{"text":"显示文本","link":"https://..."}` | 同写入 |
| richText | `{"markdown":"**加粗**"}` | `{"markdown":"..."}` |
| group | `[{"cid":"xxx"}]` (注意: key 是 cid，不是 openConversationId) | 同写入 |

- 详见 [field-rules.md](../field-rules.md) 和 [error-codes.md](../error-codes.md)
