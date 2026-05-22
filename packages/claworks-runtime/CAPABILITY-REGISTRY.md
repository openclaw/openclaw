# ClaWorks 能力注册表

> 自动生成于 2026-05-22

## 概览

| 指标                                  | 数值        |
| ------------------------------------- | ----------- |
| 已注册能力总数                        | **174**     |
| 已覆盖域数                            | **50 / 50** |
| 核心能力（core-capabilities.ts）      | 58          |
| 扩展能力（extension-capabilities.ts） | 116         |

---

## L0 系统生命维持（system.\*）

| 能力 ID             | 动词    | 说明                                                        |
| ------------------- | ------- | ----------------------------------------------------------- |
| system.health       | query   | 返回机器人健康状态与诊断报告                                |
| system.status       | query   | 返回机器人基础信息与运行时状态                              |
| system.version      | query   | 返回机器人版本信息（版本号、构建时间、运行时环境）          |
| system.stats        | query   | 返回运行时统计数据（Playbook 执行数、事件发布量、能力数量） |
| system.pack_list    | query   | 返回已加载的 Pack 列表（id、版本、playbooks 数量）          |
| system.learn        | acquire | 探测接口 schema，自动生成 Playbook 或注册新能力             |
| system.describe     | query   | 列出机器人所有已注册能力（自我介绍）                        |
| system.reload_packs | control | 从磁盘重新加载所有 Pack                                     |

小计：**8**

---

## L1 环境感知（environment.\*）

| 能力 ID                     | 动词    | 说明                                                        |
| --------------------------- | ------- | ----------------------------------------------------------- |
| environment.context         | query   | 返回当前时间、日历、地区等环境上下文                        |
| environment.profile         | query   | 返回当前部署环境画像（机器人角色、已连接接口、所在行业等）  |
| environment.scan            | acquire | 扫描当前环境（环境变量、文件系统、常见网络服务）            |
| environment.scan_envvars    | acquire | 扫描环境变量，发现 Token、API Key、数据库 URL               |
| environment.detect_services | acquire | 检测本地常见服务（飞书/MySQL/Redis/MQTT/OPC-UA 等）是否可达 |
| environment.learn_from_fs   | acquire | 扫描文件系统路径，将重要配置/文档/代码摘要写入知识库        |
| environment.web_search      | acquire | 搜索互联网获取信息，并可选写入知识库                        |

小计：**7**

---

## L2 知识库（kb.\*）

| 能力 ID            | 动词     | 说明                                          |
| ------------------ | -------- | --------------------------------------------- |
| kb.search          | retrieve | 在知识库中检索（支持 semantic=true 语义搜索） |
| kb.ingest          | acquire  | 将文本内容写入知识库                          |
| kb.status          | query    | 返回知识库统计与健康状态                      |
| kb.ingest_document | acquire  | 摄入长文档（自动按段落/标题分块）             |

小计：**4**

---

## L3 感知理解（perceive.\*）

| 能力 ID                   | 动词    | 说明                                       |
| ------------------------- | ------- | ------------------------------------------ |
| perceive.message          | acquire | 理解一条消息：提取意图、实体、情绪、优先级 |
| perceive.extract_entities | acquire | 从文本中提取结构化实体（工业实体支持）     |
| perceive.intent           | acquire | 理解消息意图并返回 suggested_capability    |
| perceive.classify         | acquire | 将文本分类到预定义类别之一                 |

小计：**4**

---

## L4 任务执行（task.\*）

| 能力 ID     | 动词      | 说明                         |
| ----------- | --------- | ---------------------------- |
| task.run    | compose   | 按名称触发一个 Playbook 任务 |
| task.status | query     | 查询 Playbook 运行状态       |
| task.create | compose   | 创建任务记录                 |
| task.update | transform | 更新任务状态                 |
| task.list   | retrieve  | 查询任务列表                 |
| task.assign | transform | 分配任务给执行人             |

小计：**6**

---

## L5 对象操作（object.\*）

| 能力 ID       | 动词      | 说明                     |
| ------------- | --------- | ------------------------ |
| object.create | transform | 在对象存储中创建实体     |
| object.query  | retrieve  | 查询对象存储中的实体列表 |
| object.update | transform | 更新对象存储中的实体字段 |

