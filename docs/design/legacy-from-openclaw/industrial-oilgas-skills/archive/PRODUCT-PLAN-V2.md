# ClawTwin 产品规划 V2

## 基于定稿架构的优化产品规划与执行计划

**日期**：2026-05-08  
**版本**：2.0（基于 CLAWTWIN-MASTER-V2.md 定稿架构）

---

## 一、产品组合（最终定稿）

### 1.1 三个核心产品

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Product 1：ClawTwin Platform                                            │
│                                                                         │
│ 定位：工业 AI 数字孪生平台后端，客户私有化部署的核心引擎                   │
│ 核心价值：连接 OT 数据 + 沉淀领域知识 + AI 推理 + 安全可控               │
│                                                                         │
│ 包含：                                                                   │
│   · Ontology API（设备/场站对象模型，Palantir 本体对标）                  │
│   · Tool API（供 OpenClaw Skills 调用的工具接口）                         │
│   · IMS Adapter（OPC-UA/SCADA/CMMS 接入层）                             │
│   · Security Layer（ABAC 权限 + JWT 身份 + 审计日志）                    │
│   · Platform Scheduler（定时任务：晨报/异常检测/备份）                   │
│   · HITL 状态机（工单草稿→飞书审批→执行闭环）                             │
│   · 飞书 Bot Client（主动推送通知和工单卡片）                             │
│   · 飞书 Webhook 接收（处理审批回调）                                     │
│   · 知识摄入服务（PDF→Milvus+GraphRAG）                                 │
│                                                                         │
│ 技术：Python / FastAPI / PostgreSQL / Milvus / Eclipse Ditto / Kafka    │
│ 部署：Docker Compose，客户服务器私有化                                    │
│ 定价：年度许可（按场站数）                                                 │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ Product 2：ClawTwin Studio                                              │
│                                                                         │
│ 定位：工业数字孪生操作界面，基于 maibot-ui 改造的 Web/桌面应用             │
│ 核心价值：3D 可视化 + AI 对话 + 工程师工具 + 知识管理                     │
│                                                                         │
│ 包含：                                                                   │
│   · AI 对话界面（复用 maibot-ui 核心，连接用户的 OpenClaw）               │
│   · /twin：3D 数字孪生主界面（Babylon.js 8 WebGPU）                      │
│   · /command：指挥大屏（全屏，投影用）                                    │
│   · /admin/knowledge：知识文档管理（上传/入库/状态）                      │
│   · /admin/equipment：设备台账和阈值配置                                  │
│   · /admin/users：用户绑定和权限管理                                      │
│   · /admin/system：系统健康监控                                           │
│                                                                         │
│ 技术：React / TypeScript / Babylon.js 8 / Tailwind / shadcn/ui         │
│ 部署：Web 浏览器（Nginx 静态托管）+ 可选 Tauri 桌面版                     │
│ 说明：Studio 本身不含 AI，AI 来自用户自己的 OpenClaw + industrial Skills │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ Product 3：Industry Knowledge Packs（行业知识包）                        │
│                                                                         │
│ 定位：预置行业知识，快速启动客户知识库                                     │
│ 核心价值：减少客户知识初始化工作，提升开箱即用的 AI 回答质量               │
│                                                                         │
│ Pack A：石油天然气输气管道包（首个，已有内容积累）                         │
│   · 天然气压缩机组操作规程（GB/T 17544 等）                               │
│   · 旋转机械振动分析指南（ISO 10816）                                     │
│   · 常见故障模式与处置方法库（500+ 条，结构化）                           │
│   · 工单模板库（20+ 类型）                                               │
│   · 阈值标准参考（基于行业标准，客户可覆盖）                               │
│                                                                         │
│ Pack B：化工装置包（规划，Phase C）                                       │
│ Pack C：电力变配电站包（规划，Phase C）                                   │
│ Pack D：LNG 接收站包（规划，Phase C）                                    │
│                                                                         │
│ 定价：一次性购买或年度订阅更新                                             │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 配套服务（不单独成产品，但是收入来源）

