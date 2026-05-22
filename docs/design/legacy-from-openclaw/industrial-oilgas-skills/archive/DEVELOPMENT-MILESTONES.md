# ClawTwin 开发里程碑计划

## 从设计文档到可交付产品的完整路线图

> 文档版本：1.0，2026-05-09  
> 面向：开发团队（技术实现）+ 客户方（进度跟踪）+ 管理层（投资决策）  
> 关联文档：`clawtwin-project/SKILL.md`（开发指导）、`CLAWTWIN-MASTER-V2.md`（架构权威文档）

---

## 一、里程碑总览

```
Phase A：AI 副驾驶（可演示 → 生产就绪）
  M1  Week 2   基础设施就绪                     ████ → 开发者可跑起来
  M2  Week 4   数字孪生核心可见                  ████ → 客户看到 3D
  M3  Week 6   AI 知识问答上线                   ████ → AI 回答带 citations
  M4  Week 8   HITL 工单闭环                     ████ → 飞书一键审批
  M5  Week 10  告警 + 晨报 + 数据质量             ████ → ISA-18.2 合规
  M6  Week 12  Phase A 交付                       ████ → 客户 Demo 就绪

Phase B：生产接入（实际数据 → 预测维护）
  M7  Month 4  OPC-UA 真实数据接入               ████ → 真实传感器数据
  M8  Month 5  MOIRAI 时序预测上线               ████ → 提前预警
  M9  Month 6  L3 知识自动沉淀                   ████ → 越用越聪明
  M10 Month 9  多场站 + IMS 集成                  ████ → 企业级交付

Phase C：AI 主驾驶（高级 AI 能力）
  M11 Month 12 P&ID 视图 + 能耗优化              ████ → 工程师工具
  M12 Month 15 视觉巡检 AI                       ████ → Qwen2.5-VL
  M13 Month 18 AVEVA PI 集成                     ████ → 存量客户接入
  M14 Month 24 无人场站阶段一验收                 ████ → 阶段三起点
```

---

## 二、Phase A 详细里程碑（每两周一个可见交付物）

### M1（第 1-2 周）：基础设施就绪

**目标**：任何开发者可以在 30 分钟内把完整系统跑起来。

**技术任务**：

```
□ Docker Compose 完整配置（platform-api, studio, postgres[pgvector+timescaledb], redis, vllm, openclaw）
□ Alembic 数据库迁移脚本（User, Station, Equipment, WorkOrder, KBDocument, EquipmentReading）
□ TimescaleDB 超表创建（equipment_readings）
□ Mock 数据种子脚本（2 个场站，10 台设备，30 天历史数据）
□ /v1/health 健康检查端点
□ 基础 auth（JWT 登录/注册/refresh）
□ Studio 基础骨架（Vite + React + Tailwind 跑起来，登录页）
□ .env 模板 + README 快速启动文档
```

**验收标准**：

```bash
git clone <repo>
cp .env.example .env
docker compose up -d
# 等待 60 秒
curl http://localhost:8080/v1/health     # → {"status": "ok"}
open http://localhost:3000               # → 看到登录页面
# 用 admin/admin123 登录，能看到 Studio 主界面
```

**对用户可见的产出**：截图：系统跑起来 + 登录成功界面

---

### M2（第 3-4 周）：数字孪生核心可见

**目标**：客户第一眼看到 ClawTwin 的"样子"——3D 场景 + 实时状态颜色。

**技术任务**：

```
□ /v1/stations/{id}/equipment 设备列表 API（含实时状态）
□ /v1/equipment/{id}/readings/latest 最新读数 API
□ Babylon.js 基础场景（StudioShell + TwinSurface）
  □ 5 台设备 3D 方块（Phase A 用方块代替真实模型，Phase B 替换）
  □ 设备点击 → 右侧情报面板（R 区）展示
  □ 状态颜色实时更新（绿/黄/红，10 秒轮询）
□ 右侧情报面板（IntelPanel / DeviceIntelPanel）
  □ MetricBar 实时指标
  □ 趋势迷你图（最近 24 小时）
□ NavRail 左侧对象列表（按状态排序）
□ TimeLine 底部时间轴（Phase A 实现时间范围选择）
```

**验收标准**：

```
□ 打开 Studio /studio/twin，看到 5 台设备 3D 场景
□ 点击 C-001（模拟振动超阈值），设备变红，右侧显示实时指标
□ 右侧面板显示 24h 趋势图，振动值可见上升趋势
□ 不同角色（operator/supervisor）登录，权限差异可见
```

**对用户可见的产出**：GIF 动图：点击设备 → 右侧面板弹出 → 实时数据滚动

---

### M3（第 5-6 周）：AI 知识问答上线

**目标**：AI 能够回答专业问题，且答案可溯源（citations 可点击）。

**技术任务**：

```
□ 知识库初始化（L0/L1 预置）
  □ 导入 GB/T 7777 等 5 份行业标准（PDF → LlamaIndex SentenceSplitter → pgvector）
  □ 导入 3 份压缩机厂商手册（L1）
  □ 验证：搜索"振动超阈值"召回结果相关性 > 0.8
□ /v1/kb/search API（pgvector 语义检索 + LlamaIndex 元数据过滤）
□ /v1/tools/diagnose_equipment（LLM + KB 检索 + citations）
□ OpenClaw industrial-kb Skill（调用 Platform KB API）
□ OpenClaw industrial-twin Skill（调用 Platform 设备状态）
□ Studio 右侧 AIInsightCard 组件（citations 可点击跳转文档）
□ useEquipmentIntel Hook（设备选中自动触发 AI 分析）
□ 飞书 Bot 连接（OpenClaw 飞书 Webhook）
```

**验收标准**：

```
□ 飞书问："压缩机振动超 4mm/s 怎么处理？"
  → AI 回答包含具体操作步骤
  → 回答末尾有 ≥ 2 个 citations（文档名+章节可点击）
□ Studio 选中 C-001（振动告警状态）
  → 右侧自动出现 AI 分析（< 5 秒）
  → AIInsightCard 显示诊断摘要 + 引用来源
□ AI 回答的置信度标签显示正确颜色（绿/黄/红）
```