小计：**3**

---

## L6 事件（event.\*）

| 能力 ID       | 动词    | 说明                    |
| ------------- | ------- | ----------------------- |
| event.publish | deliver | 向 EventKernel 发布事件 |

小计：**1**

---

## L7 主动学习（learn.\*）

| 能力 ID             | 动词    | 说明                                |
| ------------------- | ------- | ----------------------------------- |
| learn.observe       | acquire | 将一次观察（事件/现象）记录到知识库 |
| learn.from_feedback | acquire | 根据用户反馈更新知识库或调整行为    |

小计：**2**

---

## L8 自我进化（evolve.\*）

| 能力 ID               | 动词    | 说明                                   |
| --------------------- | ------- | -------------------------------------- |
| evolve.discover       | acquire | 主动发现环境中未被充分利用的接口或能力 |
| evolve.write_playbook | compose | 根据描述让 LLM 生成一个 Playbook YAML  |

小计：**2**

---

## L9 兜底消息（message.\*）

| 能力 ID        | 动词    | 说明                                |
| -------------- | ------- | ----------------------------------- |
| message.handle | compose | 兜底处理：对任何未知消息用 LLM 回答 |

小计：**1**

---

## 时间感知（time.\*）

| 能力 ID    | 动词      | 说明                                              |
| ---------- | --------- | ------------------------------------------------- |
| time.now   | query     | 返回当前时间（ISO格式、Unix时间戳、人类可读格式） |
| time.shift | query     | 返回当前班次（早/中/晚/夜），及下一班次信息       |
| time.parse | acquire   | 解析自然语言时间表达式为 ISO 格式                 |
| time.diff  | transform | 计算两个时间点之间的差值                          |

小计：**4**

---

## Prompt 模板（prompt.\*）

| 能力 ID       | 动词    | 说明                         |
| ------------- | ------- | ---------------------------- |
| prompt.list   | query   | 列出所有已注册的 Prompt 模板 |
| prompt.render | compose | 渲染 Prompt 模板，替换占位符 |

小计：**2**

---

## LLM 增强（llm.\*）

| 能力 ID                 | 动词    | 说明                                                  |
| ----------------------- | ------- | ----------------------------------------------------- |
| llm.structured_complete | compose | 调用 LLM 并保证输出符合 JSON schema（弱模型补偿核心） |

小计：**1**

---

## 机器人身份（robot.\*）

| 能力 ID            | 动词   | 说明                                          |
| ------------------ | ------ | --------------------------------------------- |
| robot.whoami       | query  | 机器人自我介绍（'我是谁？'）                  |
| robot.identity     | query  | 返回机器人完整身份信息                        |
| robot.owner        | query  | 返回机器人主人信息                            |
| robot.relations    | query  | 返回关系人列表                                |
| robot.add_relation | modify | 添加关系人（管理员权限）                      |
| robot.introduce    | query  | 生成完整的自我介绍卡片（Markdown + 能力列表） |

小计：**6**

---

## 机器人群（swarm.\*）

| 能力 ID         | 动词    | 说明                 |
| --------------- | ------- | -------------------- |
| swarm.discover  | acquire | 发现群内对等机器人   |
| swarm.sync_from | acquire | 从对等机器人同步数据 |
| swarm.announce  | deliver | 向群广播自身存在     |
| swarm.list      | query   | 列出已知对等机器人   |

小计：**4**

---

## OpenClaw Harness 同步（harness.\*）

| 能力 ID                    | 动词    | 说明                                        |
| -------------------------- | ------- | ------------------------------------------- |
| harness.detect_openclaw    | query   | 检测本机 OpenClaw 安装                      |
| harness.sync_from_openclaw | acquire | 从 OpenClaw 同步模型配置、技能和渠道信息    |
| harness.push_to_openclaw   | control | 向 OpenClaw Agent 注册 ClaWorks cw\_\* 工具 |
| harness.status             | query   | 查看 OpenClaw Harness 同步状态              |

小计：**4**

---

## 自动连接（connect.\*）

| 能力 ID           | 动词    | 说明                                       |
| ----------------- | ------- | ------------------------------------------ |
| connect.detect    | acquire | 检测环境中所有可用服务（IM/AI/数据库/IoT） |
| connect.recommend | query   | 生成连接建议（告诉用户缺少哪些配置）       |
| connect.status    | query   | 查看所有连接状态（已连接/未连接/建议）     |
| connect.apply     | control | 实际应用连接配置                           |