```
实施服务：
  · 现场评估（2天，免费或低价，建立关系）
  · 基础设施部署（1天）
  · OPC-UA/IMS 接入调试（2-5天，高单价）
  · 知识库初始化（1-2周，按文档量计费）
  · 用户培训（1天）
  · 试运行监护（1-4周，可远程）

年度维护服务：
  · 版本升级（远程，每季度）
  · 知识库更新（按需）
  · AI 质量调优（每季度评估，按需）
  · 7×12 远程支持（工作日 + 紧急响应）

定制开发服务：
  · 额外 IMS Adapter 开发（如特殊系统）
  · 自定义 OpenClaw Skills
  · 定制报表和 KPI 面板
```

### 1.3 OpenClaw 和 GPU 的定位（不是我们的产品）

```
OpenClaw：
  · 开源产品，客户自行部署（我们协助）
  · 我们的价值在 industrial-* Skills（4个）
  · Skills 是我们的智识产权，与 Platform 许可绑定

GPU 服务器（vLLM）：
  · 客户自备 GPU 服务器（我们提供规格建议）
  · 或者使用我们提供的「共享 GPU 推理服务」（SaaS 化，Phase C）
  · Qwen3.6 是开源模型，我们不持有许可

模型微调服务（Phase C）：
  · 用客户积累的工单数据微调 Qwen3.6-7B
  · 客户数据不出站（在客户 GPU 上微调）
  · 微调后的模型是客户资产
```

---

## 二、竞争定位

### 2.1 为什么买这个，而不是买 Cognite/Palantir/西门子？

```
Cognite/Palantir AIP：
  · 面向大型企业（$500万+年度合同）
  · 需要专业 Foundry 工程师团队实施
  · 强调数据主权但实际在云端
  · 中文支持弱，中文 AI 能力差
  → 我们的目标客户付不起，也用不了

西门子 Plant Simulation / MindSphere：
  · 重 OT 侧，但 AI 能力非常弱
  · LLM 集成刚起步，中文场景差
  · 私有化部署复杂，价格高
  → 我们比它 AI 能力强 10 倍

竞争对手不做 AI 原生是因为：
  · 原有产品架构难以改造（遗留包袱）
  · 企业客户对 AI 安全性担忧（我们用 HITL 解决）
  · LLM 幻觉问题（我们用 citations + 知识分层解决）

我们的差异化：
  1. 真正 AI 原生（不是给老产品加 AI 按钮）
  2. 最强中文 AI（Qwen3.6，中文工业场景训练）
  3. 私有化部署（数据不出站，关键基础设施必须）
  4. 价格适中（中小企业可承担）
  5. 飞书原生（中国工业企业的主流协同工具）
  6. 安全可审计（ABAC + 审计日志 + HITL，等保友好）
```

### 2.2 目标客户画像

```
优先目标（Phase A/B 聚焦）：
  行业：油气输送（天然气管道）
  规模：中型（1-10个场站，100-500名员工）
  IT 成熟度：有基本 IT 团队，已用飞书
  OT 现状：有 OPC-UA 服务器（Kepware 或 PTC）
  痛点：
    · 24小时无人值守站，异常发现慢
    · 操作员经验难以传承（老师傅退休）
    · 工单纸质或 Excel 管理，追溯难
    · 有大量操作规程文档但没人看

  理想首个客户：
    · 愿意作为"共建试点"的态度
    · 有 1-2 个接受新技术的技术负责人
    · 规模适中（3-5 个场站，30-100 用户）
    · 付费意愿合理（接受试点定价）

后续扩展（Phase C）：
  · 化工装置（乙烯、PTA 等）
  · 电力行业（变电站、输电线路）
  · LNG 接收站
  · 城市燃气（调压站）
```

---

## 三、执行计划（三期）

### Phase A：基础 MVP（第 1-3 个月）

**目标**：能演示完整流程，能在受控环境跑通端到端