**对用户可见的产出**：视频：飞书问答 → AI 带 citations 回答（30秒演示）

---

### M4（第 7-8 周）：HITL 工单闭环

**目标**：从 AI 发现问题到工单审批完成，全流程无需离开飞书。

**技术任务**：

```
□ WorkOrder FSM（Pending → AI_DRAFT → Approved → In_Progress → Done）
□ /v1/workorders/ CRUD API + 状态转换端点
□ /v1/hitl/ 飞书回调处理（approve/reject/start/complete）
□ FeishuClient.send_workorder_card()（工单审批卡片推送）
□ FeishuClient.send_alert()（P1/P2 告警卡片）
□ OpenClaw industrial-workorder Skill（建工单草稿）
□ Studio 工单看板（Kanban 视图：4 列状态）
□ 工单完成 → write_l3_knowledge()（L3 知识自动写入）
□ Admin 工单详情页
```

**验收标准**：

```
端到端测试（全程 < 5 分钟）：
□ 1. Studio 手动触发模拟告警（C-001 振动 P2）
□ 2. 飞书操作员收到告警卡片（< 30 秒）
□ 3. 点击卡片「AI 建工单」→ Studio 工单看板出现草稿
□ 4. 主管飞书收到审批卡片（工单摘要 + AI 建议 + 审批按钮）
□ 5. 点击「通过」→ 工单状态变 Approved
□ 6. 操作员飞书收到接单通知，标记执行完成
□ 7. 工单 Done → Studio 状态更新，L3 知识库中可检索到本次经验
```

**对用户可见的产出**：视频：告警卡片 → 飞书审批 → 工单闭环（60 秒演示）

---

### M5（第 9-10 周）：告警管理 + 晨报 + 工业场景补全

**目标**：ISA-18.2 合规的告警管理 + 数据质量监控 + 生产数据/班次/巡检三大运营场景上线。

**技术任务：告警管理**

```
□ AlarmManager（去重、搁置、优先级排序）
  □ GET /v1/alarms/ API（list/acknowledge/shelve）
  □ POST /v1/alarms/{id}/shelve（必须含 reason 字段，ISA-18.2）
  □ GET /v1/alarms/kpi（alarm_rate_per_10min/standing_alarms/p1_response_compliance）
  □ Scheduler: alarm_restore_job（每 5 分钟检查 shelved_until 到期自动恢复）
  □ Scheduler: alarm_escalation_job（P1 超 5 分钟未确认推送 supervisor）
```

**技术任务：生产数据**

```
□ production_records 表 Alembic 迁移
□ GET /v1/production/records（日报列表）
□ POST /v1/production/records（创建/幂等更新，停输 >60min 须填原因）
□ GET /v1/production/summary（月度汇总）
□ GET /v1/production/kpi（可用率/完成率）
□ Studio ProductionPage（生产数据录入表单 + 月度图表）
```

**技术任务：班次管理**

```
□ shift_records 表 Alembic 迁移
□ GET /v1/shifts/current（当前班次）
□ POST /v1/shifts/（开始新班次）
□ POST /v1/shifts/{id}/handover（AI 生成摘要 + 飞书推送接班人）
□ POST /v1/shifts/{id}/confirm（接班人签收，仅 handover_to 本人）
□ GET /v1/shifts（班次历史）
□ Studio ShiftHandoverPage（交接班页面，含接班确认按钮）
```

**技术任务：巡检管理**

```
□ inspection_schedules 表 Alembic 迁移
□ GET /v1/inspection/schedules（巡检计划列表）
□ POST /v1/inspection/schedules/{id}/trigger（触发创建巡检工单）
□ GET /v1/inspection/overdue（逾期巡检预警）
□ 工单表单扩展：inspection 类型显示 checklist 填写界面
□ Studio InspectionPage（巡检计划 + 逾期提醒）
```

**技术任务：Scheduler 与晨报**

```
□ Scheduler 定时任务：08:00 晨报（含生产 KPI + 活动告警 + 待处理工单）
□ Scheduler 定时任务：每日触发当日巡检工单（来自 inspection_schedules）
□ DataQualityChecker（stuck_value, extreme_jump, timestamp_gap 检测）
□ Admin 数据质量 Dashboard
```

**验收标准**：

```
□ 模拟同时触发 3 个相关告警 → NavRail 显示合并为 1 条（含计数）
□ 点击搁置（含原因）→ 告警消失指定时长 → 时间到期自动恢复
□ P1 告警超 5 分钟未确认 → 飞书推送主管
□ GET /v1/alarms/kpi → 返回 isa_compliant、p1_response_compliance_pct
□ 录入今日生产数据 → GET /v1/production/kpi 返回正确可用率
□ 早 8 点晨报飞书卡片包含：昨日输量 + P1/P2 告警数 + 未完成工单数
□ POST /v1/shifts/{id}/handover → AI 摘要中包含在途工单和活跃告警
□ 接班人以外的用户调用 confirm → 返回 403 FORBIDDEN
□ GET /v1/inspection/overdue → 正确返回逾期巡检计划
```

**对用户可见的产出**：晨报卡片截图 + Studio ProductionPage + ShiftHandoverPage 截图

---

### M6（第 11-12 周）：Phase A 交付

**目标**：系统可以在客户服务器上部署，完整演示场景无报错。

**技术任务**：

```
□ 安全加固
  □ 所有 API 鉴权验证（RBAC 场景测试）
  □ Prompt Injection 防护测试
  □ 审计日志覆盖所有关键操作
□ Admin 完整实现
  □ 用户管理（创建/修改/角色/飞书绑定）
  □ 知识库管理（上传/检索测试/L3 管理）
  □ 服务令牌管理（Service Token for OpenClaw/HiAgent）
  □ 系统健康（Grafana 嵌入或原生健康页）
□ Nginx + TLS（自签名证书或 Let's Encrypt）
□ 一键部署脚本（setup.sh：检查依赖 → 配置 .env → docker compose up）
□ 运维手册（备份/恢复/日志查看/重启步骤）
□ Demo 脚本文档（演示给客户的完整 15 分钟流程）
□ Phase A 交付物清单 Checklist
```

**验收标准**（Phase A 完整 Demo）：

