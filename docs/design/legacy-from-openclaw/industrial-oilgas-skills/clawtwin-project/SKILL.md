---
name: clawtwin-project
description: >
  ClawTwin 项目开发主引导 Skill。讨论 ClawTwin 开发、架构决策、功能实现、
  集成方案、代码审查时使用。防止方向偏离，避免重复历史错误，确保架构一致。
---

# ClawTwin 项目开发指南 V2

## 0. 快速状态

```
项目阶段：Phase A 开发中（2026-05，17 周路线图）

权威文档（必读，按层级）：
  ★ DESIGN-FINAL-MASTER-INDEX.md           ← 总入口，5 分钟找到所有信息
  ★ INDUSTRIAL-FOUNDRY-ARCHITECTURE.md     ← 架构层最高权威（Foundry 范式）
  ★ USER-ENVIRONMENT-DELIVERY-VALIDATION.md← 交付层最高权威（飞书+Agent+IMS）
  ★ TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md ← 选型层最高权威（buy/borrow/build）

  CURSOR-MULTITASK-GUIDE.md                ← **§七** 通用前缀（含 cwd）；**§四.1**/ **§四.1.2**；**[T4]/[T12]–[T16]**→`refine-clawtwin/src`；**[T17]/[T18]** 多仓；余见 §四任务表
  DEVELOPMENT-CONTRACT.md                  ← 架构红线 + Demo 场景 + **文首** 文档入口（MASTER-INDEX / DEV §〇 / TESTING §二.0）
  DESIGN-FINAL-LOCK.md                     ← API 路径/枚举/表名权威；头注链联调 cwd
  clawtwin-project/PHASE-A-PROGRESS-AUDIT.md ← **§10 PA-P1…P9** + **§10.1** 轨道内拆步；pytest/build 见 **§8–§9**
  NEXUS-API-REFERENCE.md                   ← 31+ 端点 schema；文首「本地联调/cwd」
  MODULE-DESIGN-PLATFORM.md                ← 后端结构（部分被 INDUSTRIAL-FOUNDRY §八 取代）
  MODULE-DESIGN-STUDIO.md                  ← 前端结构 + 页面设计
  TESTING-GUIDE.md                         ← 测试策略 + **§二.0**（pytest 须在 **`platform-api`** cwd）
  DEV-QUICKSTART.md                        ← **§〇** 多仓 cwd + **§§三–四** platform-api / refine-clawtwin（§二 历史 Compose）
  INDUSTRIAL-SCENARIOS-COMPLETE.md         ← 工业场景覆盖度
  ARCHITECTURE-PRUNING-2026.md             ← @tool/Provider/Stream 风格（仍有效）
  ARCHITECTURE-SIMPLIFICATION-AUDIT.md     ← 4 服务精简栈
  ARCHITECTURE-FINAL-CRITICAL-AUDIT.md     ← 成熟库清单

Phase A 17 周路线图（用 borrow 后，从 30 周减到 17 周）：
  Week 0：  技术选型确认（LinkML / Airbyte / Refine / Casbin / OpenLineage）
  Week 1：  基础脚手架（docker-compose + LinkML demo + Refine demo）
  Week 2-3：Foundry 核心层（[T0.5] [T1] [T2] [T2.5] [T2.6]）
  Week 4：  业务 Object 第一批（[T3] [T4] [T5]）
  Week 5-6：核心业务流（[T6] [T7] [T7.5] [T8]）
  Week 7-8：场景延展（[T9] [T10] [T11c]）
  Week 9-11：Studio + AIP（[T12-T16]）
  Week 12-14：飞书集成（[T17] OpenClaw + HiAgent 双适配）
  Week 15-16：4 客户场景验证
  Week 17： [T18] Demo 录屏 + PoC 邀请 + 验收

详细：DESIGN-FINAL-MASTER-INDEX.md §六
```

---

## 0.5 Cursor 开发与文档上下文（Agent 会看哪些文件？）