```
Month 1：地基（平台核心 + OT 接入 + 安全基线）

Week 1-2：Platform 基础
  □ Docker Compose 环境（PostgreSQL / Milvus / Kafka / Ditto / Redis）
  □ Platform API 骨架（FastAPI + 数据模型）
  □ /v1/health 端点（含所有依赖服务状态）
  □ 飞书 Webhook 接收（/v1/feishu/webhook，含签名验证）
  □ 飞书 Bot Client（FeishuClient，含 FEISHU_BASE_URL 适配）

Week 3：OT 数据接入
  □ opcua-bridge（asyncua，独立 Docker 服务，模拟 OT/IT 隔离）
  □ Kafka → Ditto Consumer（实时设备状态写入）
  □ 模拟 OPC-UA 服务器（用 opcua-asyncio mock，不需要真实设备）
  □ /v1/objects/equipment/{id}（返回 Ditto 实时状态）

Week 4：安全基线（ADR-6 要求）
  □ 用户表 + feishu_bindings 表（身份绑定模型）
  □ OpenClaw Service Token 验证（X-OpenClaw-Service-Token header）
  □ feishu_open_id → user_id → ABAC（每个 API 端点）
  □ 工单审批角色验证（supervisor only）
  □ 审计日志（关键操作写 audit_logs 表）
  □ JWT 签发和验证（Platform 登录 → JWT → Studio 访问）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Month 2：核心功能（知识 + AI + HITL）

Week 5-6：知识库 + OpenClaw 接入
  □ Milvus 向量索引（L0/L1 文档入库，石油天然气行业标准）
  □ /v1/tools/kb/search（向量检索 + citations）
  □ L3 知识自动摄入（工单 DONE 后写 kb_documents layer=L3 + Milvus）
  □ OpenClaw 4 个 industrial-* Skills 部署和测试
  □ 端到端测试：飞书问问题 → AI 检索 → 带 citations 回答

Week 7：HITL 工单流程
  □ 工单状态机（DRAFT → PENDING_APPROVAL → APPROVED → DONE）
  □ 飞书审批卡片发送（含工单详情 + 批准/拒绝按钮）
  □ /v1/feishu/webhook 处理审批回调（含权限验证）
  □ 工单 DONE 后异步写 L3（kb/l3_writer.py → Milvus，数据飞轮）
  □ 端到端测试：AI 建工单 → 主管飞书审批 → 工单变 APPROVED

Week 8：Platform Scheduler
  □ APScheduler 集成（晨报 Cron + 每小时异常轮询）
  □ 规则引擎阈值检查（Phase A 替代 MOIRAI）
  □ 异常告警 → 飞书卡片推送（含确认按钮）
  □ 晨报生成（场站 KPI + 昨日异常统计）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Month 3：Studio + Demo 准备

Week 9-10：ClawTwin Studio
  □ 复制 maibot-ui → clawtwin-studio（修改包名，删无关页面）
  □ /twin 路由（TwinPage.tsx）+ 设备列表 + 右侧详情面板
  □ TwinSurface.tsx（Babylon.js 8 WebGPU，设备 3D 盒子占位）
  □ Studio 连接 Platform API（VITE_PLATFORM_URL）
  □ Studio JWT 登录（工号+密码）

Week 11：OPC-UA 对接 + 数据流打通
  □ 用真实 OPC-UA 服务器测试（若有，或 Prosys OPC-UA Simulator）
  □ Studio /twin 实时数据更新（WebSocket 推送）
  □ 设备点击 → 右侧面板 → 实时数值显示

Week 12：Demo 准备 + 修复
  □ 完整 Demo 流程演练：
      1. Studio 打开 /twin → 3D 场站
      2. C-001 状态 WARNING（模拟）
      3. 飞书问 AI「C-001 情况？」→ AI 回复（含 citations）
      4. AI 建工单 → 主管飞书审批 → 工单 APPROVED
      5. 晨报推送（次日早 6 点）
  □ 录制 Demo 视频
  □ 修复 Demo 过程中发现的 Bug
  □ 更新 README 和启动文档

Phase A 交付物：
  · 可演示的端到端系统（Docker Compose 一键启动）
  · 完整安全基线（ADR-6 全部实现）
  · 4 个 OpenClaw Skills（可安装和使用）
  · Demo 视频 + 技术文档
```

### Phase B：生产就绪（第 4-6 个月）

**目标**：可交付第一个试点客户，达到生产级