```
场景：「C-001 压缩机振动异常从发现到处置的完整闭环」15 分钟

□ 第 1-3 分钟：开场
  · 打开 Studio，展示 3D 场景（2 个场站，10 台设备）
  · 展示实时数据流动，NavRail 告警队列

□ 第 3-7 分钟：AI 智能诊断
  · 手动触发 C-001 振动告警（P2）
  · 告警卡片推飞书，3D 场景设备变红
  · 点击设备，AI 自动分析（展示 AIInsightCard + citations）
  · 飞书问：「C-001 振动历史上是怎么处理的？」
  · AI 回答包含 L3 历史工单 citation

□ 第 7-12 分钟：HITL 工单闭环
  · 点击「建工单」→ AI 草稿自动填充（展示内容质量）
  · 主管飞书收到审批卡片 → 点击「通过」
  · Studio 工单状态实时更新

□ 第 12-15 分钟：数据质量 + 晨报
  · 展示晨报卡片（昨日 KPI）
  · 展示数据质量 Dashboard（仪表校准提醒）
  · 演示告警搁置功能

结论：全流程无报错，客户决定进入 Phase B 签约
```

**对用户可见的产出**：Phase A Demo 视频（15 分钟完整演示录像）

---

## 三、Phase B 里程碑（真实数据 → 预测维护）

### M7（第 4 个月）：OPC-UA 真实数据接入

```
□ opcua-bridge 连接客户测试 OPC-UA Server（或 PI Web API）
□ Kafka 数据管道（bridge → Kafka → Platform consumer → TimescaleDB）
□ 延迟验证：< 5 秒端到端延迟
□ Eclipse Ditto 孪生实时化（实时状态 < 10 秒）
□ PIConnector（若客户有 PI System）

验收：Studio 显示的设备状态与现场仪表一致（现场人员确认）
```

### M8（第 5 个月）：MOIRAI 时序预测上线

```
□ 历史数据导入（至少 90 天历史 → TimescaleDB）
□ MOIRAI 推理服务部署（GPU 服务器）
□ 预测管道（每 15 分钟批量预测下一 24-72 小时趋势）
□ 预测结果可视化（Studio Trend View 叠加预测曲线）
□ 预测告警（MOIRAI 预测超阈值 → 提前推送飞书）

验收：对历史已知故障，MOIRAI 在事发 6 小时前预警准确率 > 65%
```

### M9（第 6 个月）：L3 知识自动沉淀验证

```
□ 工单 Done → write_l3_knowledge（已实现，本 M 做质量验证）
□ 积累 50+ 真实工单 → L3 知识条目
□ 验证：相似故障查询 → L3 命中率 > 70%
□ 飞书问「最近 3 个月 C-001 故障」→ AI 引用 L3 条目回答

验收：操作员反馈"AI 知道这台机子的历史"
```

### M10（第 9 个月）：多场站 + IMS 深度集成

```
□ 多场站权限隔离验证（A 站操作员看不到 B 站数据）
□ ERP 集成（设备台账同步）
□ CMMS 集成（工单双向同步）
□ OA/BPM 回调（生产工单走 OA 审批）
□ Grafana + Prometheus + Loki 生产监控
□ 性能基准：100 台设备实时更新，Studio 响应 < 2 秒

验收：Phase B 生产验收评审
```

---

## 四、Phase C 里程碑（AI 主驾驶）

| 里程碑 | 月份 | 核心交付                      | 验收标准                             |
| ------ | ---- | ----------------------------- | ------------------------------------ |
| M11    | 12   | P&ID 视图 + CoolProp 能耗优化 | 工程师通过 P&ID 视图发现工艺偏差     |
| M12    | 15   | 视觉巡检 AI（Qwen2.5-VL）     | 定时自动巡检，发现异常飞书推图片     |
| M13    | 18   | AVEVA PI 完整集成             | PI 历史数据入 MOIRAI，演示存量价值   |
| M14    | 24   | 无人场站阶段一验收            | 操作员 < 4 人/站，响应时间 < 30 分钟 |

---

## 五、开发进度可视化方案

### 5.1 每两周一次进度推送（自动化）

每个里程碑完成后，系统自动向项目飞书群推送进度卡片：

```
┌─────────────────────────────────────────────────────────────────────┐
│  🎯 ClawTwin 开发进度更新                     2026-05-23           │
├─────────────────────────────────────────────────────────────────────┤
│  M2 完成：数字孪生核心可见 ✅                                       │
│  ──────────────────────────────────────────────────────────────    │
│  ✅ 3D 场景：5 台设备可见，状态颜色实时更新                         │
│  ✅ 设备点击：右侧情报面板弹出，实时指标显示                        │
│  ✅ 趋势图：24h 历史数据可视化                                      │
│  ──────────────────────────────────────────────────────────────    │
│  下一里程碑：M3（AI 知识问答）预计完成：2026-06-06                  │
│  进度：Phase A 33%  ██████░░░░░░░░░░░  预计交付：2026-08-15        │
│                                                                     │
│  [查看 Demo 视频] [访问预览环境] [查看完整计划]                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.2 预览环境（Staging）

```
阶段性预览环境策略：
  M2 完成后：部署 staging 环境（内网可访问）
  · URL：http://clawtwin-dev.internal/
  · 数据：mock 数据（不含真实生产数据）
  · 账号：demo/demo123

每次 milestone 更新后：发送飞书卡片通知 + 更新 staging

Phase A 交付时：
  · 在客户服务器部署 demo 环境
  · 账号：客户 IT 管理员自行创建
  · 数据：行业知识包预置 + 标准压气站 mock
```

### 5.3 里程碑演示脚本库

为每个里程碑准备一个 5-10 分钟的屏幕录制脚本：

```
M1 Demo（5 分钟）：
  1. docker compose up 过程（快进）
  2. 访问 Studio 登录页
  3. curl /v1/health 输出 "status: ok"
  4. Swagger UI 展示所有 API 端点

M2 Demo（10 分钟）：
  1. 打开 Studio TwinPage
  2. 展示 3D 场景，切换不同状态设备
  3. 点击告警设备，右侧面板弹出
  4. 实时数据更新（模拟数值变化）