小计：**4**

---

## 推理规划（reasoning.\*）

| 能力 ID             | 动词    | 说明                         |
| ------------------- | ------- | ---------------------------- |
| reasoning.think     | compose | 深度思考并返回结构化思考链   |
| reasoning.decompose | compose | 将复杂任务分解为可执行子任务 |
| reasoning.evaluate  | compose | 评估方案或决策的可行性       |
| reason.chain        | compose | 链式调用多个能力，执行推理链 |

小计：**4**

---

## 记忆管理（memory.\*）

| 能力 ID              | 动词      | 说明                     |
| -------------------- | --------- | ------------------------ |
| memory.recall        | retrieve  | 从会话记忆中召回相关内容 |
| memory.consolidate   | transform | 将短期记忆整理为长期知识 |
| memory.list_sessions | retrieve  | 列出活跃会话列表         |
| memory.forget        | transform | 清除会话或 KB 条目记忆   |
| memory.case_search   | retrieve  | 搜索历史案例记录         |
| memory.case_record   | acquire   | 记录新的案例到案例库     |
| memory.case_outcome  | transform | 更新案例结果             |
| memory.search        | retrieve  | 在所有记忆层面搜索       |

小计：**8**

---

## 通信（comms.\*）

| 能力 ID               | 动词     | 说明                     |
| --------------------- | -------- | ------------------------ |
| comms.send            | deliver  | 向指定用户或渠道发送消息 |
| comms.broadcast       | deliver  | 向多个目标广播消息       |
| comms.history         | retrieve | 查询通信历史记录         |
| comms.throttle_status | query    | 查看消息发送频率限制状态 |

小计：**4**

---

## Agent 间通信（a2a.\*）

| 能力 ID           | 动词    | 说明                      |
| ----------------- | ------- | ------------------------- |
| a2a.discover      | acquire | 发现网络中的其他 Agent    |
| a2a.describe      | query   | 获取对等 Agent 的能力描述 |
| a2a.delegate      | compose | 委托任务给对等 Agent      |
| a2a.self_describe | query   | 返回本机器人的 A2A 描述   |
| a2a.send_task     | compose | 向指定对等 Agent 发送任务 |
| a2a.list_peers    | query   | 列出已知对等 Agent        |
| a2a.add_peer      | modify  | 添加对等 Agent            |

小计：**7**

---

## Pack 管理（pack.\*）

| 能力 ID      | 动词    | 说明              |
| ------------ | ------- | ----------------- |
| pack.list    | query   | 列出已安装的 Pack |
| pack.install | control | 安装新 Pack       |
| pack.reload  | control | 热重载 Pack       |

小计：**3**

---

## 连接器（connector.\*）

| 能力 ID          | 动词    | 说明                   |
| ---------------- | ------- | ---------------------- |
| connector.list   | query   | 列出所有连接器及状态   |
| connector.status | query   | 查询单个连接器状态     |
| connector.invoke | compose | 通过连接器调用外部接口 |

小计：**3**

---

## 调度（schedule.\*）

| 能力 ID         | 动词    | 说明               |
| --------------- | ------- | ------------------ |
| schedule.list   | query   | 列出所有定时任务   |
| schedule.add    | control | 注册 cron 定时任务 |
| schedule.remove | control | 移除定时任务       |

小计：**3**

---

## 监控（monitor.\*）

| 能力 ID        | 动词    | 说明                     |
| -------------- | ------- | ------------------------ |
| monitor.watch  | control | 监控指定 Playbook 或资源 |
| monitor.status | query   | 查看监控状态快照         |

小计：**2**

---

## Nexus（nexus.\*）

| 能力 ID        | 动词     | 说明                 |
| -------------- | -------- | -------------------- |
| nexus.search   | retrieve | 在 Pack 注册表中搜索 |
| nexus.describe | query    | 获取 Pack 的详细描述 |

小计：**2**

---

## 引导向导（guide.\*）

