# 错误码说明
全产品错误参考 + 调试流程。Agent 遇到错误时查阅此文档。

## 错误返回格式

```json
{"success": false, "code": "InvalidParameter", "message": "baseId is required"}
{"success": false, "code": "AUTH_TOKEN_EXPIRED", "message": "Token验证失败"}
{"success": false, "code": "PermissionDenied", "message": "无权限访问该资源"}
```

## 错误分类与 Agent 行为

### 可自行修复
- 参数缺失 / 格式错误 / ID 无效 → 检查参数后修正重试

### 需用户介入
- 权限不足 / 资源不存在 / 配额超限 → 报告完整错误信息给用户，不要自行尝试替代方案

## 通用错误
- 请求超时 — 网络慢或服务端响应慢 → `--timeout 60` 重试
- 网络连接失败 — 无法连接 MCP Server → 用最简命令验证: `dws contact user get-self --format json`
- stderr 出现 `RECOVERY_EVENT_ID=<event_id>` — runtime 失败已被 CLI 捕获 → 优先执行 `dws recovery execute --event-id <event_id> --format json`

## Recovery 闭环

- `dws recovery plan --last|--event-id <event_id> --format json`：读取失败快照并生成恢复计划
- `dws recovery execute --last|--event-id <event_id> --format json`：生成带 `doc_search`、`probe_results`、`agent_task` 的分析包
- `dws recovery finalize --event-id <event_id> --outcome recovered|failed|handoff --execution-file execution.json --format json`：回写恢复结果

执行 `finalize` 时：

- `execution-file` 至少应包含 `actions`、`attempts`、`result`、`error_summary`
- 兼容旧格式：`action` + 数值型 `attempts`
- 若 recovery bundle 已进入 unknown/agent 路线，不要把 `human_actions` 视为最终结论；必须结合完整 bundle 判断

更多字段解释见 [recovery-guide.md](./recovery-guide.md)。

---

## aitable 高频错误

> 参数体系: `baseId / tableId / fieldId / recordId`。CLI flag 用 kebab-case（`--base-id`），JSON 内用 camelCase（`baseId`）。

- 参数缺失 / 无效请求 — 还在用旧参数 `dentryUuid` / `--doc` / `--sheet` → 改用 `--base-id` / `--table-id` / `--field-id` / `--record-ids`
- 参数传了但服务端没收到 — flag 用了 camelCase（如 `--baseId`）→ flag 用 kebab-case: `--base-id <ID>`
- `record query --filters` 无结果 — 单选/多选过滤用了 option name 而非 id → 先 `field get` 读取 options，用 option id 过滤
- record create/update 失败 — `cells` key 用了字段名（应为 fieldId）；特殊字段格式错误 → 先 `table get` 拿字段目录；url 传 `{"text":"..","link":".."}`
- 更新选项后历史数据异常 — 更新 options 没传完整列表 / 没保留原 id → 先 `field get` 取完整配置，保留已有 option 的 id
- `cannot delete the last table` — 该表是 Base 最后一张表 → 先新建表再删旧表，或用 `base delete`
- `formula` 类型 `not supported yet` — 部分字段类型暂不支持 API 创建 → 复杂字段拆开单独创建，先建基础结构

**排查链路**: `base list` → `base get`(→tableId) → `table get`(→fieldId) → `record query`(→recordId)。别跳步，别猜 ID。

**批量上限**: record 100 条 / field 15 个 / table·field 详情 10 个。

---

## approval 高频错误

- approve/reject 缺少 taskId — 未先获取审批任务 → 先 `approval tasks --instance-id <ID>` 获取 taskId
- list-initiated 缺少 processCode — 未查询审批表单 → 先 `approval list-forms` 获取 processCode
- 撤销审批失败 — 非本人发起的审批 → `revoke` 只能撤销自己发起的审批

---

## chat 高频错误

- 参数互斥报错 — `--group` 与 `--users` 同时传入 → 群聊用 `--group`，单聊用 `--users`，二者互斥
- 群不存在 — openConversationId 不正确 → `chat search --query "群名"` 获取正确 ID
- 机器人无法添加到群 — 当前用户非群管理员 → 报告给用户，需群管理员操作
- Webhook Token 无效 — token 不正确或已失效 → 确认 Webhook Token 来源正确
- 添加/移除群成员失败 — userId 不正确或无权限 → 先 `contact user search` 确认 userId，需当前用户为群管理员

---

## calendar 高频错误

- 时间格式错误 — 未使用 ISO-8601 格式 → 标准格式: `2026-03-10T14:00:00+08:00`
- 会议室搜索报错 / 返空 — 企业会议室超 100 条未分组查询 → 先 `room list-groups` → 按 `--group-id` 逐组搜索
- 参与者 / 会议室添加失败 — eventId 不正确 → 先 `event list` 或 `event create` 获取正确 eventId

---

## contact 高频错误

- `dept list-children` 报错 — `--id` 传了非整数值 → deptId 必须为整数，从 `dept search` 获取

---

## 通用排查三步法

1. **确认 ID** — 从最顶层资源逐级获取，不猜 ID、不跳步
2. **确认参数** — flag 用 kebab-case，JSON 用 camelCase；特殊字段查产品参考文档确认格式
3. **确认限制** — 检查批量上限和已知约束（各产品注意事项见对应产品参考文档）