```
Month 4：运维工具 + 生产基础

  □ Ansible Playbook（部署 + 升级）
  □ 备份脚本（PostgreSQL 每日 + Milvus 每周）
  □ Prometheus + Grafana（基础监控）
  □ 告警规则（关键服务宕机 → 飞书/短信通知）
  □ OT/IT 网络分区部署文档（Zone 0/1/2 指南）
  □ 数据库迁移框架（Alembic，向前兼容）
  □ MOIRAI 2.0 接入（替代规则引擎做异常检测）

Month 5：完整功能 + 客户交付准备

  □ 知识 Admin UI（/admin/knowledge：上传/入库状态）
  □ 用户 Admin UI（/admin/users：飞书绑定流程）
  □ 设备 Admin UI（/admin/equipment：阈值配置）
  □ 系统健康 UI（/admin/system：服务状态实时）
  □ IMS Adapter（模式 A 服务账号，OPC-UA + REST）
  □ CSV 历史工单导入工具（csv_import.py）
  □ vLLM 降级模式（GPU 不可用时自动切换规则引擎）
  □ 飞书私有化对接测试（用 FEISHU_BASE_URL 切换）

Month 6：第一个试点客户交付

  □ 客户现场评估（2天）
  □ 基础设施部署（1天）
  □ OPC-UA 接入调试（3-5天）
  □ 知识库初始化（1-2周，客户文档收集+入库）
  □ 用户绑定配置（半天）
  □ 2周试运行监护（远程 + 现场支持）
  □ 试点总结报告（为后续客户提炼交付方法论）

Phase B 交付物：
  · 生产级运维工具套件
  · 首个试点客户成功交付
  · 交付方法论文档（SOP）
  · 客户反馈和改进 Backlog
```

### Phase C：规模化（第 7-12 个月）

**目标**：3-5 个客户，扩展行业，建立领先地位

```
功能扩展：
  □ 完整 3D 数字孪生（真实设备 3D 模型，FBX/GLTF 导入）
  □ /command 指挥大屏（投影大屏优化）
  □ MOIRAI 精调（用客户数据微调时序模型）
  □ 物理模拟（pandapipes 管网仿真 + FNO 神经代理）
  □ Qwen3.6 领域微调（客户工单数据，在客户 GPU 上微调）
  □ 移动端优化（飞书 App 体验进一步提升）
  □ 多站汇聚报表（区域/总部视角 Dashboard）
  □ 企业知识图谱（GraphRAG 跨站知识关联）

行业扩展：
  □ Pack B：化工装置（乙烯/PTA/合成氨）
  □ Pack C：电力变配电站
  □ Pack D：LNG 接收站

商业扩展：
  □ 共享 GPU 推理服务（小客户按需付费，避免自建 GPU）
  □ 模型微调服务（客户数据定制化）
  □ 知识库订阅更新服务（Pack 年度更新）
  □ 认证培训（客户工程师认证）
```

---

## 四、资源规划

### 4.1 开发团队配置（最小可行）

```
Phase A（0-3月）：2人全职

  工程师 A（后端）：
    · Platform API（FastAPI）
    · IMS Adapter（opcua-bridge）
    · 安全层（JWT/ABAC）
    · Scheduler + HITL
    · 知识摄入服务

  工程师 B（前端 + AI）：
    · ClawTwin Studio（React + Babylon.js）
    · OpenClaw Skills 开发和测试
    · 飞书 Bot 对接
    · Demo 准备

  注：AI 方向（vLLM/MOIRAI）Phase A 以集成为主，
      不需要 AI 工程师（调用 API 即可），Phase B 再考虑

Phase B（4-6月）：3人（+1运维/实施工程师）

  工程师 A：Phase A 功能完善 + MOIRAI 接入 + 运维工具
  工程师 B：Studio 完善 + Admin UI + 3D 深化
  工程师 C（新）：客户交付 + OPC-UA 调试 + 运维 + Ansible

Phase C（7-12月）：5-7人（根据客户数量扩展）
```

### 4.2 硬件资源配置

```
开发阶段（Mac + GPU 服务器）：

  Mac（已有，Peter 的 MacBook Pro）：
    用途：ClawTwin Studio 开发（React/Babylon.js）
          浏览器 3D 渲染测试（Metal GPU 加速）
          轻量后端开发和调试

  GPU 服务器（已有或需要采购）：
    用途：vLLM（Qwen3.6-35B-A3B INT4）服务
          MOIRAI 时序推理
          embedding 服务
    规格建议：A100 40GB × 1（开发够用）
              或 RTX 4090 × 2（预算有限时）

  Mac 不跑 vLLM：
    35B 模型 INT4 量化约 20GB VRAM
    Mac 最高 96GB 统一内存（M3 Ultra），理论可跑
    但实际推理速度远不及 A100，且 vLLM 对 Metal 支持不完善
    → 生产和开发都用 GPU 服务器，Mac 只做前端和 API 开发

生产客户硬件（客户自备）：
  → 见 CLAWTWIN-MASTER-V2.md 第二部分服务器规格
```