| 能力 ID              | 动词    | 说明             |
| -------------------- | ------- | ---------------- |
| guide.list_templates | query   | 列出所有引导模板 |
| guide.step           | compose | 执行引导步骤     |
| guide.fill_template  | compose | 填写模板字段     |

小计：**3**

---

## 行为准则（constitution.\*）

| 能力 ID                      | 动词    | 说明                 |
| ---------------------------- | ------- | -------------------- |
| constitution.describe        | query   | 返回当前行为准则描述 |
| constitution.check           | query   | 检查操作是否符合准则 |
| constitution.set_user_rule   | modify  | 设置用户级别规则     |
| constitution.record_feedback | acquire | 记录准则反馈         |

小计：**4**

---

## 对话上下文（context.\*）

| 能力 ID        | 动词      | 说明                   |
| -------------- | --------- | ---------------------- |
| context.append | modify    | 追加对话轮次到上下文   |
| context.get    | retrieve  | 获取会话上下文         |
| context.clear  | transform | 清除会话上下文         |
| context.list   | retrieve  | 列出所有活跃会话上下文 |

小计：**4**

---

## Hook（hook.\*）

| 能力 ID         | 动词    | 说明          |
| --------------- | ------- | ------------- |
| hook.register   | control | 注册事件 Hook |
| hook.unregister | control | 取消注册 Hook |
| hook.list       | query   | 列出所有 Hook |
| hook.enable     | control | 启用 Hook     |
| hook.disable    | control | 禁用 Hook     |

小计：**5**

---

## Provider（provider.\*）

| 能力 ID         | 动词  | 说明                      |
| --------------- | ----- | ------------------------- |
| provider.list   | query | 列出已配置的模型 Provider |
| provider.status | query | 查询 Provider 健康状态    |

小计：**2**

---

## 报告（report.\*）

| 能力 ID         | 动词     | 说明               |
| --------------- | -------- | ------------------ |
| report.generate | compose  | 生成报告           |
| report.list     | retrieve | 列出历史报告       |
| report.export   | compose  | 导出报告为指定格式 |

小计：**3**

---

## 审批（approval.\*）

| 能力 ID          | 动词      | 说明         |
| ---------------- | --------- | ------------ |
| approval.create  | compose   | 创建审批流程 |
| approval.get     | retrieve  | 获取审批详情 |
| approval.list    | retrieve  | 列出审批记录 |
| approval.approve | transform | 批准审批     |
| approval.reject  | transform | 驳回审批     |

小计：**5**

---

## 工单（work_order.\*）

| 能力 ID           | 动词      | 说明         |
| ----------------- | --------- | ------------ |
| work_order.create | compose   | 创建工单     |
| work_order.get    | retrieve  | 获取工单详情 |
| work_order.list   | retrieve  | 列出工单     |
| work_order.close  | transform | 关闭工单     |

小计：**4**

---

## 告警（alarm.\*）

| 能力 ID           | 动词      | 说明         |
| ----------------- | --------- | ------------ |
| alarm.acknowledge | transform | 确认告警     |
| alarm.list        | retrieve  | 列出活跃告警 |
| alarm.resolve     | transform | 解决告警     |

小计：**3**

---

## 通知路由（notify.\*）

| 能力 ID              | 动词    | 说明               |
| -------------------- | ------- | ------------------ |
| notify.dispatch      | deliver | 按通知路由分发消息 |
| notify.subscribe     | control | 订阅通知渠道       |
| notify.unsubscribe   | control | 取消订阅           |
| notify.preferences   | query   | 查询用户通知偏好   |
| notify.bind_subject  | control | 绑定通知主体       |
| notify.list_bindings | query   | 列出通知绑定关系   |

小计：**6**

---

## 班次管理（shift.\*）

| 能力 ID        | 动词    | 说明         |
| -------------- | ------- | ------------ |
| shift.start    | control | 开始班次     |
| shift.end      | control | 结束班次     |
| shift.handover | compose | 执行班次交接 |
| shift.current  | query   | 查询当前班次 |

小计：**4**

---

## 事件管理（incident.\*）

| 能力 ID         | 动词      | 说明         |
| --------------- | --------- | ------------ |
| incident.create | compose   | 创建事件记录 |
| incident.update | transform | 更新事件状态 |
| incident.list   | retrieve  | 列出事件     |
| incident.close  | transform | 关闭事件     |