M3 Demo（10 分钟）：
  1. 飞书提问 → AI 回答带 citations
  2. Studio 选中设备 → AI 自动分析
  3. 展示 AIInsightCard，citations 可点击

M4 Demo（15 分钟）：完整 HITL 工单闭环

Phase A 交付 Demo（25 分钟）：完整 Demo 场景
```

### 5.4 开发 KPI 追踪（每周更新到飞书文档）

```
ClawTwin 开发健康指标（每周五 18:00 更新）：

技术指标：
  · API 端点覆盖率：已实现 / 计划总数
  · 测试覆盖率：%（目标 > 70%）
  · Docker Compose 一键启动成功率：%
  · 已知 Bug 数量（P0/P1/P2 分级）

进度指标：
  · 当前里程碑：M?
  · 本周完成任务：?
  · 下周计划任务：?
  · 阻塞项（Blockers）：?

知识资产指标：
  · KB 文档总数：?
  · L0 文档：? / 目标 50
  · L1 文档：? / 目标 20
  · pgvector 向量数（kb_embeddings 表行数）：?
```

---

## 六、开发团队分工建议

```
最小可行团队（Phase A 开发）：

角色 A：后端工程师（Python/FastAPI）
  负责：Platform API + AI 集成 + 飞书推送 + Scheduler
  重点文件：MODULE-DESIGN-PLATFORM.md

角色 B：前端工程师（React/TypeScript）
  负责：Studio 所有组件 + Babylon.js 3D + 飞书卡片样式
  重点文件：MODULE-DESIGN-STUDIO.md + UI-UX-DESIGN.md

角色 C：AI/知识工程师（可兼任后端）
  负责：知识库初始化 + OpenClaw Skills + MOIRAI 集成
  重点文件：clawtwin-project/SKILL.md + industrial-*/SKILL.md

角色 D：DevOps（可兼任后端或外包）
  负责：Docker Compose + Nginx + Grafana + 部署脚本
  重点文件：CLAWTWIN-MASTER-V2.md §二（部署架构）

人天参考：
  Phase A MVP（3 个月）：4 人 × 3 月 × 20 天 = 240 人天
  Phase B 生产接入（6 个月）：3 人 × 6 月 × 20 天 = 360 人天
  Phase C 高级功能：按功能模块单独立项
```

---

## 七、开发铁律（每个里程碑都必须遵守）

```
代码铁律：
  1. 每个 API 端点必须有对应的 curl 测试示例（在 MODULE-DESIGN-PLATFORM 中）
  2. 每个 React 组件必须有 Props 类型定义（TypeScript strict 模式）
  3. AI 输出必须携带 confidence 分数（禁止无置信度的 AI 结论）
  4. 所有 AI 建议 → 人工审批 → 才能进入下一步（Phase A 无例外）
  5. 数据质量检查在 AI 诊断前运行（拒绝坏数据，不降低标准）

验收铁律：
  1. 每个里程碑有明确的 curl/UI 验收测试（必须通过才算完成）
  2. Demo 场景必须在全新环境运行（不能"只在我电脑上能跑"）
  3. 飞书消息测试必须用真实飞书账号（不能用 Mock）
  4. 安全相关（JWT、ABAC、审计日志）在 M6 前全部完成，不留技术债

文档铁律：
  1. 每个 milestone 的 README 必须包含"30 分钟快速开始"
  2. 每次 DB Schema 变更必须有对应 Alembic migration
  3. 每个新 API 在 clawtwin-project/SKILL.md 更新引用
```

---

## 八、风险与应对

| 风险                                   | 影响       | 概率 | 应对                                                       |
| -------------------------------------- | ---------- | ---- | ---------------------------------------------------------- |
| LLM 推理质量不达标（citations 不准确） | M3 延期    | 中   | 预留 1 周 KB 质量调优时间；准备 fallback（规则引擎回答）   |
| 飞书 Webhook 配置复杂                  | M4 延期    | 高   | 提前 1 周申请飞书应用权限；准备 HTTP 测试替代方案          |
| Babylon.js 3D 性能问题                 | M2 延期    | 中   | Phase A 用简单方块模型；Phase B 才导入真实 GLB 模型        |
| OPC-UA 接入现场阻力                    | M7 延期    | 高   | Phase B 开始前提前 2 个月做协议确认；Phase A 全用 mock     |
| 团队对飞书 API 不熟悉                  | M4 延期    | 高   | 提前 1 周单独 spike 飞书卡片 + Webhook 技术验证            |
| MOIRAI 训练数据不足                    | M8 延期    | 中   | Phase B 开始立即收集历史数据；准备基于规则的 fallback 告警 |
| GPU 服务器采购/配置延误                | M3/M8 延期 | 中   | Phase A 用 API 接入（阿里云百炼）；准备 no-GPU 降级方案    |

---

_文档版本 1.0，2026-05-09。_  
_架构权威文档：`CLAWTWIN-MASTER-V2.md`。开发指导：`clawtwin-project/SKILL.md`。_  
_UI/UX 规范：`UI-UX-DESIGN.md`。后端实现：`MODULE-DESIGN-PLATFORM.md`。前端实现：`MODULE-DESIGN-STUDIO.md`。_

---

## 九、Phase A 开发清单 V2（基于最终设计文档，2026-05-09 更新）

> 本节是 M1-M6 的**精确开发清单**，替代 §二 的部分内容。  
> 每个任务标有文档出处，开发者可直接定位实现细节。  
> 格式：`□ 任务描述 [文档:章节]`

---

### M1 开发清单（Week 1-2：基础设施就绪）

**后端（Platform）**

```
□ docker-compose.yml：platform-api + studio + postgres(pgvector) + redis + vllm + openclaw
  [PHASE-A-SCAFFOLD.md §一 修正版 docker-compose]（不含 Milvus/MinIO/Kafka）
□ .env.example：完整环境变量模板（含 JWT_SECRET_KEY, FEISHU_VERIFY_TOKEN, VLLM_BASE_URL 等）
  [DEVELOPMENT-CONTRACT.md §四]
□ Alembic 初始化 + 迁移：users/stations/equipment/workorders/kb_documents/equipment_readings
  [MODULE-DESIGN-PLATFORM.md §二]