### 4.3 时间线总览

```
2026年 5月    开始 Phase A 开发
      6月    Platform 核心 + 安全基线完成
      7月    Studio + HITL + Skills 完成，Demo 准备
      8月    Phase B 启动，运维工具开发
      9月    客户交付准备完成
      10月   第一个试点客户启动部署
      11月   试点验证 + 修复 + 知识库建设
      12月   试点客户验收，Phase C 规划
2027年 Q1    2-3 个新客户，行业包扩展
      Q2    规模化，共享推理服务
```

---

## 五、关键风险和应对

```
风险 1：OPC-UA 接入耗时超预期（概率：高）
原因：客户 DCS 工程师配合难，节点 ID 获取困难
应对：
  · 开发 OPC-UA 节点扫描工具（自动发现节点）
  · 提供标准节点映射模板（减少手工配置）
  · 合同中明确"客户需提供 OPC-UA 节点对照表"

风险 2：知识库质量差导致 AI 回答差（概率：高）
原因：客户文档质量参差不齐，缺少关键文档
应对：
  · Phase A 提前积累 L0/L1 通用知识包（独立于客户）
  · 知识验证流程（20 个标准问题 QA 测试）
  · 清晰地告知客户：知识库质量 = AI 回答质量

风险 3：飞书私有化版本不兼容（概率：中）
原因：私有化版本滞后，某些 API 不支持
应对：
  · 开工前确认版本号
  · 使用 V3 保守 API 子集
  · 卡片不支持时降级为文本消息 + 网页链接

风险 4：GPU 服务器不稳定影响 AI 可用性（概率：中）
原因：vLLM OOM、CUDA 错误等
应对：
  · 降级模式（GPU 不可用 → 规则引擎替代）
  · GPU 服务器内存监控 + 告警（> 85% 预警）
  · 备用模型（小模型 Qwen3.6-7B 兜底）

风险 5：客户对 AI 建议信任度低（概率：中）
原因：AI 偶发幻觉，工业场景容错率低
应对：
  · citations 强制要求（无来源不输出操作建议）
  · HITL 铁律（所有工单必须人工审批）
  · 早期着重演示 AI 知识检索价值（而非 AI 决策）
  · 逐步建立信任后才引入 AI 分析建议

风险 6：安全审查无法通过（概率：低但影响高）
原因：关键基础设施的安全合规要求
应对：
  · ADR-6 安全架构对标等保 2.0 三级
  · OT/IT 物理分区（Zone 0/1/2）
  · 审计日志满足监管要求（3年保留）
  · 必要时请第三方安全机构评估
```

---

## 六、成功标准

```
Phase A 成功标准（3个月末）：
  ✓ Docker Compose 一键启动，健康检查全绿
  ✓ 飞书对话可以查设备状态（带 citations）
  ✓ AI 建工单 → 飞书审批 → 工单 APPROVED（端到端 < 2分钟）
  ✓ 晨报准时发送（测试环境 06:00）
  ✓ Studio /twin 显示实时设备状态（WebSocket 更新）
  ✓ 10 分钟 Demo 视频无故障录制完成

Phase B 成功标准（6个月末）：
  ✓ 第一个试点客户成功上线
  ✓ 试点客户操作员可以独立使用飞书 AI 查询设备
  ✓ 至少 1 个真实工单完成完整 HITL 流程
  ✓ 系统连续稳定运行 2 周无重大故障
  ✓ 客户满意度：愿意继续合作（不要求完美）

Phase C 成功标准（12个月末）：
  ✓ 3个以上付费客户
  ✓ AI 回答准确率 > 85%（基于用户反馈）
  ✓ 年度经常性收入（ARR）达到可持续运营水平
  ✓ 至少 1 个客户完成知识库精调（数据飞轮启动）
```