小计：**4**

---

## 设备（equipment.\*）

| 能力 ID                 | 动词      | 说明         |
| ----------------------- | --------- | ------------ |
| equipment.status        | query     | 查询设备状态 |
| equipment.register      | control   | 注册设备     |
| equipment.list          | retrieve  | 列出设备     |
| equipment.update_status | transform | 更新设备状态 |

小计：**4**

---

## 维护（maintenance.\*）

| 能力 ID              | 动词      | 说明         |
| -------------------- | --------- | ------------ |
| maintenance.schedule | control   | 安排维护计划 |
| maintenance.complete | transform | 标记维护完成 |
| maintenance.list     | retrieve  | 列出维护记录 |

小计：**3**

---

## 生产（production.\*）

| 能力 ID           | 动词    | 说明         |
| ----------------- | ------- | ------------ |
| production.status | query   | 查询生产状态 |
| production.start  | control | 启动生产     |
| production.stop   | control | 停止生产     |

小计：**3**

---

## 安全（safety.\*）

| 能力 ID              | 动词    | 说明         |
| -------------------- | ------- | ------------ |
| safety.check         | query   | 执行安全检查 |
| safety.report_hazard | acquire | 上报安全隐患 |

小计：**2**

---

## 健康检查（health.\*）

| 能力 ID      | 动词  | 说明                           |
| ------------ | ----- | ------------------------------ |
| health.check | query | 执行综合健康检查并返回详细报告 |

小计：**1**

---

## 技能（skill.\*）

| 能力 ID       | 动词    | 说明           |
| ------------- | ------- | -------------- |
| skill.execute | compose | 执行指定技能   |
| skill.list    | query   | 列出已注册技能 |

小计：**2**

---

## 规则引擎（rule.\*）

| 能力 ID       | 动词    | 说明         |
| ------------- | ------- | ------------ |
| rule.evaluate | query   | 评估业务规则 |
| rule.register | control | 注册新规则   |
| rule.list     | query   | 列出所有规则 |

小计：**3**

---

## 审计（audit.\*）

| 能力 ID     | 动词     | 说明         |
| ----------- | -------- | ------------ |
| audit.query | retrieve | 查询审计日志 |

小计：**1**

---

## 治理（governance.\*）

| 能力 ID                           | 动词    | 说明           |
| --------------------------------- | ------- | -------------- |
| governance.circuit_breaker_status | query   | 查询熔断器状态 |
| governance.reset_circuit_breaker  | control | 重置熔断器     |

小计：**2**

---

## 安全审计（security.\*）

| 能力 ID                    | 动词     | 说明              |
| -------------------------- | -------- | ----------------- |
| security.audit_log         | retrieve | 查询安全审计日志  |
| security.api_key_status    | query    | 查询 API Key 状态 |
| security.rate_limit_status | query    | 查询速率限制状态  |

小计：**3**

---

## 可观测（observe.\*）

| 能力 ID                  | 动词  | 说明                       |
| ------------------------ | ----- | -------------------------- |
| observe.playbook_runs    | query | 查询 Playbook 运行状态摘要 |
| observe.event_log        | query | 查询事件日志               |
| observe.capability_stats | query | 查询能力调用统计           |
| observe.robot_status     | query | 获取机器人整体运行状态     |

小计：**4**

---

## 总计

| 指标                                  | 数值        |
| ------------------------------------- | ----------- |
| **已注册能力总数**                    | **174**     |
| **已覆盖域数**                        | **50 / 50** |
| 核心能力（core-capabilities.ts）      | 58          |
| 扩展能力（extension-capabilities.ts） | 116         |

### 域覆盖率：100%

所有预期域均已实现：system · environment · kb · perceive · task · object · event · learn · evolve · message · time · prompt · llm · robot · swarm · harness · connect · reasoning · memory · comms · a2a · pack · connector · schedule · monitor · nexus · guide · constitution · context · hook · provider · report · approval · work_order · alarm · notify · shift · incident · equipment · maintenance · production · safety · health · skill · rule · audit · governance · security · observe + 附加域（reasoning, context, hook, provider, approval, work_order, alarm, nexus, guide）

### 未覆盖域

无。所有 28 个预期域 + 22 个附加域（共 50 个）均已实现。