□ 补迁移：alarms 表（priority/state/shelved_until/count）
  [MODULE-DESIGN-PLATFORM.md §17.10]
□ TimescaleDB 超表：CREATE EXTENSION timescaledb + create_hypertable(equipment_readings)
  [MODULE-DESIGN-PLATFORM.md §二]
□ Apache AGE 扩展：CREATE EXTENSION age（因果图谱用）
  [CLAWTWIN-MASTER-V2.md §十三]
□ Mock 数据种子：2 个场站 / 10 台设备（含 area 字段用于热力图）/ 30 天历史数据
  [MODULE-DESIGN-PLATFORM.md §12.8]
□ 设备 area 字段：equipment 表加 area 字段（"压缩机区"|"计量区"|"阀组区" 等）
  [MODULE-DESIGN-PLATFORM.md §17.6]
□ /v1/health 健康检查端点
  [MODULE-DESIGN-PLATFORM.md §七]
□ /v1/auth/login + /v1/auth/refresh（JWT，bcrypt 密码）
  [MODULE-DESIGN-PLATFORM.md §十四]
□ 初始管理员账号种子（admin + 测试操作员 + 测试主管）
  [PHASE-A-SCAFFOLD.md §六]
```

**前端（Studio）**

```
□ Vite + React 18 + TypeScript + Tailwind 初始化
  [MODULE-DESIGN-STUDIO.md §二]
□ src/styles/tokens.ts：COLORS + CX 语义化颜色 Token（所有组件颜色从此取）
  [UI-UX-DESIGN.md §22.8]
□ auth.store.ts：Zustand 持久化存储（JWT + user + stationIds）
  [MODULE-DESIGN-STUDIO.md §三.1]
□ twin.store.ts：Zustand 全局状态（selectedEquipmentId + CenterView + selectedStationId）
  [MODULE-DESIGN-STUDIO.md §三.2]
□ RequireAuth 组件（路由守卫）
  [MODULE-DESIGN-STUDIO.md §二.0]
□ LoginPage.tsx（工号+密码登录，提交 POST /v1/auth/login）
  [MODULE-DESIGN-STUDIO.md §十.1]