```
事实：Cursor / Agent 不会自动读完 contrib/industrial-oilgas-skills 下所有 Markdown。
只有进入「当前对话上下文」的内容才会被稳定遵守：@ 引用、已打开文件、Rules、Skills、代码搜索命中。

铁则：每次 Cursor 对话首条消息至少 @ 1 份 P0 权威文档。

万能首发组合（不知道附啥时用这个）：
  @ DESIGN-FINAL-MASTER-INDEX.md  + @ clawtwin-project/SKILL.md
   ↑ 总入口（5 分钟读懂结构）       ↑ 44 条铁律 + 检查清单

按任务类型的最小附件组合（减少 token，提高命中率）：

  · 写 Object Type / Action Type / Function Type / Pipeline（核心）
    → @ INDUSTRIAL-FOUNDRY-ARCHITECTURE.md + @ DESIGN-FINAL-LOCK.md

  · 接 IMS / 客户实施 / Connector 开发
    → @ USER-ENVIRONMENT-DELIVERY-VALIDATION.md + @ TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md（§2.2）

  · 接新 Agent 平台（HiAgent/Dify/Coze）
    → @ USER-ENVIRONMENT-DELIVERY-VALIDATION.md（§三）+ @ INDUSTRIAL-FOUNDRY-ARCHITECTURE.md（§六.4）

  · 选型 / 决定造轮子
    → @ TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md（§三 + §六）

  · 写 Studio 自定义页面
    → @ MODULE-DESIGN-STUDIO.md + @ STUDIO-UI-ARCHITECTURE.md + @ UI-UX-DESIGN.md（写明章节）

  · API 联调 / FastAPI 路由
    → @ NEXUS-API-REFERENCE.md + @ DESIGN-FINAL-LOCK.md

  · 飞书集成
    → @ USER-ENVIRONMENT-DELIVERY-VALIDATION.md（§五）+ @ ADR-5-FEISHU-DEPLOYMENT-AND-GATEWAY.md

  · 测试
    → @ TESTING-GUIDE.md（§二.0 cwd）+ @ clawtwin-project/SKILL.md（§2 检查清单）

  · 新成员上手 / 本地起 platform-api + Studio
    → @ DEV-QUICKSTART.md（§〇–§四）+ `clawtwin-platform/platform-api/README.md`（执行细节）
  · 多团队分工 / 找任务 / PR 门控清单
    → @ CURSOR-MULTITASK-GUIDE.md + @ DEVELOPMENT-CONTRACT.md + @ TEAM-COLLAB-GUIDE.md（§三 API 层级 · §四 契约 · §六 PR）
仓库内自动规则：编辑 `contrib/industrial-oilgas-skills/**` 时加载 `.cursor/rules/clawtwin.mdc`（若存在）。

独立代码仓：`clawtwin-platform` 在 OpenClaw 仓库外时，请把 DESIGN-FINAL-MASTER-INDEX.md 和 clawtwin-project/SKILL.md 复制到该仓的 docs/ 目录，并在 README 引用。
```

---

## 1. 架构铁律（违反即错，不可协商）

```
【铁律 1】Platform 不包含 OpenClaw 和 vLLM
  Platform 是我们开发的后端服务
  OpenClaw 是独立开源产品，通过 HTTP Tool API 调用我们
  vLLM 是独立推理服务，通过 OpenAI-compatible API 调用

【铁律 2】station_id 永远从 JWT/用户权限中取，绝不从用户输入中取
  原因：防 Prompt 注入越权访问其他场站数据
  实现：platform-api `infra/auth/deps.py` 中 **`require_station_access`**（及设备/工单等路由内对资源归属场站的校验）强制检查
  错误示例：station_id = body.station_id  ← 危险，攻击者可以传任意值
  正确示例：station_id = get_equipment_station(equipment_id) → 验证在 user.station_ids 中

【铁律 3】工单状态服务端强制，字段名 state（非 status），初始值 "draft"（小写）
  创建时 state 服务端强制为 "draft"，不接受客户端传入；状态变更只通过 /v1/hitl/workorders/{id}/* 端点
  权威定义：MODULE-DESIGN-PLATFORM.md §19.3（ORM WorkOrderState 枚举 + VALID_TRANSITIONS）

【铁律 4】飞书 Webhook 签名验证不可跳过（生产环境）
  FEISHU_VERIFY_TOKEN 必须配置，verify_feishu_signature() 必须运行
  测试环境可设置 FEISHU_VERIFY_TOKEN="" 跳过，但 .env.example 必须有这项

【铁律 5】工单审批必须验证角色 + 场站双重权限
  supervisor 角色 AND wo.station_id in user.station_ids
  两个条件缺一不可，任何绕过都是安全漏洞

【铁律 6】所有关键操作必须写审计日志
  关键操作包括：equipment.read / workorder.create / workorder.approve /
  workorder.reject / kb.upload / auth.deny / auth.login
  审计日志表只允许 INSERT，应用账号不得有 UPDATE/DELETE 权限

【铁律 7】Skills 是能力导向，不是岗位导向
  4个能力：twin（读状态）/ kb（知识检索）/ workorder（建工单）/ analytics（趋势分析）
  Cron 任务归 Platform Scheduler，HITL 状态机归 Platform，不在 Skills 里

【铁律 8】OT/IT 物理分区
  opcua-bridge 只在 DMZ，不与 Platform 在同一网段
  opcua-bridge 只推 Kafka，不连 PostgreSQL，不连 Milvus，不暴露 API

【铁律 9】citations 字段必须在 AI 相关的 API 响应中
  kb/search、twin/read、工单草稿的 citations 字段不可省略
  OpenClaw Skills 在输出时必须渲染 citations
  Studio 组件用 <CitationBadge> 显示（见 MODULE-DESIGN-STUDIO.md）

【铁律 10】技术栈已锁定，不引入以下内容
  ❌ Neo4j（GraphRAG 存文件即可）
  ❌ LangGraph（OpenClaw TaskFlow 替代）
  ❌ Kubernetes（Phase C 按需）
  ❌ 全局共享 API Key（安全漏洞，已改为 JWT+ABAC）
  ❌ 每用户一个 OpenClaw（错误的安全模型，见 ADR-7）

【铁律 11】IMS 与 OPC-UA 是两条完全不同的数据链路，不可混用
  OPC-UA 链路：SCADA/DCS → opcua-bridge → Kafka → TimescaleDB（实时物理量）
  IMS 链路：ERP/CMMS → Platform Integration Adapters → PostgreSQL（业务记录）
  两条链路在 equipment_id 上关联，在 /v1/equipment/{id} 响应中合并
  混淆两者会导致：数据源错误、安全分区失效、OT/IT 边界模糊

【铁律 12】工单类型以 DESIGN-FINAL-LOCK §二a 为准（7种枚举）
  corrective | preventive | inspection | shutdown | emergency | calibration | improvement
  旧白名单字符串（vibration_analysis|lubrication 等）已废弃，移入 work_subtype 自由文本

【铁律 13】设备状态以 DESIGN-FINAL-LOCK §二a 为准（8种枚举）
  running | standby | warn | alarm | fault | maintenance | commissioned | offline
  旧 "normal" 废弃（用 "running" 替代）；MAINTENANCE 状态设备 P3/P4 告警不触发飞书

【铁律 14】生产数据停输 > 60 分钟必须填原因
  POST /v1/production/records 中 outage_minutes > 60 且 outage_reason 为空 → 400 VALIDATION_ERROR

【铁律 15】班次交接确认只有指定接班人可执行
  POST /v1/shifts/{id}/confirm 必须验证 current_user.id == shift.handover_to_id
  否则返回 403 FORBIDDEN（"只有指定接班人才能确认"）

【铁律 16】API 路径以 DESIGN-FINAL-LOCK.md 为唯一权威，旧文档路径不可用
  /v1/objects/equipment/{id} 已废弃 → 用 /v1/equipment/{id}
  /v1/tools/kb/search 已废弃 → 用 /v1/kb/search
  /v1/tools/workorder/create 已废弃 → 用 POST /v1/workorders/
  PUT /v1/tools/ai-jobs/{id}/result 已废弃 → 用 POST /v1/ai/jobs/{id}/result
  SSE /v1/sse/equipment/{id} 已废弃 → 用 /v1/sse/station/{id}
  发现文档冲突时，以 DESIGN-FINAL-LOCK.md §一 为准，在该文档 §八 追加备忘

【铁律 17】AI 不直控工艺设备，执行权在人和 DCS
  AI 可：起草工单、分析趋势、生成操作建议、发告警
  AI 不可：直接发控制指令给 DCS/PLC/SCADA
  审批后执行：人去现场执行 → Studio 上传证据 → Platform 记录 DONE
  「审批通过」≠「Platform 下发控制命令」（除非有独立的 OT 安全评审项目）

【铁律 18】OpenClaw/HiAgent 是组织级服务，安全靠 Platform ABAC，不靠进程隔离
  多人共享一个 OpenClaw Gateway 是正确的（Session 级会话隔离）
  共享 ≠ 共享数据：每次工具调用携带用户身份，Platform 校验场站权限
  「分离」的粒度是「安全域/组织」，不是「员工数」
  每人一台 OpenClaw 是运维灾难，不是安全提升

【铁律 40】HiAgent / 多 Agent 共用同一套 Platform Tool API
  两个/多个 Agent 各自独立 ServiceToken（便于分别审计和轮换）
  任何 Agent 不得绕过 Platform 直连数据层
  Tool 契约（API schema/URL）统一在 Platform 维护
  与铁律 30 配合：AgentRuntime 抽象保证多 Agent 等价对待
  见 CLAWTWIN-MASTER-V2.md §十二.3 + USER-ENVIRONMENT-DELIVERY-VALIDATION §三

【铁律 41】OA/BPM 回调必须有独立 ServiceToken 和双重校验
  OA 的 ServiceToken 与 OpenClaw ServiceToken 不同
  Platform 收到 OA 回调后：① 验 OA Token ② 验工单状态 ③ 验审批人角色+场站
  三层缺一不可
  见 INTEGRATION-AND-GAPS.md §七.3

【铁律 42】MCP 工具集是"系统调用"，必须覆盖所有操作（不只读）
  在 Foundry 范式下：所有 Action Type / Function Type 都自动通过 [T2.6] 暴露为 MCP tool
  框架层面已保证写操作 + 读操作全覆盖（不需要在 [T11] 手工 list）
  每个写 Action 在 YAML 声明 safety.risk_level / approval / rate_limit（即 Safety Contract）
  LLM 通过工具链式调用完成复杂业务，不需要预先编写 intent 路由
  参见：INDUSTRIAL-FOUNDRY §六.1 + NEXUS-OS-ARCHITECTURE.md §四

【铁律 19】Platform 内部 Job 不调 vLLM chat，严格遵守铁律 §三 架构红线
  Phase A 后台 Job：结构化复制/模板渲染（无 LLM）
  Phase B 后台 Job：AgentConnector → OpenClaw → vLLM（Nexus 不直调）
  用户发起的分析诊断：始终通过 OpenClaw Agent Loop
  禁止：Platform 任何地方调用 vLLM chat completion API
  允许：Platform 调用 bge-m3 embed API（向量检索）+ MOIRAI API（时序预测）
  参见：DEVELOPMENT-CONTRACT.md §三 + NEXUS-OS-ARCHITECTURE.md §八.五

【铁律 20】知识库 RAG 使用 LlamaIndex，禁止自建 chunker 或向量写入逻辑
  使用：llama-index-core + llama-index-vector-stores-postgres + llama-index-embeddings-huggingface
  向量数据库：pgvector（kb_embeddings 表），Phase A/B 不使用 Milvus
  分块：LlamaIndex SentenceSplitter（尊重语义边界）> 字符数滑动窗口
  禁止：自行 call vLLM embed API → 手动写 pgvector（LlamaIndex 已封装）
  参见：MODULE-DESIGN-PLATFORM.md §八 + ARCHITECTURE-FINAL-CRITICAL-AUDIT.md §二

【铁律 21】所有写操作用 @tool 装饰器（OpenClaw 风格函数），统一通过 invoke() 入口
  ⚠️ 不要使用 Action 抽象类 / Generic / 类继承（违反 OpenClaw / Claude Code 极简风格）
  Tool 定义：core/tools/*.py 中的 @tool 装饰函数
  HTTP / MCP / CLI 三处入口从 TOOLS 注册表自动生成（不要在 router/mcp/cli 各写一遍）
  框架自动处理：权限 / 限流 / 审批门禁 / Trace / Audit
  目录结构：5 层（core / channels / providers / infra / workers），不要 7 层 Clean Architecture
  参见：ARCHITECTURE-PRUNING-2026.md §三（最终权威，CORE-ARCHITECTURE-AUDIT-2026.md §三 已废弃）

【铁律 22】所有 Tool 执行 + LLM 调用必须写 llm_traces 表
  框架在 invoke() 中自动写入，业务代码无需手动调用
  字段：transport / session_id / actor / station / model / tokens / cost / input/output / citations
  评估字段：eval_status (pending|correct|incorrect|partial|na) 用于人工标注准确率
  禁止：跳过 trace 写入（绕过 invoke 直接调业务）
  参见：CORE-ARCHITECTURE-AUDIT-2026.md §四 + ARCHITECTURE-PRUNING-2026.md §三

【铁律 23】用户接入点统一为 Channel（不要散落在 routers/feishu_webhook/cli/mcp）
  Channel 列表：HTTPChannel（Studio）/ FeishuChannel / MCPChannel / CLIChannel
  Studio 不是"独立产品"，是 HTTPChannel 的一种界面表现
  未来扩展（Phase B+）：KioskChannel（场站大屏）/ HandheldChannel（手持终端）
  参见：ARCHITECTURE-PRUNING-2026.md §四.1

【铁律 24】LLM / Embed / Notifier 通过 Provider 抽象可插拔
  设置 LLM_PROVIDER=vllm|tongyi|wenxin|claude，不改业务代码即可切换
  设置 EMBED_PROVIDER=bge-m3|tongyi-embed|openai
  设置 NOTIFIER_PROVIDER=feishu|email|dingtalk
  Nexus 自己只用 EmbedProvider（铁律 19：不调 chat）；OpenClaw 用 LLMProvider
  参见：ARCHITECTURE-PRUNING-2026.md §四.2

【铁律 25】所有业务实体必须先定义为 Ontology Object Type（ontology/object_types/*.yaml）
  禁止：在 SQLAlchemy 模型里直接加业务实体（必须先有 Object Type 定义）
  禁止：在 router 里直接处理业务逻辑（必须经 ObjectStore / ActionExecutor）
  ObjectStore 是 Object 持久化的统一接口（按 type 路由到 PostgreSQL 表）
  参见：INDUSTRIAL-FOUNDRY-ARCHITECTURE.md §四.1 + §八

【铁律 26】所有写操作必须定义为 Ontology Action Type（声明式 YAML）
  Action Type YAML 包含：parameters / validators / effects / side_effects / safety / approval
  框架自动处理：MCP 暴露 / HTTP 端点 / CLI 命令 / Studio 表单 / Audit / Trace / Lineage
  禁止：直接写 session.commit() 修改业务对象（必须经 ActionExecutor）
  Action 实现可用 @implements_action 装饰函数（之前 @tool 升级版）
  参见：INDUSTRIAL-FOUNDRY-ARCHITECTURE.md §四.2 + §九.1

【铁律 27】所有 AI 推理 / 复杂查询定义为 Ontology Function Type
  Function Type 三种实现：ai_function (调 OpenClaw) | python_function | sql_function
  AI 推理结果自动 cache（按 ttl）
  禁止：业务代码直接调 LLM（必须经 FunctionExecutor）
  参见：INDUSTRIAL-FOUNDRY-ARCHITECTURE.md §四.3

【铁律 28】所有外部数据接入必须定义为 Ontology Pipeline（声明式 YAML）
  Pipeline：source / transformations / destination / schedule / lineage
  Pipeline 自动建立数据血缘（每个 Object 知道来自哪个 Pipeline）
  禁止：在 worker 里写 ad-hoc 数据导入脚本（必须为 Pipeline）
  参见：INDUSTRIAL-FOUNDRY-ARCHITECTURE.md §七

【铁律 29】Studio 优先用 Ontology 自动生成 UI（70%）
  自动生成：Object 列表 / Object 详情 / Action 表单 / Function 调用面板
  自定义页面（Mission Control / Twin View / Morning Briefing）只用于复杂场景
  自定义页面仍然调用 Ontology API（不绕过）
  Studio Layout 文件定制自动生成的布局（不写 React 即可调整）
  参见：INDUSTRIAL-FOUNDRY-ARCHITECTURE.md §五

【铁律 30】AgentRuntime 必须抽象，不写死任何 Agent 平台
  支持 OpenClaw / HiAgent / Dify / Coze 等任意平台
  Foundry 暴露 MCP + OpenAPI 双协议；适配器各自处理鉴权与流式
  禁止：在 ActionExecutor / FunctionExecutor 里区分 Agent 平台
  禁止：硬编码 OpenClaw / HiAgent 的特殊行为
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §三 + INDUSTRIAL-FOUNDRY §六.4

【铁律 31】IMS 接入必须用 Connector 抽象（声明式 YAML + 标准包结构）
  目录：connectors/{erp,cmms,historian,scada_dcs,hse,generic}/
  禁止：为某客户 IMS 写一次性脚本（必须沉淀为 Connector 包）
  禁止：在 Foundry 业务代码里 import sap_sdk / oracle_sdk
  奇葩 IMS 用 generic/rest_api + 自定义 transformer.py，仍按 Connector 包格式提交
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §四 + INDUSTRIAL-FOUNDRY §七.3

【铁律 32】每个 Object Type 必须明确 Source-of-Truth 策略
  Object Type YAML 必填：source_of_truth_strategy.default = foundry|external|hybrid
  external 时 Action 自动双向同步（先写 IMS 再写 Foundry，失败回滚）
  hybrid 时按 field_ownership 字段级控制
  Action.execute() 框架自动处理；业务 handler 不感知 SoT 复杂度
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §四.4 + INDUSTRIAL-FOUNDRY §四.1.5

【铁律 33】飞书是出网通道，不是数据源
  飞书消息直进 AgentRuntime（不进 Foundry）
  飞书卡片回调进 Foundry Apps Layer（处理 Action）
  飞书企业身份通过 SSO + Feishu Bridge → Foundry Marking
  禁止：在 Foundry 维护独立的飞书消息历史（飞书自己已存）
  禁止：开发 ClawTwin Mobile 独立 App（用飞书小程序+卡片替代）
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §五

【铁律 34】客户内网私有化是默认部署形态
  飞书是唯一允许出网的服务（wss + 签名验证）
  OT 区单向输出到 IT（OPC-UA Bridge 在 DMZ）
  IMS 与 Foundry 同网络段，加密直连
  SaaS 形态仅适用于 PoC 或低敏感数据客户
  禁止：未经客户书面同意时把 OT/工艺数据上公网
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §六

【铁律 35】每个技术组件必须经 buy/borrow/build 三问（元规则）
  Buy → 客户已有 / 商业 SaaS（飞书、HiAgent、客户 IMS）
  Borrow → 成熟开源（LinkML、Airbyte、Refine、Casbin、LlamaIndex、...）
  Build → 以上都没有才自己写，且必须最小版本
  禁止：用"灵活性 / 性能 / 可控性"借口绕过 borrow
  参见：TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md §一/§三

【铁律 36】Object Type 定义语言用 LinkML，不自创 schema
  LinkML 是工业领域标准本体建模语言（OSDU/NMDC 等都在用）
  ClawTwin 通过 annotations 扩展 LinkML：computed_properties/markings/source_of_truth_strategy/ui_hints
  自动生成 Pydantic + SQLAlchemy + JSON Schema + GraphQL + 文档
  禁止：自己定义新的 schema YAML 关键字（必须按 LinkML 兼容方式）
  参见：TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md §2.1

【铁律 37】IMS Connector 80% 用 Airbyte，不重复造 ETL
  Airbyte 已有 350+ ERP/SaaS Source Connector（SAP/Oracle/Salesforce/用友/NetSuite/...）
  ClawTwin 写：airbyte_pipeline_runner.py（薄适配）+ Airbyte staging → Foundry Object 的 mapping
  写回（Foundry → IMS）部分自己写或用 reverse-ETL 工具
  Airbyte 没有的工业协议（OPC-UA/Modbus/IEC-104）才自己写 Source
  禁止：为标准 ERP / SaaS 写自定义 Connector
  参见：TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md §2.2

【铁律 38】Studio 70% 自动生成用 Refine，不重复造 Admin Panel
  Refine 是开源 React Admin 框架（refine.dev），核心抽象 Resource = Object Type
  Object 列表/详情/创建/编辑/Action 表单/Function 调用全部自动生成
  自定义页面（Mission Control / 3D Twin / Morning Briefing）才写普通 React
  禁止：为每个 Object 手写 React 列表/详情页
  参见：TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md §2.3

【铁律 39】工业知识 / 本体 / 标准必须接开放资源，不从零写
  接入：OSDU 设备本体 / ISO 14224 故障代码 / ISO 15926 流程工业本体 / ISA-18.2 告警 /
        国家标准全文公开系统 / OPC-UA Companion Specs
  ClawTwin 自己只整理 ~50 篇基础说明 + 客户上传知识
  禁止：从零写"压缩机基础知识"等通用工业内容（直接接资源）
  参见：TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md §2.7

【铁律 43】clawtwin CLI / MCP / HTTP 共用同一套 Foundry 执行层
  在 Foundry 范式下：CLI 不是独立产品，而是 Apps Layer 的一种入口
  全部经 ActionExecutor / FunctionExecutor / ObjectStore（铁律 25-27）
  [T2.6] Auto-Generator 从 Ontology 自动生成 HTTP / MCP / CLI 入口（无需各自重复）
  参见：INDUSTRIAL-FOUNDRY §六 + CURSOR-MULTITASK-GUIDE [T2.6]

【铁律 44】知识飞轮 Scheduler Job 是 Phase A 必须实现的
  workorder_to_l3_knowledge Pipeline：每日凌晨从完成工单提炼 L3 知识条目
  这是系统"越用越聪明"的核心机制，不可推迟到 Phase B
  必须实现为 Pipeline YAML（铁律 28），不是 ad-hoc worker 脚本
  参见：INDUSTRIAL-FOUNDRY §七.1（pipelines/workorder_to_l3_knowledge.yaml）
```

---

## 2. 每个 PR / 功能点的开发检查清单

### 2.1 安全检查（每个 API 端点必须过）

```
□ 端点是否有 Depends(get_current_user)？
□ 涉及场站数据是否调用 require_station(station_id, user)?
□ 涉及角色限制操作是否调用 require_role("supervisor") 等?
□ 工单创建是否在服务端强制 state="draft"（字段名 state，值小写）？
□ 飞书 Webhook 是否有 verify_feishu_signature() ？
□ 是否在关键操作后写了 audit_log()？
□ 错误响应是否用统一格式 {"detail": "中文描述"} ？
□ 是否有 403 测试（越权访问）+ 401 测试（未认证）？
```

### 2.2 数据库操作检查

```
□ 是否使用 async session（不是 sync）？
□ 时序数据是否写 equipment_readings 表（TimescaleDB），不是普通表？
□ 新增 DB 列是否向前兼容（有默认值）？
□ 是否有对应的 Alembic 迁移文件？
□ audit_logs 相关操作是否只有 INSERT（没有 UPDATE/DELETE）？
```

### 2.3 集成检查

```
□ 调用 Ditto 是否通过 services/ditto.py（**Phase B/C**；Phase A 通常无 Ditto 进程）？
□ **KB 向量**是否走 **PostgreSQL pgvector / LlamaIndex**（**铁律 20**），**禁止** 新接 `pymilvus`/Milvus？
□ 调用 vLLM 是否通过独立推理服务（OpenAI-compatible）而不是把模型塞进 Platform 进程？
□ 飞书消息发送是否通过 services/feishu.py（含 FEISHU_SERVER_URL 私有化适配）？
□ 新的外部服务调用是否有 mock 模式（MOCK_MODE=true 时绕过）？
□ 新的外部服务调用是否有超时设置（httpx timeout）？
```

### 2.4 OpenClaw Skills 检查

```
□ Skill 是否基于能力（做什么），而不是角色（谁用）？
□ 工具调用参数是否由 Platform 服务端验证（不信任 Skill 传来的值）？
□ Skill 的输出是否包含 citations？
□ Skill 是否包含 Cron 逻辑（不应该有，Cron 在 Platform）？
□ Skill 是否包含 HITL 状态机（不应该有，在 Platform）？
```

### 2.5 Studio 前端检查

```
□ 新组件是否在正确目录（工业组件→components/industrial/，3D→surfaces/）？
□ Babylon.js 代码是否只在 surfaces/ 目录？
□ 数据获取是否通过 hooks/ 而不是直接在组件里调用 platformClient？
□ citations 是否用 <CitationBadge> 显示？
□ station_id 是否从 auth.store 中取，而不是从 URL 参数或用户输入取？
□ 对多站权限用户，是否正确过滤只显示有权限的场站数据？
```

---

## 3. 已识别的历史错误（不要重蹈覆辙）

```
错误 1：Skills 按岗位设计（已在 ADR-4 纠正）
  × 错误：industrial-station-agent, industrial-knowledge-admin
  ✓ 正确：industrial-twin, industrial-kb, industrial-workorder, industrial-analytics

错误 2：共享 API Key 做鉴权（已在 ADR-6 纠正）
  × 错误：CLAWTWIN_API_KEY=dev-key（所有用户共享）
  ✓ 正确：JWT（Studio 登录）+ X-OpenClaw-Service-Token + X-Feishu-OpenId

错误 3：每人一个 OpenClaw（已在 ADR-7 纠正）
  × 错误：100用户 = 100个 OpenClaw 实例
  ✓ 正确：团队粒度，1个 OpenClaw，Session 级别隔离用户会话

错误 4：Feishu Webhook 不验签（已在 ADR-6 纠正）
  × 错误：签名验证注释掉了
  ✓ 正确：verify_feishu_signature() 必须运行，防止伪造审批

错误 5：station_id 从用户输入取（Prompt 注入漏洞）
  × 错误：station_id = body.station_id
  ✓ 正确：station_id 从 equipment 的 station_id 推导，并验证在 user.station_ids 中

错误 6：工单审批只验角色不验场站（安全漏洞）
  × 错误：if user.role == "supervisor": approve()
  ✓ 正确：if user.role in ("supervisor","sys_admin") AND wo.station_id in user.station_ids

错误 7：opcua-bridge 与 Platform 在同一网段（工业安全规范违反）
  × 错误：docker-compose 里所有服务同一个网络
  ✓ 正确：opcua-bridge 在 DMZ 网络，单向推 Kafka 到 IT 网络

错误 8：忽略 OT/IT 物理分区（已在 PRODUCTION-ARCHITECTURE-REVIEW 纠正）
  × 错误：Docker Compose 平铺所有服务
  ✓ 正确：Zone 0（OT）→ Zone 1（DMZ/opcua-bridge）→ Zone 2（IT/Platform）

错误 9：GraphRAG 方向引入 Neo4j（已否决）
  × 错误：想用 Neo4j 存图谱
  ✓ 正确：GraphRAG v3 存 Parquet 到 MinIO，通过 Platform API 访问

错误 10：在 Platform 里包含 OpenClaw 或 vLLM 代码
  × 错误：把 OpenClaw 的功能迁移到 Platform
  ✓ 正确：Platform 是接口，调用独立部署的 OpenClaw 和 vLLM

错误 11：状态管理只写 interface 不写 create()（无法运行）
  × 错误：auth.store.ts / twin.store.ts 只有 interface 声明，没有 Zustand create()
  ✓ 正确：见 MODULE-DESIGN-STUDIO.md §三.1（auth.store.ts 完整实现）和 §三.2（twin.store.ts 完整实现）

错误 12：ORM models/ 全部缺失，但所有 router/service 都 from models.xxx import
  × 错误：models/user.py、models/equipment.py 等文件从未定义 SQLAlchemy class
  ✓ 正确：见 MODULE-DESIGN-PLATFORM.md §十五（5 个完整 ORM class 定义）

错误 13：config.py 存在两个 Settings 类定义（会让开发者困惑）
  × 错误：§4.1 和 §七.1 各有一个 Settings(BaseSettings) class
  ✓ 正确：§4.1 已改为速查表格，§七.1 是唯一完整定义（含 studio_url、jwt_secret_key）

错误 14：密码 hash 函数未定义，auth router 登录只有 API 文档没有实现
  × 错误：passlib[bcrypt] 在 requirements.txt，但 verify_password() 函数从未定义
  ✓ 正确：见 MODULE-DESIGN-PLATFORM.md §十四.1（auth/password.py 完整实现）和 §十四.3（登录端点）

错误 15：将 IMS 与 OPC-UA 视为同一条数据链路
  × 错误：「接 IMS」和「接 OPC-UA」混为一谈，导致架构图含混、安全分区失效
  ✓ 正确：OPC-UA=实时物理量（链路 A）；IMS=业务记录（链路 B）；见 CLAWTWIN-MASTER-V2.md §十一.3

错误 16：认为「AI 审批通过 = Platform 可以下发控制指令给 DCS」
  × 错误：把 HITL 工单审批和工艺控制混淆，认为「批了就可以自动执行现场操作」
  ✓ 正确：审批后执行由人完成；Platform 记录完成证据；见 INTEGRATION-AND-GAPS.md §七.1

错误 17：认为 HiAgent 和 OpenClaw 需要各自独立的数据库连接
  × 错误：为 HiAgent 单独开放 PostgreSQL 访问权限
  ✓ 正确：HiAgent 和 OpenClaw 都只能调 Platform Tool API；见 CLAWTWIN-MASTER-V2.md §十二.3

错误 18：认为「飞书有 WebSocket 连接到机房」或「飞书接两个 WebSocket」
  × 错误：架构图里把飞书和 OpenClaw 之间画成 WebSocket 持久连接
  ✓ 正确：飞书到 Platform = HTTP Webhook；飞书到 OpenClaw = Bot 事件推送；
         WebSocket 只存在于「浏览器 Studio → OpenClaw」这一段；见 INTEGRATION-AND-GAPS.md §七.4

错误 19：工单路径三个版本（API 合约断裂）
  × 错误1：/v1/tools/workorder/draft（旧路径，已废弃）
  × 错误2：/v1/hitl/workorders/draft（中间路径，混乱）
  × 错误3：/v1/hitl/workorders/{id}/submit（不存在的动词）
  ✓ 正确：草稿预填 = POST /v1/workorders/ai-draft（不建工单）
          建工单   = POST /v1/workorders/（state 服务端强制 draft）
          提交审批 = POST /v1/hitl/workorders/{id}/pending
          见 MODULE-DESIGN-PLATFORM.md §18.6 唯一真相表

错误 20：工单状态枚举大小写不一致（前后端无法比对）
  × 错误：Studio 用 "DRAFT"/"ai_draft"/"pending"/"status"/"WorkOrderStatus" 等变体
  ✓ 正确：字段名统一为 state（非 status），值小写下划线：draft / pending_approval / approved / in_progress / done / rejected
          权威定义：MODULE-DESIGN-PLATFORM.md §19.3（WorkOrderState 枚举）+ §19.5（Studio TypeScript）

错误 21：/v1/notifications/notify-operator 不存在（One Big Action 无法执行）
  × 错误：Studio 调用但 Platform 没有此路由
  ✓ 正确：已在 MODULE-DESIGN-PLATFORM.md §18.4 实现（routers/notifications.py）

错误 22：/v1/equipment/ 和 /v1/stations/ 路由未注册到 main.py
  × 错误：新端点（health-score/spectrum/health-summary）定义了但没有 include_router
  ✓ 正确：main.py 路由注册已在 §七 更新为完整版，equipment_router + stations_router 已加入
          见 MODULE-DESIGN-PLATFORM.md §18.1 完整 import 语句

错误 23：work_orders 表三处定义互相矛盾（§二/§十五/Studio 三张不同的表）
  × 错误：DB Schema（§二）主键 id、字段 symptom/suggested_steps、status 大写 DRAFT
          ORM（§十五）主键 wo_id 但字段 title/description 不在 §二 表中、status 大写 DRAFT
          Studio 类型主键叫 work_order_id、状态字段叫 status（之前改为小写但字段名还错）
  ✓ 正确：见 MODULE-DESIGN-PLATFORM.md §十九（权威数据模型定稿，2026-05-09）
          主键：wo_id（格式 W-XXXXXXXX）
          状态字段名：state（非 status）
          状态值：小写下划线（draft/pending_approval/approved/in_progress/done/rejected）
          equipment 表新增 area 字段（供 StationHeatmap 分组）
          开发时从 §19 复制，§二 和 §十五 的工单部分已废弃

错误 24：Studio 用 REST 轮询实时设备指标（setInterval + fetch）
  × 错误：每 5s 轮询一次，20 台设备并发请求，性能差且延迟高
  ✓ 正确：Platform 加 SSE 端点 GET /v1/sse/station/{id}，Studio 用 EventSource 订阅
          Phase A 用 SSE（单进程够用），Phase B 换 WebSocket + Redis（多进程时）
          见 MODULE-DESIGN-PLATFORM.md §21.3（SSE 端点）+ §21.4（Studio equipmentStore）

错误 25：铁律 2（station_id 权限）散落各路由，有路由忘记校验
  × 错误：部分路由没有调 **`require_station_access`**（或等价资源场站校验），或直接从 request body 取 station_id
  ✓ 正确：platform-api 使用 **`infra/auth/deps.py`** 的 **`require_station_access(user, station_id)`**（及设备/工单归站推导）
          user 来自 `Depends(get_current_user)`；合并场站见 **`station_merge.py`**
          见 `MODULE-DESIGN-PLATFORM.md` 与 **`PHASE-A-PROGRESS-AUDIT.md` §2**

错误 26：API 返回裸 dict/list，前端各处自己 JSON.parse 判断错误
  × 错误：return {"id": ..., "name": ...}，错误时 raise HTTPException(404)
          前端要 try/catch + status code 判断，每个 fetch 各写一套
  ✓ 正确：统一用 ok(data) / paginate(items, total, page, per_page) / err(code, msg)
          前端用 apiFetch<T> 统一处理，错误统一抛 ApiError
          见 MODULE-DESIGN-PLATFORM.md §22.1

错误 27：AI 诊断接口同步阻塞（Qwen 35B 推理 60-120s，HTTP worker 被占满）
  × 错误：POST /v1/tools/diagnose_equipment 直接 await llm.chat(...)，超时 504
  ✓ 正确：立即返回 task_id，后台 asyncio.create_task，前端轮询 /v1/tools/tasks/{id}
          Phase B 换 ARQ（Redis 队列），接口 URL 和格式不变
          见 MODULE-DESIGN-PLATFORM.md §22.3

错误 28：list 接口没有分页，数据多了全量返回导致 OOM / 前端卡死
  × 错误：GET /v1/workorders 返回所有工单，没有 page/per_page 参数
  ✓ 正确：统一用 Depends(get_pagination) + paginate() 返回标准分页格式
          前端用 meta.total_pages 控制分页 UI
          见 MODULE-DESIGN-PLATFORM.md §22.5

错误 29：AI 服务（vLLM）没有并发保护，多用户同时诊断 → GPU OOM → 全挂
  × 错误：直接 await httpx.post(vllm_url)，无限并发
  ✓ 正确：用 AIClient（§23.2）：asyncio.Semaphore（最大 3）+ Circuit Breaker（5 次失败熔断）
          vLLM 挂掉时返回降级响应，Studio 显示"AI 服务维护中"而非报错

错误 30：没有 /v1/admin/* 路由，IT 交付时无法创建用户和场站
  × 错误：只有业务 API，Admin 功能缺失，交付时只能手动改数据库
  ✓ 正确：实现 §23.4 的 Admin 端点（用户/场站/设备/KB 管理），保护条件 user.role == "sys_admin"
          Admin UI 挂在 Studio /admin 路由下，sys_admin 角色可见

错误 31：时区混乱（OPC-UA 数据用本地时间，API 返回不带 Z 后缀，Studio 显示错误时间）
  × 错误：各处时区处理不一致，工单时间线对不上
  ✓ 正确：§23.6 全局规则：存储 UTC、API 返回带 Z、Studio 用 dayjs.utc().local() 显示
          OPC-UA bridge 统一转 UTC 再入库（normalize_opcua_ts）

错误 32：Platform Tool API 内部调 vLLM 做诊断推理（根本架构错误）
  × 错误：/v1/tools/diagnose_equipment 内部调 vLLM chat API，Platform 同时承担数据层+推理层
          ai_client.py 里有 chat() 方法被 Platform 直接调用
          Platform settings 有 vllm_base_url（推理端点）
  ✓ 正确：§二十六 Foundry+AIP 分层修正
          Platform 只调 bge-m3（embed）+ MOIRAI（后台），不调 vLLM chat
          diagnose_equipment 从 Tool API 中移除（Skill 自己调 GPU Server 推理）
          新增 /v1/tools/equipment/context（给 Skill 提供数据快照，Skill 自己构建 Prompt）
          vLLM 并发控制靠 GPU Server 的 --max-num-seqs，不在 Platform 里做 Semaphore
          删除 ai_client.py（chat 部分），保留 embed_client.py（向量化）

错误 33：Studio 直接调 `/v1/tools/*` Tool API（认证类型错误）
  × 错误：Studio 用 User JWT 直接调 POST /v1/tools/diagnose_equipment
          Studio 用 User JWT 直接调 POST /v1/tools/analyze_pid
          Studio 用 User JWT 直接调 POST /v1/visual/inspect
          Tool API 是 Service Token 接口（机器身份），Studio 是用户身份
  ✓ 正确：§二十七 全系统边界审计
          Studio AI 触发 → POST /v1/ai/jobs（User JWT，Platform 排队）
          Platform ai_job_worker 异步触发 OpenClaw Skill 处理
          Studio 收 SSE AI_JOB_DONE 事件后展示结果

错误 34：compute_primary_action 和 health-score 调用 AI（应为纯规则）
  × 错误：Platform compute_primary_action 调 vLLM 生成建议
  ✓ 正确：§27.6 纯规则引擎（P1告警→紧急停机，MOIRAI>0.85→紧急巡检，依次决策）
          无 LLM 调用，Studio 实时显示不受 AI 延迟影响

错误 35：analyze_pid 和 visual/inspect 在 Platform（应在 Skill）
  × 错误：Platform 有 POST /v1/tools/analyze_pid 和 POST /v1/visual/inspect 调 vLLM
  ✓ 正确：§27.4 P&ID 路由只提供数据（layout/realtime），分析在 OpenClaw Skill
          视觉巡检 POST /v1/media/upload 存图，分析在 Skill（Phase B）
```

---

## 4. 遇到分歧时的解决流程

```
Step 1：查 V2 定稿文档
  CLAWTWIN-MASTER-V2.md → 架构、技术栈、安全模型
  MODULE-DESIGN-PLATFORM.md → API 端点、DB schema
  MODULE-DESIGN-STUDIO.md → 组件设计
  → 如果已有定义，直接执行，不讨论

Step 2：查 ADR（按优先级）
  ADR-7 → IMS 集成 + OpenClaw 部署粒度
  ADR-6 → 安全架构
  ADR-5 → 飞书集成
  ADR-4 → Skills 设计原则
  ADR-2 → Platform 边界
  → 如果 ADR 有结论，执行 ADR

Step 3：如果确实没有决策
  写新的 ADR 文件（ADR-8-TOPIC.md）
  明确列出：问题 / 选项 / 权衡 / 结论
  更新 README.md 和本 SKILL.md 的文档索引

Step 4：不允许的做法
  × 在对话中临时决定后立即实现（会被遗忘）
  × 为了省事引入新技术（先查铁律 10）
  × 绕过安全检查清单
```

---

## 5. 关键文档速查表

```
需要查什么                       → 看哪个文档
────────────────────────────────────────────────────────────────────────
客户汇报/投标建设方案（完整版）  → STRATEGIC-PROPOSAL-V1.md（★ 新，客户向）
战略视野与 Palantir 对标        → STRATEGIC-PROPOSAL-V1.md §一
四层 AI 模型架构（LLM/时序/物理/孪生）→ STRATEGIC-PROPOSAL-V1.md §二
用户视角（操作员/主管/工程师一天）→ STRATEGIC-PROPOSAL-V1.md §三.1
架构合理性批判审查               → STRATEGIC-PROPOSAL-V1.md §三.2
IT 运维部署/安全/备份            → STRATEGIC-PROPOSAL-V1.md §三.3
Studio 地图范式 UI 布局（Palantir）→ STRATEGIC-PROPOSAL-V1.md §四.1
AI 嵌入式交互设计                → STRATEGIC-PROPOSAL-V1.md §四.2
设备 Ontology 对象 JSON 完整结构 → STRATEGIC-PROPOSAL-V1.md §四.3
Phase A 8 周计划                 → STRATEGIC-PROPOSAL-V1.md §五.2
Phase B 技术节点                 → STRATEGIC-PROPOSAL-V1.md §五.3
竞争分析与差异化                  → STRATEGIC-PROPOSAL-V1.md §六
投资概算（硬件/软件/实施/TCO）   → STRATEGIC-PROPOSAL-V1.md §七
ROI 测算（停机损失/效率提升）    → STRATEGIC-PROPOSAL-V1.md §七.2
未来演进路线图（2026-2029）      → STRATEGIC-PROPOSAL-V1.md §九
给 IT 部门的问答（Q&A）          → STRATEGIC-PROPOSAL-V1.md 附录 B
整体架构、组件图                 → CLAWTWIN-MASTER-V2.md
AI 原生设计原则（Foundry/AIP）   → CLAWTWIN-MASTER-V2.md §十一
IMS vs OPC-UA 两条链路澄清      → CLAWTWIN-MASTER-V2.md §十一.3
飞书三通道说明（Webhook/Bot/WS） → CLAWTWIN-MASTER-V2.md §十一.4
OpenClaw 粒度（组织级非个人级）  → CLAWTWIN-MASTER-V2.md §十一.5
HiAgent 共用 Tool API 方式      → CLAWTWIN-MASTER-V2.md §十二.3
OA/BPM 回调接入模式             → CLAWTWIN-MASTER-V2.md §十二.2
飞书 IDaaS 身份同步             → CLAWTWIN-MASTER-V2.md §十二.4
数据中台接入决策矩阵             → CLAWTWIN-MASTER-V2.md §十二.5
审批执行完整链路（谁执行/在哪）  → INTEGRATION-AND-GAPS.md §八.1
OA/BPM 回调端点代码             → INTEGRATION-AND-GAPS.md §八.3
飞书三通道对比表                 → INTEGRATION-AND-GAPS.md §八.4
产品规划、执行计划               → PRODUCT-PLAN-V2.md
Platform 文件结构                → MODULE-DESIGN-PLATFORM.md §一
数据库 Schema（建表语句）        → MODULE-DESIGN-PLATFORM.md §二
API 端点完整定义                 → MODULE-DESIGN-PLATFORM.md §三
鉴权依赖实现                     → MODULE-DESIGN-PLATFORM.md §四
main.py 完整实现                 → MODULE-DESIGN-PLATFORM.md §七
知识摄入 Pipeline（PDF→**pgvector** / LlamaIndex；**非** Milvus）  → MODULE-DESIGN-PLATFORM.md §八（**以铁律 20 / SIMPLIFICATION 为准**）
Scheduler 定时任务代码           → MODULE-DESIGN-PLATFORM.md §九
知识检索三层融合（kb/search.py） → MODULE-DESIGN-PLATFORM.md §十
Analytics API 端点               → MODULE-DESIGN-PLATFORM.md §十一
原始时序数据 API（/v1/data）     → MODULE-DESIGN-PLATFORM.md §十一（末尾）
db/session.py（AsyncSession）   → MODULE-DESIGN-PLATFORM.md §十三.1
JWT utils（create/decode）       → MODULE-DESIGN-PLATFORM.md §十三.2
FeishuClient（发消息/卡片/告警） → MODULE-DESIGN-PLATFORM.md §十三.3 + §十四.5
Dockerfile + requirements.txt    → MODULE-DESIGN-PLATFORM.md §十三.4-5
services/**kb** / **pgvector** 封装（历史 `services/milvus.py` **已废弃**，勿新引用）  → MODULE-DESIGN-PLATFORM.md §12 / §24.2（读时替换心理模型为 pgvector）
Mock 数据 JSON 格式              → MODULE-DESIGN-PLATFORM.md §12.8
ORM 模型（User/Equipment/…）     → MODULE-DESIGN-PLATFORM.md §十五（完整实现）
auth/password.py（bcrypt hash）  → MODULE-DESIGN-PLATFORM.md §十四.1
routers/auth.py（登录端点；**实现等价物**：`apps/http/routes/auth_http.py`）  → MODULE-DESIGN-PLATFORM.md §十四.3
auth/feishu_bind.py              → MODULE-DESIGN-PLATFORM.md §十四.4
config.py 完整字段（含studio_url）→ MODULE-DESIGN-PLATFORM.md §七.1
Scheduler 辅助函数               → MODULE-DESIGN-PLATFORM.md §九（末尾 helpers.py）
Studio 组件树                    → MODULE-DESIGN-STUDIO.md §四
TwinSurface.tsx（Babylon.js）    → MODULE-DESIGN-STUDIO.md §五（完整实现）
RequireAuth 鉴权组件             → MODULE-DESIGN-STUDIO.md §二.0
auth.store.ts（Zustand，完整）   → MODULE-DESIGN-STUDIO.md §三.1
twin.store.ts（Zustand，完整）   → MODULE-DESIGN-STUDIO.md §三.2
LoginPage.tsx（工号登录，完整）  → MODULE-DESIGN-STUDIO.md §十.1
useWorkOrders hook               → MODULE-DESIGN-STUDIO.md §十.2
useEquipment hook 实现           → MODULE-DESIGN-STUDIO.md §十一
vite.config.ts（dev proxy）      → MODULE-DESIGN-STUDIO.md §十七.2
TypeScript 类型（EquipmentState等）→ MODULE-DESIGN-STUDIO.md §十七.3
Studio package.json 依赖         → MODULE-DESIGN-STUDIO.md §十八
nginx.conf（反向代理配置）       → PHASE-A-SCAFFOLD.md 附录
Studio 构建与部署流程            → PHASE-A-SCAFFOLD.md 附录
AI 快捷操作（问 AI/建工单）      → MODULE-DESIGN-STUDIO.md §十一
CommandPage（大屏）设计          → MODULE-DESIGN-STUDIO.md §十二
Admin KnowledgePage 设计         → MODULE-DESIGN-STUDIO.md §十三
Admin UserPage + 飞书绑定邀请    → MODULE-DESIGN-STUDIO.md §十四
Nginx 路由配置                   → MODULE-DESIGN-STUDIO.md §十五
API 客户端调用方式               → MODULE-DESIGN-STUDIO.md §六
OPC-UA Bridge 详细设计           → OPCUA-BRIDGE-DESIGN.md
Phase A 8 周开发 Runbook          → PHASE-A-RUNBOOK.md
OpenClaw 安装 + Skills 配置       → OPENCLAW-SETUP-GUIDE.md
Service Token 生成 + 用户绑定     → OPENCLAW-SETUP-GUIDE.md §五、§八
OT/IT 网络分区 + Docker 网络配置 → CLAWTWIN-MASTER-V2.md §二 + §附
安全架构（零信任/ABAC）          → CLAWTWIN-MASTER-V2.md §四 + ADR-6
飞书集成（两通道、私有化）       → ADR-5
OpenClaw 部署粒度                → ADR-7
Skills 设计原则                  → ADR-4 + CLAWTWIN-MASTER-V2.md §七
IMS 集成（服务账号/代理模式）    → ADR-7
生产运维手册                     → PRODUCTION-ARCHITECTURE-REVIEW.md
Phase A 代码脚手架               → PHASE-A-SCAFFOLD.md
Embedding 模型选型（bge-m3）     → MODULE-DESIGN-PLATFORM.md §十（维度=1024）
```

---

## 6. 快速参考：核心技术栈（V3，2026-05）

> **Phase A 执行栈**（以 `ARCHITECTURE-SIMPLIFICATION-AUDIT.md` + **铁律 10** 为准）：**PostgreSQL**（业务 + **Timescale** 时序 + **pgvector** 向量）+ **Redis** + 外置 **vLLM** + 外置 **OpenClaw**。**不**在 Phase A 默认启动 **Kafka / Milvus / Ditto** 独立服务。下表为「能力全景 + B/C 扩展」，未标注 Phase 的条目实施前须对照 **TECH-STACK-RATIONALIZATION**。

```
后端语言/框架   Python 3.12 / FastAPI / Pydantic v2 / SQLAlchemy 2.0 async
数据库          PostgreSQL 16 + TimescaleDB + **pgvector**（**替代 Milvus**，铁律 10/20）
向量库          **pgvector**（PostgreSQL 扩展）；Milvus **仅 Phase C 超大规模按需**
知识图谱        Phase A **不强制**；**Apache AGE** 等见 Phase B/C 规划（非 Phase A 默认服务）
孪生运行时      Phase A：本体 + HTTP API；**Eclipse Ditto** 为 Phase B/C 按需
消息总线        Phase A：**进程内/REST**；**Kafka** Phase B/C 按需
OPC-UA 采集     asyncua（Python）；**Bridge 在 DMZ**（铁律 8/11）
文档存储        Phase A：DB + 2 MiB 级内联/对象存储规划；**MinIO** Phase B/C 按需
缓存            Redis 7（via aioredis）
LLM 推理        vLLM：Qwen 系（OpenAI-compatible API；**不在 Platform 进程内托管权重**）
时序异常检测    MOIRAI 等（Phase B/C 深度集成；Phase A 可占位）
物理计算        CoolProp / Pyomo（能力预留）
L3 知识存储      **PostgreSQL** `kb_documents` + **pgvector**（**非** Milvus）
前端框架        React 18 + TypeScript + Vite（Studio：**Refine** 路径见 MODULE-DESIGN-STUDIO）
前端状态        Zustand（独立于 @maibot/store）
3D 引擎         Babylon.js + WebGPU（Phase A/B 按需）
P&ID 视图       react-flow + DEXPI（Phase B）
UI 组件         Ant Design（refine-clawtwin 现状）/ shadcn 等见 Studio 文档
HTTP 客户端     axios（Studio）/ httpx（Platform）
运维监控        Grafana + Prometheus + Loki（替代自制 Admin 监控）
部署            Docker Compose + Ansible
```

## 7. 批判性审视结论（CRITICAL-REVIEW-AND-EVOLUTION.md）

```
重大新增功能（按优先级）：
  P0 - Phase A 内：
    视觉巡检（Qwen2.5-VL）       → 飞书发图，AI 分析设备外观
    CoolProp 物理约束              → 热力学一致性校验
    Apache AGE 图扩展              → 因果知识推理
    Grafana 替代自制监控           → 节省 3-4 周开发

  P1 - Phase B：
    P&ID 数字化视图（react-flow）  → 工艺工程师第一入口
    能耗/碳排放追踪                → ESG 合规需求
    设备健康评分看板               → AI 价值量化可见
    多 Agent 架构（LangGraph）     → 诊断质量提升

关键设计铁律新增：
  · AI 必须显示置信度和不确定性，不只给结论
  · 功能安全边界（IEC 61511）：ClawTwin 是「咨询层」，不接触 SIS
  · 2029 年目标：完全无人场站（需等监管政策）

圆晖资源整合路径：
  Phase A：技术参考（Ontology 结构、场景组织方式）
  Phase B：采购 3D 设备模型资产（加速交付，3-6 个月）
  Phase C：战略合作（圆晖负责 3D/Ontology，ClawTwin 负责 AI/知识/HITL）
```

---

## 8. 第二波批判新决策（CRITICAL-REVIEW-WAVE2.md）

```
ISA-18.2 告警管理（立即实现）：
  · 告警必须去重（相同设备+类型合并计数）
  · 告警必须可搁置（30/60/480 分钟选项）
  · 告警率 KPI：目标 ≤ 1 条/10 分钟（正常工况）
  · Studio AlarmQueuePanel 已设计（MODULE-DESIGN-STUDIO §25）
  · Platform /v1/alarms/acknowledge + /shelve + /stats 待实现

冷启动知识资产（Phase A 交付前硬性要求）：
  · L0 文档 ≥ 50 篇（GB/T + API + SY/T 行业标准）
  · L1 文档 ≥ 20 篇（针对客户实际设备型号的厂商手册）
  · 知识质量验收：10 道标准问题，得分 ≥ 80% 才能交付

离线/边缘容灾（Phase A 基础）：
  · ServiceWorker 缓存最后已知状态（网络断开时 Studio 不白屏）
  · 离线横幅（OfflineBanner 组件）
  · 断网日志本地缓存，恢复后自动同步

操作员信任校准（Phase A 展示，Phase B 功能开放）：
  · Phase A：所有 AI 建议标注"仅供参考"（观察者模式）
  · Phase B：AI 准确率 > 70% 后解锁工单草稿直接入审批流
  · Studio 个人设置：AI 助手成绩单（采纳率/准确率/最近错误）

设备上下文（Equipment Memory）最小实现：
  · diagnose_equipment Tool 调用前构造设备上下文
  · 包含：24h 趋势描述 + 最近 5 条工单摘要 + KB 检索结果
  · 函数：build_equipment_context(equipment_id, db) → str
```

## 9. 第三波批判新决策（商业落地）

```
AVEVA PI / OSIsoft 集成（重要存量客户接入路径）：
  · PIConnector 已设计（CLAWTWIN-MASTER-V2 §15）
  · PI Web API → TimescaleDB 实时镜像（每 30 秒）
  · PI AF → Platform Ontology 一次性导入
  · 销售话术：ClawTwin 是 "PI System 的 AI 大脑层"

数据质量框架（GIGO 防御）：
  · DataQualityChecker 已设计（CLAWTWIN-MASTER-V2 §16）
  · 检测：固定值、跳变值、缺失数据、传感器漂移
  · 策略：AI 诊断前先做质量预检，数据差时拒绝诊断并说明原因
  · Admin 数据质量 Dashboard（admin/data-quality 路由）

竞争定位更新：
  · 最重要对手是 AVEVA PI System（不是 Siemens/Palantir）
  · Cognite Data Fusion 是最相似的新兴竞争者（无飞书/无中文）
  · AspenTech 在炼化领域强，我们聚焦管输（避开正面竞争）
  · 差异化核心：唯一真正懂石油天然气工艺的中文 AI 系统

ROI 模型（客户 CFO 需要的数字）：
  · 单次非计划停机损失：¥900 万（1000 万方/天规模压气站）
  · 减少 60% 非计划停机：年节省 ¥1080 万
  · 3 年 ROI = 618%，回收期 < 3 个月（STRATEGIC-PROPOSAL-V1 §7.2）
  · Studio Admin 内置价值计算器（admin/value-calculator 路由）
```

## 10. 里程碑快速参考（DEVELOPMENT-MILESTONES.md）

```
Phase A（3 个月，6 个里程碑）：
  M1 Week 2  基础设施（Docker + DB + auth + Studio 骨架）
  M2 Week 4  3D 孪生核心（Babylon.js + 设备点击 + 实时状态）
  M3 Week 6  AI 知识问答（KB + OpenClaw Skills + AIInsightCard）
  M4 Week 8  HITL 工单闭环（WorkOrder FSM + 飞书审批 + L3 沉淀）
  M5 Week 10 ISA-18.2 告警 + 晨报 + 数据质量 Dashboard
  M6 Week 12 Phase A 交付（安全加固 + Admin 完整 + Demo 视频）

Phase B（6 个月）：M7 OPC-UA → M8 MOIRAI → M9 L3 验证 → M10 多场站
Phase C（12 个月）：M11 P&ID → M12 视觉巡检 → M13 AVEVA PI → M14 无人验收
```

---

## 11. UI 开发铁律（违反即错，不可协商）

```
【UI 铁律 1】DeviceIntelPanel 布局顺序不可变
  顺序：倒计时 → One Big Action → AI 情报 → 指标（折叠）→ 健康评分 → 频谱 → 工单
  原则：决策依据先于原始数据，行动先于信息
  见：MODULE-DESIGN-STUDIO §27

【UI 铁律 2】One Big Action 由 Platform 计算，前端只渲染
  权威数据源：GET /v1/equipment/{id}/decision-package（DESIGN-FINAL-LOCK §一.1 · C-01）
  响应（或合并进设备详情的一致字段）必须包含 primary_action / urgency 等决策包字段
  流式 AI 诊断走 POST /v1/ai/jobs + GET /v1/sse/ai-jobs/{job_id}，不得用已废弃 /v1/tools/diagnose_equipment
  前端 useEquipmentIntel Hook 解析，DeviceIntelPanel 渲染
  不在前端判断"该显示什么按钮"——会导致与后端状态不一致
  见：MODULE-DESIGN-STUDIO §28

【UI 铁律 3】P1 告警触发时必须进入「调查模式」（InvestigationMode）
  InvestigationBanner 全宽置顶，颜色 #7C3AED/20 + 边框 #7C3AED
  自动选中 P1 设备，IntelPanel 展示对应诊断
  不可降级为 toast 通知（会被忽视）
  见：UI-UX-DESIGN §22.2

【UI 铁律 4】全局搜索 Cmd+K 必须实现
  可搜：设备/工单/告警/知识文档
  结果点击后路由到正确视图并自动选中对象
  见：UI-UX-DESIGN §22.5，MODULE-DESIGN-STUDIO §30（CommandPalette）

【UI 铁律 5】颜色必须从 tokens.ts 取，不允许硬编码
  src/styles/tokens.ts → COLORS / CX 是唯一来源
  错误示例：className="text-red-500"  ← 不知道这是告警还是普通红色
  正确示例：className={COLORS.semantic.alarm}  或  "text-[#EF4444]"（允许 TW arbitrary）
  见：UI-UX-DESIGN §22.8

【UI 铁律 6】IntelPanel 右侧面板：选中设备显示 DeviceIntelPanel，无选中显示 AlarmQueuePanel
  禁止：空状态时显示空白页或"请选择设备"占位
  原因：没有选中设备时，全局告警最有价值
  见：MODULE-DESIGN-STUDIO §17（IntelPanel）

【UI 铁律 7】NavRail 顶部必须有 StationHeatmap（站场热力图）
  热力图显示各区域状态色块，是 Situation Awareness Level 1 的基础
  即使只有一个站，也要显示（各区域概念是确定的）
  见：MODULE-DESIGN-STUDIO §29

【UI 铁律 8】工单草稿 WorkOrderDraftInline 必须内嵌，不跳页面
  在 DeviceIntelPanel 内部切换 tab，不用 router.navigate
  原因：跳页面会丢失设备上下文，AIP 范式要求操作可随时取消
  见：MODULE-DESIGN-STUDIO §27，UI-UX-DESIGN §22.4

【UI 铁律 9】Studio 只支持桌面（≥ 1024px），移动端引导至飞书 App
  < 1024px 显示 MobileGuard 组件（引导语 + 飞书二维码）
  不做 Studio 的移动端响应式适配
  见：UI-UX-DESIGN §22.9

【UI 铁律 10】AI 输出必须有置信度颜色和 Citations 可点击
  AIInsightCard：置信度 ≥ 0.8 绿，0.6-0.8 黄，< 0.6 红
  Citations 每条都是可点击链接，指向 KB 文档 URL
  见：UI-UX-DESIGN §十八，MODULE-DESIGN-STUDIO §18

【UI 铁律 11】中央视图五个 Tab，顺序固定
  孪生（🏭）→ 关系图（🕸）→ 趋势（📈）→ 工单（📋）→ P&ID（📐）
  CenterView 类型：twin | graph | trend | kanban | pid
  见：MODULE-DESIGN-STUDIO §30

【UI 铁律 12】断网时必须显示 OfflineBanner，不白屏
  ServiceWorker 缓存最后已知状态
  顶部橙色横幅："⚡ 数据连接中断 · 最后更新 xx 秒前"
  见：CRITICAL-REVIEW-WAVE2 §3（冷启动/离线）
```

---

## 12. 文档权威层级（哪个说了算）

```
Level 0（铁律，最高权威）：
  本 SKILL.md §1（架构铁律）+ §11（UI 铁律）
  → 违反时项目可能失控，需要全员 review 才能修改

Level 1（设计定稿，开发参考）：
  CLAWTWIN-MASTER-V2.md      → 整体架构、技术栈、AI能力
  MODULE-DESIGN-PLATFORM.md  → 后端 API 契约（以最新 §1x 为准）
  MODULE-DESIGN-STUDIO.md    → 前端组件实现（以最新 §2x 为准）
  UI-UX-DESIGN.md            → UI/UX 规范（以最新 §2x 为准）

Level 2（决策记录，解释为什么）：
  ADR-2 到 ADR-7             → 已做的架构决策和理由
  CRITICAL-REVIEW-*.md       → 批判审查和修正方向

Level 3（执行手册）：
  PHASE-A-SCAFFOLD.md        → 代码脚手架（直接 copy）
  PHASE-A-RUNBOOK.md         → 运行手册（安装步骤）
  DEVELOPMENT-MILESTONES.md  → 里程碑和验收标准

战略蓝图（Level 1，定位与愿景）：
  PRODUCT-NAMING-AND-MODULES.md → 产品命名/商业定位/完整模块接口（2026-05-11）★最新
    § 一   命名体系（ClawTwin Nexus/Studio/Sage/Connect 命名原因）
    § 二   各产品商业定位与边界（职责/不做/商业模式）
    § 三   完整架构图（命名修正版）
    § 四   Nexus 完整模块目录（engines/connectors/routers 全量）
    § 四.2 完整 API 接口清单（AUTH/ONTOLOGY/OBJECTS/EQUIPMENT/KB/AI等 100+接口）
    § 五   Sage 技能清单（9个Skill + Prompt模板库 + 知识包结构）
    § 六   Connect 连接器接口规范（BaseConnector/OTConnector/ITConnector）
    § 七   Studio 完整页面与组件清单（路由/布局/业务/AI/管理员 组件）
    § 八   数据库完整表清单（业务/知识/AI/本体/P&ID 全量表）
    § 九   对外接口规范（鉴权/响应格式/Webhook事件）
    § 十   命名迁移对照表（旧名→新名）
  PRODUCT-VISION-V3.md → 产品哲学与愿景 V3（2026-05-11，权威定位文档）
    § 一   哲学层：工业知识三次工业化，我们在做什么
    § 二   产品层：Schema + Runtime + Intelligence 三层分离
    § 三   架构层：组件映射、数据流方向、可替换性原则
    § 四   商业层：数据飞轮、三层变现、关键项目战略
    § 五   竞争定位：为什么传统大厂做不了
    § 六   产品边界终极定义（构建什么 / 不构建什么）
    § 七   不同受众的产品定义（CIO/工厂经理/投资方）
    § 八   对现有文档的权威修正（产品名称/Platform定位/商业愿景）
  ENTERPRISE-AI-TRANSFORMATION.md → 企业 AI 改造框架（2026-05-11）
    § 一   范式转移：为什么传统企业 IT 需要被重新设计
    § 二   企业 AI 改造三阶段（叠加→中枢→原生）
    § 三   重新设计的五层架构（含 Enterprise Connector Layer）
    § 四   关键问题回答（飞书定位/OA替代/Platform边界/商业角色）
    § 五   当前设计的核心调整（连接器层/工单双写/飞书OA集成）
    § 六   与传统IT共存策略（语义叠加，不推倒重建）
    § 七   产品定位总结（一句话定位/竞争差异/商业演进）

Level 4（参考资料，信息可能过时）：
  FINAL_*.md / PRODUCT-PLAN-*.md / ENTERPRISE_*.md
  → 早期版本，部分内容已被 V2 取代，仅供历史参考

规则：同层文档有冲突 → 以章节中较新的 §编号优先
      不同层文档有冲突 → 以较高 Level 为准
      任何情况有疑问 → 来本 SKILL.md 找对应章节索引
```

---

## 13. 设计文档全清单（带绝对路径）

```
# 目录：/Users/power/Projects/openclaw/contrib/industrial-oilgas-skills/

核心开发文档（Level 1，必读）
├── CLAWTWIN-MASTER-V2.md         1723 行  总架构定稿
├── MODULE-DESIGN-PLATFORM.md     3813 行  后端 API 全量实现
├── MODULE-DESIGN-STUDIO.md       3891 行  前端组件全量实现
├── UI-UX-DESIGN.md               2770 行  UI/UX 设计规范
├── STRATEGIC-PROPOSAL-V1.md      1334 行  客户战略提案
├── PHASE-A-SCAFFOLD.md           1236 行  Phase A 脚手架
├── DEVELOPMENT-MILESTONES.md      480 行  里程碑路线图
├── INTEGRATION-AND-GAPS.md        678 行  集成清单
└── clawtwin-project/SKILL.md      503 行  本文件（开发主引导）

批判审查文档（Level 2，理解"为什么"）
├── CRITICAL-REVIEW-AND-EVOLUTION.md  899 行  Wave 1 技术批判
├── CRITICAL-REVIEW-WAVE2.md          559 行  Wave 2 体验批判
├── PHILOSOPHY-ECONOMICS-REVIEW.md    740 行  哲学经济学审查

ADR 决策记录（Level 2，有争议时参考）
├── ADR-2-PLATFORM-BOUNDARY.md     609 行
├── ADR-3-REALITY-CHECK.md         612 行
├── ADR-4-SKILL-DESIGN-AND-REVIEW.md  518 行
├── ADR-5-FEISHU-DEPLOYMENT-AND-GATEWAY.md  433 行
├── ADR-6-SECURITY-ARCHITECTURE.md 621 行
└── ADR-7-IMS-AUTH-AND-OPENCLAW-DEPLOYMENT.md  439 行

运维部署（Level 3）
├── PHASE-A-RUNBOOK.md             433 行
├── OPCUA-BRIDGE-DESIGN.md         405 行
├── OPENCLAW-SETUP-GUIDE.md        250 行
└── PRODUCTION-ARCHITECTURE-REVIEW.md  693 行

OpenClaw Skills（能力边界）
├── clawtwin-project/SKILL.md      503 行  项目主引导
├── industrial-twin/SKILL.md        63 行  3D孪生操作
├── industrial-kb/SKILL.md         106 行  知识库操作
├── industrial-workorder/SKILL.md   95 行  工单管理
├── industrial-analytics/SKILL.md   90 行  数据分析
└── industrial-simulation/SKILL.md  47 行  仿真分析

早期文档（Level 4，仅参考）
├── FINAL_ARCHITECTURE.md / FINAL_DEVELOPMENT_PLAN.md / FINAL_PRODUCT_PLAN.md
├── PRODUCT-PLAN-V2.md / ENTERPRISE_ARCHITECTURE_COMPLETE.md
├── MASTER_PRODUCT_STRATEGY.md / TECH_DECISIONS.md
├── VISION_METAVERSE_INDUSTRY40.md / INDUSTRIAL_BRAIN_MASTER.md
└── ARCH_DECISION_RECORD.md / STRATEGIC_REVIEW_INVESTOR_USER.md
```

---

## 14. 快速参考更新（UI-UX-DESIGN 新增章节索引）

```
UI 新增索引（UI-UX-DESIGN.md）：
  § 十六  P&ID 工艺流程视图设计原则
  § 十七  视觉巡检 UX（Qwen2.5-VL 流程）
  § 十八  AI 置信度显示规范（三级颜色 + Citations）
  § 十九  设备健康评分卡（多维评分算法）
  § 二十  认知科学 UI 优化（RPD+SA+决策疲劳）
           - §20.1 One Big Action 主按钮设计
           - §20.2 UrgencyCountdown 倒计时组件
           - §20.3 SpectrogramView 频谱图组件
           - §20.4 StationHeatmap 站场热力图
           - §20.5 ShiftHandoverCard 班次交接卡
  § 二十一 决策效率业务逻辑状态机
           - §21.1 设备状态→UI呈现映射规则
           - §21.2 AI主行动决策树（Platform端）
           - §21.3 完整用户操作流（6步）
           - §21.4 飞书Bot意图驱动流程
           - §21.5 数据质量降级规则
           - §21.6 Admin数据质量Dashboard
  § 二十二 Palantir UI 深度映射
           - §22.1 Palantir 7条核心设计原则映射表
           - §22.2 调查模式（InvestigationMode）实现
           - §22.3 对象页（Object Page）5段结构规范
           - §22.4 AIP 行动确认流（WorkOrderDraftInline）
           - §22.5 全局搜索 CommandPalette（Cmd+K）
           - §22.6 3D/地图视图行为规范
           - §22.7 本体关系图（Graph View）规范
           - §22.8 语义化颜色系统（tokens.ts）
           - §22.9 响应式断点规范（桌面优先）

MODULE-DESIGN-PLATFORM 生产级架构（§二十二～二十四，2026-05-09）：
  § 24.1  完整 main.py（权威版本，含所有路由注册和 lifespan）
  § 24.2  **KB / 向量**：**pgvector** + `kb.py` 路由（历史 **`services/kb.py` Milvus** 段落：**心理模型替换**为 **pgvector**，勿新接 pymilvus）
  § 24.3  完整 Tool API（kb/search + diagnose + ai-draft + analyze_pid + health-score）
  § 24.4  scheduler/jobs.py + anomaly_poll_job（完整实现）
  § 24.5  数据流全景图（传感器→IngestPipeline→SSE→Studio→用户）
  § 24.6  OpenClaw Skill → Platform 完整调用链（Step-by-step HTTP 示例）

MODULE-DESIGN-PLATFORM 架构完整性（§二十五，2026-05-09）：
  § 25.1  模型部署规划（GPU内存布局：Qwen3-35B/bge-m3/MOIRAI；A100/4090/双卡方案）
  § 25.2  MOIRAI时序预测真正接入（双轨检测：即时阈值 + ML预测趋势；predict_anomaly实现）
  § 25.3  飞书完整事件处理链（签名验证 → card.action.trigger → HITL FSM）
  § 25.4  全链路Trace ID（TraceMiddleware + X-Trace-Id header贯穿所有日志）
  § 25.5  IngestPipeline背压（70%降采样/90%丢弃/满时不阻塞；drop_rate metrics暴露）
  § 25.6  Studio状态所有权协议（SSE vs React Query 分工表 + 断线快照重连）
  § 25.7  完整系统依赖图（模型×接口×资源一览图）
  § 25.8  架构自检清单（开发者PR前11条必过）

MODULE-DESIGN-PLATFORM 生产级架构（§二十二，2026-05-09）：
  § 22.1  统一 API 响应格式（ok/paginate/err + ApiError）
  § 22.2  数据摄入管道 IngestPipeline（emit → 消费者链，Phase B 换 Kafka）
  § 22.3  AI 推理异步接口（task_id 模式，Phase A 假异步，Phase B ARQ）
  § 22.4  per-station IMS 配置入库（stations.ims_config JSONB）
  § 22.5  统一分页规范（get_pagination + paginate()）
  § 22.6  结构化日志（structlog，JSON 输出，Loki 可索引）
  § 22.7  健康检查 /health + Prometheus /metrics
  § 22.8  数据库连接池配置（pool_size/recycle/pre_ping）
  § 22.9  分布式锁（Phase A 跳过，Phase B Redis SET NX）
  § 22.10 Security Headers + Rate Limiting（slowapi + CORS 精确配置）
  § 22.11 完整 settings.py 配置清单
  § 22.12 三阶段演进路线图（Phase A→B→C，接口不变换实现）

MODULE-DESIGN-PLATFORM 新增章节：
  § 二十六  架构根本修正：Platform 不做 AI 推理（Foundry+AIP 分层的真正实现）
            → Platform 只用 bge-m3（embed）和 MOIRAI（后台），不调 vLLM chat
            → OpenClaw Skill 直接调 GPU Server 做推理，Platform 只提供数据
  § 二十七  举一反三：全系统模块边界完整审计（14项违规→逐一修正）
            § 27.3  权威接口矩阵（Studio/Skill/Platform 谁能调谁）
            § 27.4  analyze_pid 修正（Platform 纯数据，分析在 Skill）
            § 27.5  /v1/ai/jobs：Studio 触发 AI 的唯一合法路径
            § 27.6  compute_primary_action：纯规则引擎，无 LLM
            § 27.7  Platform services/ 最终权威目录
            § 27.8  settings.py 最终权威版（删除推理配置）
            § 27.9  完整数据流架构图（含 AI 任务流、规则流、OT流）
            § 27.10 开发者 PR 自检清单（11条，替换 §25.8）

MODULE-DESIGN-PLATFORM §二十八（2026-05-11，产品蓝图与开发框架）：
  § 28.1  5层架构原则对照（智能问数 vs ClawTwin）
  § 28.2  当前设计客观评估（✅做对的 / ⚠️不足 / 📝过度设计）
  § 28.3  本体层务实实现（3张表 + /v1/ontology/* API，替代代码 Dict）
  § 28.4  知识冷启动内容清单（L0/L1/L2 最小集 + seed 脚本）
  § 28.5  Phase A MVP 边界（1站场/1设备类型/64人天估算）★必读
  § 28.6  Skill Prompt 工程（工业诊断 Prompt 模板，质量核心）
  § 28.7  工业智能问数（有限 API 端点 + 意图映射，替代 NL2SQL）
  § 28.8  成熟产品使用决策（使用者 vs 开发者，核心 IP 边界）
  § 28.9  完整 5层架构图（工业场景定制版，权威图）
  § 28.10 开发里程碑（A1数据进来/A2AI能用/A3HITL闭环，各4周）
  § 28.11 对外产品叙事（准确表述，避免过度承诺）

MODULE-DESIGN-STUDIO 新增章节：
  § 二十二  P&ID 视图（react-flow）
  § 二十三  HealthScoreCard 设备健康评分卡
  § 二十四  VisualInspectionPanel 视觉巡检
  § 二十五  AlarmManager ISA-18.2 告警管理
  § 二十六  路由更新（/studio/pid）
  § 二十七  DeviceIntelPanel V2 决策整合重构 ★核心
  § 二十八  useEquipmentIntel V2（primaryAction+urgency）
  § 二十九  NavRail V2（热力图+班次交接+告警Tab）
  § 三十    StudioShell Tab 含 P&ID（CenterView类型）
  § 三十一  Platform 新端点（spectrum/handover/compute_primary_action）
  § 三十二  组件文件结构总图（最终版）
  § 三十三  Admin 后台页面（AdminLayout/Users/Stations/Equipment/KB/System + 公共组件）


⚠️  API 路径冲突裁定（DESIGN-FINAL-LOCK.md 为最终权威，所有开发以此为准）：
  路径冲突已全部裁定（9项），见 DESIGN-FINAL-LOCK.md §八

⚠️  以下文档含废弃 API 路径，仅作架构思想参考，路径以 DESIGN-FINAL-LOCK.md 为准：
  [已废弃路径] CLAWTWIN-MASTER-V2.md  ← /v1/objects/* /v1/tools/* 路径已废弃
  [已废弃路径] ADR-2-PLATFORM-BOUNDARY.md  ← 同上
  [已废弃路径] PRODUCT-PLAN-V2.md  ← 同上
  [局部废弃] ARCHITECTURE-UPGRADE-V2.md §API表 ← PUT /v1/tools/ai-jobs/{id}/result 已废弃

开发权威参考文档（P0 级，开发直接依据）：
  DESIGN-FINAL-LOCK.md             ← 【P0·冲突裁定终态】API/枚举/表+头注 **cwd 指针** ★开发前必读
  NEXUS-API-REFERENCE.md           ← 【P0·API完整手册】联调必读；头注链 **DEV §〇 / platform-api README / TESTING §二.0**
  TESTING-GUIDE.md                 ← 【P0·测试指南】**§二.0 cwd** + pytest模板+Vitest+CI ★必读
  MODULE-DESIGN-PLATFORM.md        ← 【P0·平台设计】§18 API路由+§19 ORM+§20扩展（路径以LOCK文档为准）
  DEVELOPMENT-CONTRACT.md          ← 【P0·开发契约】工单FSM+安全铁律+检查清单 + 文首 cwd/索引指针

战略与架构综合文档（2026-05 新增/更新）：
  MASTER-ARCHITECTURE-AND-DEV-GUIDE.md ← 【综合终版 V3】OpenClaw记忆系统分析+模块边界最终定义+多用户/多站场设计+Cursor多任务实战指南★首先必读
  ARCHITECTURE-PROTOCOL-ANALYSIS.md   ← 【协议分析 V2】OpenClaw全协议分析+Hermes源码实证（Hermes可替代OpenClaw/MCP提前Phase A/最小协议集合）★必读
  ARCHITECTURE-FINAL-REVIEW.md        ← 基于OpenClaw源码考证的架构终审（ACP/ACPX/MCP真实含义/飞书双通道纠正/谁调用谁的权威答案）★必读
  NEXUS-BUSINESS-LOGIC.md           ← Nexus 内部运转（三类操作/事件总线/泳道图/状态机/领域边界/Pulse Engine/Policy Engine）★开发前必读
  ECOSYSTEM-AND-EXPERIENCE-VISION.md  ← 生态架构+体验愿景（JARVIS模型/游戏感设计/AI自主度五级/Pulse Engine/Fleet Intelligence/Command Screen）★产品对齐必读
  NEXUS-FRAMEWORK-ARCHITECTURE.md     ← Nexus框架化路线（OpenClaw对比/§十一 Agent可替换性：OpenClaw/HiAgent/Dify均适用）★架构决策必读
  ARCHITECTURE-UPGRADE-V2.md          ← 生产级架构升级（控制面/运行面分离/Reconciliation Loop/Kafka统一事件总线/TimescaleDB连续聚合/Studio插件体系）★Phase B蓝图 [API路径以LOCK为准]
  DESIGN-COMPLETION.md                 ← P0/P1设计补全（MSW Mock/飞书卡片JSON/TimescaleDB SQL/Admin API/Pulse Engine代码/Alembic迁移/settings.py终版）★开发启动前必读
  NEXUS-HEADLESS-INTEGRATION.md        ← Nexus无界集成架构（OA审批AI增强/Context API规范/Webhook订阅/IT底座模式/Embed Widget/三种部署模式）★产品定位必读
  COMMERCIAL-ARCHITECTURE.md          ← 商业模式+决策枢纽架构（OpenClaw模式分析/BUSL许可证/DecisionPackage预计算/开源策略修正§十）★商业化必读
  PARALLEL-DEV-TASKSPEC.md            ← Cursor多任务并行开发规范（Track A/B/C/UI任务分解/接口契约/Done标准/MSW Mock规范）★并行开发必读
  STUDIO-UI-ARCHITECTURE.md           ← Studio UI架构专项（状态分层/SmartFetcher/SSE连接管理/组件分层/3D集成/权限感知渲染）★前端架构必读
  DESIGN-COMPLETENESS-AUDIT.md        ← 设计完成度审计（98%完成度/已解决所有P0-P1项/冲突裁定已归入LOCK）
  ADR-8-AGENT-INTEGRATION.md          ← Agent集成定义（MSW说明/双向连接/OpenClaw+HiAgent+Dify对接方式，已被ARCHITECTURE-FINAL-REVIEW.md补充）
  KB-SEED-CONTENT.md                  ← L0/L1知识库种子清单（优先级分类/工业标准文档/10道验收题/2周入库计划）★交付前必须完成
  DEV-QUICKSTART.md                   ← 开发快速启动（**§〇** 多仓 + **§三** platform-api + **§四** refine-clawtwin；§二 历史 Compose）★新成员第一手参考
  MASTER-ARCHITECTURE-REVIEW.md     ← 多视角架构综合审视（PM/架构师/哲学/集成专家，含工程陷阱清单）
  PRODUCT-NAMING-AND-MODULES.md     ← 产品命名/商业定位/穷举模块接口（ClawTwin Nexus/Studio/Sage/Connect）
  PRODUCT-VISION-V3.md              ← 产品愿景 V3（三层分离 Schema/Runtime/Intelligence，知识飞轮）
  ENTERPRISE-AI-TRANSFORMATION.md   ← 企业 AI 改造框架（五层架构，传统 IT → AI 系统路径）

工业场景审计（2026-05-11）：
  INDUSTRIAL-SCENARIOS-COMPLETE.md   ← 【P0·场景审计】全工业场景覆盖度分析（36个场景/Phase A缺口/设备状态枚举/工单类型终态）★架构验收必读
  CURSOR-MULTITASK-GUIDE.md          ← 【P0·操作手册】**§七** cwd 前缀 + **§八** Review + 任务/@/提示词 ★开发启动必读
  NEXUS-OS-ARCHITECTURE.md          ← 【P0·架构范式】Nexus工业OS设计，MCP工具集全表，CLI设计，知识飞轮 ★架构理解必读
  ARCHITECTURE-SIMPLIFICATION-AUDIT.md ← 【P0·技术选型权威】Phase A精简栈（4服务），移除Ditto/Kafka/Milvus/AGE的决策依据 ★开发前必读
  ARCHITECTURE-FINAL-CRITICAL-AUDIT.md ← 【P0·最终批判审查】LlamaIndex替换自研RAG/Grafana嵌入/开源数据资源/成熟库清单（第三次也是最后一次系统审查）★必读
  CORE-ARCHITECTURE-AUDIT-2026.md      ← 【P0·核心架构升级】LLM Trace/统一Approval/业界对标（§3 已被 ARCHITECTURE-PRUNING-2026 §三 取代）
  ARCHITECTURE-PRUNING-2026.md         ← 【P0·剪枝原则】@tool 装饰器/Provider/Stream/Industry Pack（仍有效，但服从 INDUSTRIAL-FOUNDRY-ARCHITECTURE）
  INDUSTRIAL-FOUNDRY-ARCHITECTURE.md   ← 【P0·最高架构权威·v1.1】ClawTwin = Industrial Foundry（不是 Agent）：Ontology/ObjectType/ActionType/FunctionType/Pipeline/Markings/AgentRuntime/Connector ★所有架构疑问以此为准
  USER-ENVIRONMENT-DELIVERY-VALIDATION.md ← 【P0·最高交付权威】用户真实环境（飞书+OpenClaw/HiAgent+IMS）反推架构：AgentRuntime抽象/Connector抽象/SoT策略/部署形态 ★所有交付/实施/销售疑问以此为准
  TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md ← 【P0·最高选型权威】buy/borrow/build三问 + 强制借力清单（LinkML/Airbyte/Refine/Casbin/OpenLineage/OSDU/ISO）+ 价值ROI审计 ★所有"造轮子"决定以此为准

Skills（AI能力配置）：
  industrial-analytics/SKILL.md      ← 趋势分析 Skill
  industrial-kb/SKILL.md             ← 知识库检索 Skill
  industrial-workorder/SKILL.md      ← 工单管理 Skill
  industrial-twin/SKILL.md           ← 设备孪生读取 Skill
  industrial-admin/SKILL.md          ← 【2026-05新增】系统运维管理 Skill（sys_admin专用，自然语言运维）
  industrial-shift/SKILL.md          ← 【2026-05新增】班次交接 Skill（交接报告/接班确认/飞书推送）
  industrial-production/SKILL.md     ← 【2026-05新增】生产数据 Skill（录入日报/月度汇总/KPI解读）
  industrial-inspection/SKILL.md     ← 【2026-05新增】巡检管理 Skill（逾期预警/触发巡检工单/异常升级）

【已裁定的9项 API 路径冲突（查证来源：全量文档扫描 2026-05-11）】：
  C-01 决策包路径 → GET /v1/equipment/{id}/decision-package
  C-02 SSE端点   → GET /v1/sse/station/{id} + GET /v1/sse/ai-jobs/{id}
  C-03 AI Job回调 → POST /v1/ai/jobs/{id}/result（非 PUT /v1/tools/ai-jobs/{id}/result）
  C-04 工单路径   → POST /v1/workorders/ （非 /v1/tools/workorder/create）
  C-05 知识库路径 → GET /v1/kb/search （非 /v1/tools/kb/search）
  C-06 设备路径   → GET /v1/equipment/{id} （非 /v1/objects/equipment/{id}）
  C-07 MCP Phase  → Phase A 必做（非 Phase B）
  C-08 飞书Webhook → 不处理 im.message.receive_v1（路由给 OpenClaw）
  C-09 Agent回调  → MCP为主工具调用路径；REST回调仅用于异步任务回写

【架构已修正的错误（查证来源：OpenClaw 源码 extensions/acpx/ 和 extensions/feishu/）】：
  · ACP = OpenClaw 的 Agent Communication Protocol（连接外部 AI Agent 的协议，非业界通用标准）
  · ACPX = ACP eXtension，OpenClaw 原生扩展，可通过 mcpServers 配置外接 MCP Server
  · 飞书对话消息直接进入 OpenClaw（不经过 Nexus），Nexus 只接收卡片回调和发送推送
  · MODULE-DESIGN-PLATFORM.md 中 im.message.receive_v1 的错误处理代码已修正
  · OpenHermes 非 LLM，Hermes 是 OpenClaw 的前身/竞品（ACP 兼容的 Agent 平台）
```