□ App.tsx 路由：/login / /studio/twin / /studio/graph / /studio/trend / /studio/kanban / /studio/pid / /admin/*
  [MODULE-DESIGN-STUDIO.md §二十六]
□ StudioShell.tsx 骨架（五区布局：NavRail + CenterPanel + IntelPanel + TimeLine）
  [MODULE-DESIGN-STUDIO.md §三十]
□ MobileGuard 组件（< 1024px 拦截，引导飞书 App）
  [UI-UX-DESIGN.md §22.9]
□ nginx.conf（/v1/ 反代 platform-api，/ 服务 Studio 静态文件）
  [PHASE-A-SCAFFOLD.md 附录]
```

**验收**

```bash
git clone <repo> && cp .env.example .env && docker compose up -d
sleep 60
curl http://localhost:8080/v1/health                         # → {"status":"ok","db":"ok","redis":"ok"}
curl -X POST http://localhost:8080/v1/auth/login \
  -d '{"username":"admin","password":"admin123"}'            # → {"access_token":"..."}
open http://localhost:3000                                    # → 登录页
# 登录后看到 Studio 骨架（黑色主题，五区空白布局）
```

---

### M2 开发清单（Week 3-4：数字孪生核心可见）

**后端（Platform）**

```
□ GET /v1/stations/{id}/equipment → 设备列表（含 realtime 指标 + status）
  [MODULE-DESIGN-PLATFORM.md §三]
□ GET /v1/equipment/{id} → 设备详情（含 thresholds + realtime + area）
  [MODULE-DESIGN-PLATFORM.md §三]
□ GET /v1/equipment/{id}/realtime → 最新读数（轮询用，10 秒 TTL）
  [MODULE-DESIGN-PLATFORM.md §三]
□ GET /v1/stations/{id}/health-summary → 各区域状态（StationHeatmap 用）
  [MODULE-DESIGN-PLATFORM.md §17.6]
□ Scheduler Mock 数据更新：每 5 秒随机波动 1-2 个设备的读数（模拟实时）
  [MODULE-DESIGN-PLATFORM.md §九]
```

**前端（Studio）**

```
□ NavRail V2：顶部 StationHeatmap + 设备列表Tab + 告警Tab + 工单Tab + 底部班次交接按钮
  [MODULE-DESIGN-STUDIO.md §二十九]
□ StationHeatmap 组件：从 GET /v1/stations/{id}/health-summary 取数，色块显示各区域
  [UI-UX-DESIGN.md §二十 §20.4]
□ EquipmentRow（NavRail 设备列表行）：StatusDot + 设备名 + 关键指标值
  [MODULE-DESIGN-STUDIO.md §二十九]
□ TwinSurface（Babylon.js）：5个方块 Mesh + 状态颜色 + 点击选中 + 相机轨道控制
  [MODULE-DESIGN-STUDIO.md §五]
□ CenterTabBar：孪生/关系图/趋势/工单/P&ID 五个 Tab（CenterView 类型）
  [MODULE-DESIGN-STUDIO.md §三十]
□ IntelPanel 容器：选中设备→DeviceIntelPanel；无选中→AlarmQueuePanel
  [MODULE-DESIGN-STUDIO.md §十七]
□ DeviceIntelPanel V2 骨架（暂不含 AI 部分，只有 Header + MetricBar）
  [MODULE-DESIGN-STUDIO.md §二十七]
□ MetricBar 组件（compact 模式 + 展开模式，warn/alarm 双阈值线）
  [MODULE-DESIGN-STUDIO.md §九]
□ TimeLine 组件（底部时间轴，Phase A 实现时间范围选择器）
  [MODULE-DESIGN-STUDIO.md §二十一]
□ InvestigationBanner：P1 告警时顶部全宽橙色横幅（从 GET /v1/alarms/active 判断）
  [UI-UX-DESIGN.md §22.2]
```

**验收**

```
□ 打开 /studio/twin 看到 5 台设备 3D 方块，颜色随状态变化（10s 自动刷新）
□ NavRail 顶部热力图显示 3 个区域色块
□ 点击任意设备 → IntelPanel 展示设备名 + 实时指标条
□ 告警设备 Mesh 外有红色脉冲光晕
□ P1 告警时顶部出现调查模式 Banner（可在 Mock 数据中临时设置一台设备为 alarm）
```

---

### M3 开发清单（Week 5-6：AI 知识问答上线）

**后端（Platform）**

```
□ POST /v1/tools/diagnose_equipment（完整版，含 primary_action + predicted_breach_minutes）
  [MODULE-DESIGN-PLATFORM.md §17.1]
□ GET /v1/equipment/{id}/health-score（多维健康评分）
  [MODULE-DESIGN-PLATFORM.md §17.2]
□ POST /v1/kb/upload（PDF 摄入 → LlamaIndex SentenceSplitter → pgvector）
  [MODULE-DESIGN-PLATFORM.md §八]
□ POST /v1/kb/search（三层语义检索）
  [MODULE-DESIGN-PLATFORM.md §十]
□ POST /v1/tools/ask_knowledge（知识问答，含 citations）
  [MODULE-DESIGN-PLATFORM.md §三]
□ GET /v1/search（全局搜索，CommandPalette 用）
  [MODULE-DESIGN-PLATFORM.md §17.5]
□ build_equipment_context() 函数（构造 24h 趋势 + 5 工单 + KB 检索结果）
  [SKILL.md §8]
□ DataQualityChecker 集成到 diagnose_equipment（数据差时拒绝诊断）
  [CLAWTWIN-MASTER-V2.md §十六]
□ L0 知识库种子：≥ 20 篇标准文档入库（GB/T 压缩机标准 / API 650 等）
  [SKILL.md §8 冷启动]
□ vLLM 连通性验证（VLLM_BASE_URL 配置 + 健康检查）
  [MODULE-DESIGN-PLATFORM.md §12.3]
```

**前端（Studio）**

```
□ useEquipmentIntel V2 Hook：并发调 diagnose + health-score，解析 primaryAction + urgencyMinutes
  [MODULE-DESIGN-STUDIO.md §二十八]
□ AIInsightCard：流式输出（SSE 或轮询）+ Citations 可点击 + 置信度颜色
  [MODULE-DESIGN-STUDIO.md §十八 + UI-UX-DESIGN §十八]
□ PrimaryActionSection：One Big Action 大按钮（red/orange/blue/green，由 Platform 决定颜色）
  [MODULE-DESIGN-STUDIO.md §二十七]
□ UrgencyCountdown 组件：predicted_breach_minutes → "HH:MM 时:分"倒计时动画
  [UI-UX-DESIGN.md §二十 §20.2]
□ HealthScoreCard 组件：总分 + 4 个维度 + 趋势箭头 + AI 摘要
  [MODULE-DESIGN-STUDIO.md §二十三]
□ DeviceIntelPanel V2 完整布局（倒计时→主行动→AI情报→指标折叠→健康评分→工单）
  [MODULE-DESIGN-STUDIO.md §二十七]
□ CommandPalette（Cmd+K）：搜索设备/工单/告警/知识，点击跳转并选中对象
  [UI-UX-DESIGN.md §22.5，MODULE-DESIGN-STUDIO.md §三十]
□ AlarmQueuePanel（无设备选中时右侧面板）：P1/P2 告警列表，可点击选中设备
  [MODULE-DESIGN-STUDIO.md §二十五]
```

**验收**

```
□ 点击告警设备 → IntelPanel 顶部显示倒计时（如"01:23 时:分"）
□ One Big Action 区域显示橙色大按钮"建紧急预防性工单"，下方有 AI 理由
□ AIInsightCard 流式输出诊断摘要，置信度 ≥ 80% 时显示绿色
□ HealthScoreCard 显示总分和 4 维度（即使 Phase A 是部分 mock 数据）
□ Cmd+K 弹出搜索框，输入"C-001"找到设备并点击跳转
□ 知识问答（ask_knowledge）返回带 citations 的回答
```

---

### M4 开发清单（Week 7-8：HITL 工单闭环）

**后端（Platform）**

```
□ POST /v1/workorders/ai-draft（AI 预填草稿，优先用 Redis 缓存诊断结果）
  [MODULE-DESIGN-PLATFORM.md §17.4]
□ POST /v1/workorders/（建工单，服务端强制 state="draft"，见 §19.3 WorkOrderState）
  [MODULE-DESIGN-PLATFORM.md §三]
□ POST /v1/hitl/workorders/{id}/approve（主管审批，双重权限校验）
  [MODULE-DESIGN-PLATFORM.md §三]
□ POST /v1/hitl/workorders/{id}/reject（驳回）
  [MODULE-DESIGN-PLATFORM.md §三]
□ POST /v1/hitl/workorders/{id}/done（完成 + 上传证据）
  [MODULE-DESIGN-PLATFORM.md §三]
□ FeishuClient.send_approval_card（推送审批卡片给主管）
  [MODULE-DESIGN-PLATFORM.md §十三.3]
□ POST /v1/feishu/events（飞书 Webhook，处理卡片按钮回调）
  [MODULE-DESIGN-PLATFORM.md §三 + ADR-5]
□ verify_feishu_signature()（不可跳过，即使测试环境也要配置空 token）
  [SKILL.md §1 铁律 4]
□ write_l3_knowledge()（工单 DONE 后自动写 kb_documents + pgvector L3，通过 LlamaIndex 摄入）
  [MODULE-DESIGN-PLATFORM.md §八]
□ WorkOrder FSM 完整状态机：DRAFT→PENDING_APPROVAL→APPROVED→IN_PROGRESS→DONE/REJECTED
  [MODULE-DESIGN-PLATFORM.md §三]
```

**前端（Studio）**

```
□ WorkOrderDraftInline（内嵌，不跳页面）：AI 预填 + 可编辑标题/优先级/描述 + 提交
  [MODULE-DESIGN-STUDIO.md §二十七 + UI-UX-DESIGN §22.4]
□ 底部 SecondaryButtons：[＋建工单] [📣通知] [📋历史]
  [MODULE-DESIGN-STUDIO.md §二十七]
□ 工单提交后状态反馈（内嵌显示"已提交审批，等待主管张工确认"）
  [UI-UX-DESIGN §22.4 AIP确认流]
□ KanbanPage（/studio/kanban）：工单看板，4 列（草稿/待审/执行中/完成）
  [MODULE-DESIGN-STUDIO.md §十二]
□ RecentWorkOrders 组件（DeviceIntelPanel 底部 3 条工单）
  [MODULE-DESIGN-STUDIO.md §二十七]
□ WorkOrderRow 组件（状态颜色 + 标题 + 工单号）
  [MODULE-DESIGN-STUDIO.md §二十七]
```

**验收**

```
□ 点击 One Big Action → WorkOrderDraftInline 内嵌展开（不跳页面）
□ AI 草稿预填标题/优先级/描述
□ 提交后主管飞书收到审批卡片
□ 主管点击飞书"批准"→ Studio 工单状态变为 APPROVED
□ 工单完成后 KB 有新 L3 知识条目
□ 403 测试：操作员不能审批自己的工单
```

---

### M5 开发清单（Week 9-10：告警 + 晨报 + 数据质量）

**后端（Platform）**

```
□ GET /v1/alarms/active（按优先级和时间排序）
  [MODULE-DESIGN-PLATFORM.md §17.7]
□ POST /v1/alarms/{id}/acknowledge（ISA-18.2 确认）
  [MODULE-DESIGN-PLATFORM.md §17.7]
□ POST /v1/alarms/{id}/shelve（搁置 30/60/480 分钟选项）
  [MODULE-DESIGN-PLATFORM.md §17.7]
□ GET /v1/alarms/stats（告警 KPI：rate_per_10min + avg_p1_response_min）
  [MODULE-DESIGN-PLATFORM.md §17.7]
□ Scheduler: alarm_restore_job（每 5 分钟检查 shelved_until 到期告警，自动恢复 active）
  [MODULE-DESIGN-PLATFORM.md §九]
□ Scheduler: morning_report_job（每天 07:00 生成场站晨报推送飞书）
  [MODULE-DESIGN-PLATFORM.md §九]
□ Scheduler: anomaly_poll_job（每 5 分钟检查指标超阈值，触发告警创建）
  [MODULE-DESIGN-PLATFORM.md §九]
□ POST /v1/shifts/handover（班次交接报告推送飞书）
  [MODULE-DESIGN-PLATFORM.md §17.8]
□ GET /v1/admin/data-quality（数据质量 Dashboard 数据）
  [CLAWTWIN-MASTER-V2.md §十六 + UI-UX-DESIGN §21.6]
```

**前端（Studio）**

```
□ AlarmQueuePanel V2：P1/P2/P3/P4 分组 + 已确认/搁置操作 + 告警率指示器
  [MODULE-DESIGN-STUDIO.md §二十五]
□ AlarmRow 组件：优先级色块 + 告警消息 + 持续时间 + [确认][搁置] 按钮
  [MODULE-DESIGN-STUDIO.md §二十五]
□ ShelveModal：三个搁置时长选项（30/60/480 分钟）
  [UI-UX-DESIGN §二十五]
□ ShiftHandoverButton（NavRail 底部）→ HandoverModal → POST /v1/shifts/handover
  [MODULE-DESIGN-STUDIO.md §二十九]
□ OfflineBanner 组件：断网时顶部橙色横幅 + ServiceWorker 缓存最后状态
  [SKILL.md §8 离线]
□ Admin DataQualityPage（/admin/data-quality）：实时质量指数 + 设备质量列表
  [UI-UX-DESIGN §21.6]
□ NavRail 告警 Tab 角标：P1 数量红色徽章
  [MODULE-DESIGN-STUDIO.md §二十九]
```

**验收**

```
□ 告警列表按 P1→P2→P3→P4 排序，P1 告警闪烁
□ 点击搁置 → 选择 30 分钟 → 告警从活跃列表消失 → 30 分钟后自动恢复
□ 晨报飞书推送（可手动触发 POST /v1/admin/trigger-morning-report 测试）
□ NavRail 告警 Tab 显示 P1 计数红色徽章
□ 关闭 Platform 服务 → Studio 顶部出现 OfflineBanner
□ /admin/data-quality 显示质量指数和卡值设备列表
```

---

### M6 开发清单（Week 11-12：Phase A 交付就绪）

**安全加固**

```
□ 全部 API 端点过 PR 安全检查清单（SKILL.md §2.1 全部 □ 勾选）
□ 403 测试覆盖：跨场站访问 + 角色越权 + 无 JWT 访问
□ 飞书 Webhook 验签强制启用（FEISHU_VERIFY_TOKEN 非空）
□ 审计日志覆盖：所有关键操作均写 audit_logs 表
□ HTTPS 配置（Let's Encrypt 或自签名 + 强制 HTTP→HTTPS 跳转）
□ 敏感配置不在代码中（.env 在 .gitignore，secrets 用 Docker secrets）
```

**Admin 完整功能**

```
□ /admin/home：KPI 总览（设备数/今日告警/未完成工单/AI 准确率）
□ /admin/users：用户管理（创建/邀请飞书绑定/角色分配/场站权限）
□ /admin/knowledge：知识库管理（上传/查看 L0-L3/删除）
□ /admin/service-tokens：POST /v1/admin/service-tokens（创建 OpenClaw/HiAgent Token）
□ /admin/data-quality：数据质量 Dashboard（M5 已实现）
□ /admin/value-calculator：ROI 计算器（输入停机次数 → 输出年节省金额）
```

**OpenClaw 集成**

```
□ OpenClaw 安装 + industrial-twin / industrial-kb / industrial-workorder / industrial-analytics Skills 配置
  [OPENCLAW-SETUP-GUIDE.md]
□ 服务 Token 配置（OPENCLAW_SERVICE_TOKEN 与 Platform 对接）
  [OPENCLAW-SETUP-GUIDE.md §五]
□ 飞书 Bot 问答联调（发消息 → OpenClaw → Platform Tool API → 飞书卡片回复）
□ 测试 10 个标准问题，AI 回答质量得分 ≥ 80%（SKILL.md §8 冷启动知识质量验收）
```

**Demo 准备**

```
□ Demo 数据：预设 C-001 处于 warn 状态（振动偏高），predicted_breach_minutes=83
□ Demo 脚本：5 个 Demo 场景走一遍（DEVELOPMENT-CONTRACT.md §九）
□ Demo 录屏：每个场景录 GIF/视频（用于进度报告和客户展示）
□ 快速启动 README：git clone → docker compose up → 登录 → 看到 Demo 场景 ≤ 5 步
```

**验收（Phase A 完成标准）**

```
□ 5 个 Demo 场景全部可以向客户演示（DEVELOPMENT-CONTRACT.md §九）
□ 所有安全检查清单通过（SKILL.md §2.1-2.5 全部 □ 勾选）
□ 知识问答质量 ≥ 80%（10 题测试）
□ 飞书审批 HITL 完整链路可演示
□ Platform API 所有端点有对应的 pytest 测试（正常路径 + 403 路径）
□ Studio 无 console 报错，无 TypeScript 编译错误
□ docker compose up 启动时间 < 120 秒
□ 完整 Runbook 文档（客户 IT 可以自行部署）
```

---

## 十、关键 API 与组件对照表（开发联调用）

> 前后端联调时，前端工程师按此表确认 API URL 和字段名与 Platform 对齐。

| Studio 组件                  | 调用的 Platform API（唯一真相，§18.6）                                      | 关键返回字段                                           |
| :--------------------------- | :-------------------------------------------------------------------------- | :----------------------------------------------------- |
| StationHeatmap               | `GET /v1/stations/{id}/health-summary`                                      | `areas[].status`, `areas[].area_name`                  |
| useEquipmentIntel            | `POST /v1/tools/diagnose_equipment` + `GET /v1/equipment/{id}/health-score` | 并发请求                                               |
| DeviceIntelPanel 主行动      | `POST /v1/tools/diagnose_equipment`                                         | `primary_action.{label,icon,color,reason,action_type}` |
| UrgencyCountdown             | `POST /v1/tools/diagnose_equipment`                                         | `predicted_breach_minutes`（分钟整数）                 |
| AIInsightCard                | `POST /v1/tools/diagnose_equipment`                                         | `summary`, `confidence`, `citations[]`                 |
| HealthScoreCard              | `GET /v1/equipment/{id}/health-score`                                       | `overall_score`, `dimensions[]`, `ai_summary`          |
| SpectrogramView              | `GET /v1/equipment/{id}/spectrum`                                           | `spectrum[]`, `ai_interpretation`                      |
| WorkOrderDraftInline（预填） | `POST /v1/workorders/ai-draft`                                              | `title`, `priority`, `description`                     |
| WorkOrderDraftInline（提交） | `POST /v1/workorders/`                                                      | `wo_id`, `state:"draft"`                               |
| WorkOrderDraftInline（送审） | `POST /v1/hitl/workorders/{id}/pending`                                     | `ok: true`                                             |
| PrimaryAction "通知操作员"   | `POST /v1/notifications/notify-operator`                                    | `notified_users[]`                                     |
| PIDView 分析                 | `POST /v1/tools/analyze_pid`                                                | `highlighted_equipment_ids[]`, `ai_insight`            |
| CommandPalette               | `GET /v1/search?q=&limit=8`                                                 | `results[].{type,title,id,status}`                     |
| AlarmQueuePanel              | `GET /v1/alarms/active`                                                     | `alarms[].{priority,state,message,equipment_id}`       |
| AlarmRow [确认]              | `POST /v1/alarms/{id}/acknowledge`                                          | `ok: true`                                             |
| AlarmRow [搁置]              | `POST /v1/alarms/{id}/shelve`                                               | `ok: true`, `shelved_until`                            |
| KanbanPage                   | `GET /v1/workorders?station_id=&state=`                                     | `items[].{wo_id,title,state,priority}`, `total`        |
| ShiftHandoverButton          | `POST /v1/shifts/handover`                                                  | `summary`, `pending_workorders[]`                      |
| InvestigationBanner          | `GET /v1/alarms/active?priority=P1`                                         | `total > 0` 时激活调查模式                             |

---

## 十一、开发团队任务分工参考（V2）

```
后端工程师（1-2 人）负责 Phase A：
  Week 1-2：M1 全部后端任务
  Week 3-4：M2 后端（设备/站场 API + Scheduler Mock 数据）
  Week 5-6：M3 后端（diagnose_equipment 完整版 + health-score + search）
  Week 7-8：M4 后端（workorders HITL + 飞书 Webhook）
  Week 9-10：M5 后端（alarms ISA-18.2 + scheduler 告警 + shifts）
  Week 11-12：M6 后端（安全加固 + Admin API + OpenClaw 集成）

前端工程师（1-2 人）负责 Phase A：
  Week 1-2：M1 全部前端任务（tokens.ts + stores + LoginPage + 骨架）
  Week 3-4：M2 前端（NavRail V2 + StationHeatmap + TwinSurface + IntelPanel）
  Week 5-6：M3 前端（DeviceIntelPanel V2 + useEquipmentIntel + AIInsightCard + Cmd+K）
  Week 7-8：M4 前端（WorkOrderDraftInline + KanbanPage）
  Week 9-10：M5 前端（AlarmQueuePanel V2 + OfflineBanner + Admin DataQuality）
  Week 11-12：M6 前端（Admin 完整 + Demo 场景 + 录屏）

AI/知识工程师（1 人）负责：
  Week 1-2：L0 知识文档收集（≥ 20 篇标准/手册 PDF）
  Week 3-4：vLLM 部署 + pgvector 知识入库（python scripts/seed_knowledge.py）
  Week 5-6：Prompt 调优（diagnose_equipment + ask_knowledge）
  Week 7-8：L1 知识文档（≥ 20 篇设备特定手册）
  Week 9-12：AI 质量测试（10 题 ≥ 80%）+ Demo 场景 AI 调优

DevOps（兼职）负责：
  Week 1-2：Docker Compose + CI/CD 基础配置
  Week 11-12：生产部署 Runbook 验证 + HTTPS + 安全扫描
```

---

_§九-十一 新增（2026-05-09，V2 版）：基于最终设计文档的精确开发清单。_  
_本节替代 §二 的通用描述，提供可直接勾选执行的任务清单。_
