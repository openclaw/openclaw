# ClawTwin 架构决策记录 ADR-3.0

## 现实检验 · Palantir 深度对标 · 竞争批判 · Skills 重设计 · 资源分配

**版本**：ADR-3.0 · 2026-05-08  
**依据**：深度研读 archive/palantir（Rust实现）+ archive/palantir-ontology-strategy（策略书籍）  
**原则**：批判性审视，假设竞争对手是对的，只保留有真实用户价值的内容

---

## 一、Palantir AIP 深度对标——我们缺什么，多什么

### 1.1 Palantir 的三个核心哲学（从项目文档提炼）

```
① 数据即运营层（Operational Layer）
   · 数据不是"看的仪表盘"，数据直接驱动行动
   · ClawTwin 对标：Ditto 实时状态 + AI 直接生成工单，不只是"展示"

② 名词与动词的统一（Noun + Verb = Object + Action）
   · 对象（Equipment）不只有属性，还有可执行的动作（Actions）
   · Palantir 四种 Action：Logic（领域逻辑）/ Integration（外部集成）
                          / Workflow（多步审批）/ Search（CQRS查询）
   · ClawTwin 对标：
     Equipment 的 Logic Action   → kb_search 根因推理
     Equipment 的 Integration Action → IMS 工单创建
     Equipment 的 Workflow Action → TaskFlow HITL 停机审批
     Equipment 的 Search Action   → 历史趋势 / 相似故障查询

③ 对现实的治理（Governance of Reality）
   · Palantir 的 Branch/Review 模型：所有对本体的修改先走 Proposal
   · 类似 Git PR → Review → Merge 的流程
   · ClawTwin 对标：HITL TaskFlow = 对操作决策的 Branch/Review
     AI 推荐 = 创建 Proposal
     王工确认 = Code Review
     写入工单 = Merge to main
```

### 1.2 我们比 ADR-2.0 还缺少的一个关键层

**Palantir Rust 项目揭示的核心机制：**

```
DiscoveryEngine 三步自动发现：
  Pass 1：每个数据记录 → OntologyObject（Equipment/WorkOrder/KnowledgeDoc）
  Pass 2：_id 外键字段 → HAS 关系（WorkOrder HAS Equipment）
  Pass 3：共享枚举字段 → BELONGS_TO 关系（Equipment BELONGS_TO Station）

PatternDetector：
  扫描 OntologyGraph → 发现业务模式（振动>阈值、跨设备关联）→ 发出 DomainEvent
  DomainEvent → EventBus → ApplicationService → Command
```

**我们缺少的：Ontology Discovery（本体发现层）**

```
当前痛点：我们的设备关系是"手工配置"在 station-data.json
Palantir 的做法：从 OPC-UA 实时数据流中"自动发现"设备关系

解决方案（Phase B 加入，不影响 Phase A）：
  OPC-UA Bridge 解析设备节点树 → 自动生成 Equipment 本体对象
  Kafka 事件流 → PatternDetector → 自动发现设备间耦合关系
  结果写入 PostgreSQL 设备关系表（不需要 Neo4j！）
```

### 1.3 我们比 Palantir 多做了什么（正确的）

```
Palantir 没有（我们有）：
  ✅ 物理仿真（pandapipes + FNO）：Palantir 是纯数据分析，我们有物理模型
  ✅ 3D 数字孪生（Babylon.js）：Palantir 没有 3D 可视化
  ✅ 时序基础模型（MOIRAI）：Palantir 没有专门的时序 AI 模型
  ✅ 工业知识图谱（GraphRAG L0-L2）：Palantir 不打包领域知识

这三点是我们相对于 Palantir 的核心差异化——针对工业垂直场景的深度。
Palantir 是通用平台，我们是工业垂直专家。
```

---

## 二、竞争批判分析——假设竞争对手是对的

### 2.1 为什么老牌工业公司没做 LLM 推理？

**西门子（Mindsphere）、霍尼韦尔（Forge）、ABB（Ability）、AVEVA 做了十年工业 IoT，为什么没有做 LLM 推理层？**

**假设竞争对手是对的，可能有以下合理原因：**

```
原因 A：安全责任（最重要）
  · IEC 61511（安全仪表系统）认证要求软件通过严格的功能安全验证
  · LLM 是概率性模型，会"幻觉"，不符合确定性安全系统要求
  · 如果 AI 建议"关阀"，结果导致事故，法律责任在谁？
  · 竞争对手的理由：等监管框架明确前，不在控制环路引入 AI

原因 B：用户不一定需要 AI 推理
  · 有经验的操作员已经知道 C-001 轴承的特征，AI 推理是否多余？
  · 大型企业有专属维保工程师，知识积累在人，不在系统
  · 中小企业没有预算购买复杂 AI 系统

原因 C：数据质量问题
  · OPC-UA 数据噪声大、标签不规范、历史数据缺失
  · 在烂数据上推理 = 烂建议，比没有 AI 更危险

原因 D：销售周期太长
  · 工业企业采购决策 2-5 年，AI 产品今天上市，2 年后才能签单
  · 老牌公司的商业模式（硬件+SCADA许可）与 AI SaaS 不兼容
```

### 2.2 我们的反驳——为什么仍然值得做

```
反驳 A（安全责任）：
  · 我们只做信息层，不做控制层
  · 所有关键操作强制 HITL（人工确认）
  · AI 的角色：提供建议 + 引用来源，不是"下命令"
  · 目标：操作员的"第二意见"，不是"替代操作员"
  · 类比：GPS 导航推荐路线，司机决定是否走

反驳 B（用户是否需要）：
  · 专注中国市场的中小型管道运营公司（500 公里以下）
  · 这些公司：没有足够的高资历工程师
  · 这些公司：知识积累在退休工程师脑子里，没有系统化
  · 真实痛点：凌晨 2 点设备报警，值班员不知道查什么资料
  · AI 价值：把 10 年老工程师的经验变成 7×24 小时可查询的知识

反驳 C（数据质量）：
  · 我们做数据质量校验（MOIRAI 的置信区间）
  · 低置信度 → 明确告知用户"数据可疑"
  · 短期用模拟数据 demo，客户现场用真实数据

反驳 D（销售周期）：
  · 我们不卖给大型国企（他们有内部技术团队）
  · 目标客户：二三线城市管道公司、地方燃气公司
  · 这些公司决策快，IT 预算少，更愿意尝试新技术
```

### 2.3 最诚实的风险评估

```
高风险：
  · 中小型管道公司可能没有预算（¥5-20万/年 SaaS 是否可接受）
  · 工业数据采集成本高（OPC-UA 接口需要 SI 集成）
  · 如果 AI 给出错误建议并被执行，公司面临巨大声誉风险

降风险策略：
  · 前 6 个月只做"信息层"（知识搜索、报告生成、历史分析）
  · 不做"操作建议"，只做"知识问答"
  · 第一个客户免费提供，换取真实数据和用例
  · 在 demo 阶段验证：用户是否愿意使用，愿意支付多少

结论：方向正确，目标客户需调整，从大项目切换到中小企业快速验证
```

---

## 三、OpenClaw Skills 彻底重设计——用户的疑问是对的

### 3.1 用户的疑问：这些 Skills 是什么？会被触发吗？

**先解释清楚 OpenClaw Skills 的工作原理：**

```
OpenClaw Skill（技能/插件）不是：
  ❌ 不是事件处理器（不是"当振动>阈值时触发"）
  ❌ 不是后台守护进程
  ❌ 不是 API 服务

OpenClaw Skill 是：
  ✅ Agent 的"能力扩展包"
  ✅ 包含三个部分：
     ① system prompt 扩展（告诉 Agent 如何推理）
     ② 工具定义（告诉 Agent 可以调用哪些 API）
     ③ Cron 任务和 TaskFlow 工作流（事件驱动的自动化）

生效时机：
  当用户把某个 Skill "加载"到他们的 Agent 时，
  Agent 就获得了这个 Skill 的所有能力，
  用户提问时 Agent 自动决定调用哪些工具。

  Cron 任务按时间自动运行（比如每天 7:00 生成晨报）
  TaskFlow 响应具体事件（比如异常检测触发工单流程）
```

### 3.2 Skills 正确设计（ADR-4.0 已更新，本节以 ADR-4 为准）

> **注意**：ADR-3.0 草稿中的"3 个角色 Skill"设计已在 ADR-4.0 中纠正。
> 以下为 ADR-4.0 确认的正确设计，请以 ADR-4-SKILL-DESIGN-AND-REVIEW.md 为权威依据。

**正确设计：4 个能力导向 Skills（不是角色导向）**

```
【核心原则】Skill = AI 能力，不是用户角色。用户按任务选择安装哪些 Skill。

① industrial-twin（能力：读实时设备状态）
   工具：twin_read → Platform /v1/objects/equipment/{id}
   任何需要查看设备实时状态的用户都可以安装

② industrial-kb（能力：工业知识搜索 + 严肃推理）
   工具：kb_search / graph_query / wiki_search（L3 原生）
   citations 强制，知识优先级 L3>L2>L1>L0

③ industrial-workorder（能力：工单草拟 + HITL 安全审批）
   工具：workorder_draft / workorder_history
   所有输出标注"草稿，待人工审批"

④ industrial-analytics（能力：趋势/异常/KPI 分析）
   工具：anomaly_detect / historical_query / kpi_report / trend_analysis

⑤ industrial-sim（Phase 2，占位）
   工具：sim_whatif（pandapipes）
```

**Cron 和 HITL 的归属（重要纠正）：**

```
❌ 旧设计（错误）：Cron 在 Skill 里（如 industrial-station-agent Cron）
✅ 正确设计：

  Cron（晨报/告警轮询） → Platform Scheduler（APScheduler in platform-api）
    Platform 直接调用 Feishu Bot API 推送消息，不依赖 OpenClaw 在线

  HITL 工单状态机 → Platform（推飞书卡片 + 处理回调）
    不是 OpenClaw TaskFlow（.lobster），Platform 直接管理状态转换

  OpenClaw 的角色：用户交互（飞书 → Agent → 调用 Platform Tool API）
  Platform 的角色：自动化调度 + 状态机 + 飞书消息推送
```

### 3.3 Skills 的触发方式（修正版）

```
方式一：用户主动提问（主要方式）
  用户（飞书）："C-001 现在状态怎么样？"
  → OpenClaw Agent（加载了 industrial-twin）调用 twin_read
  → 组装回复 + citations → 飞书消息卡片

方式二：Platform Scheduler 定时推送（不经 OpenClaw）
  每天 07:00 → Platform APScheduler
  → 调用内部 kpi_report + anomaly_detect（不走 OpenClaw）
  → Qwen3.6 生成晨报文本（Platform 内部调用 vLLM API）
  → Platform FeishuClient 直接推送飞书群

方式三：Platform 异常检测 → 告警推送（不经 OpenClaw）
  每小时 → Platform Scheduler → MOIRAI batch 检测
  → P1/P2 异常 → Platform FeishuClient 发飞书告警卡片
  → 用户回复飞书卡片"详细分析" → OpenClaw Agent 介入

方式四：用户在 Studio 操作触发
  点击"生成工单" → Studio 调用 Platform /v1/tools/workorder/draft
  → Platform 存草稿 + 推飞书审批卡片 → 主管确认/拒绝
```

---

## 四、Platform 内部模块边界——6 个独立服务

### 4.1 Platform Core 的 6 个独立开发服务

```
服务 1：platform-api（Industrial Ontology + Tool API）
  语言：Python (FastAPI)
  职责：/v1/objects/* + /v1/tools/* + /v1/actions/*
  依赖：postgres, ditto, milvus, redis
  独立测试：pytest + httpx（mock 所有外部依赖）
  端口：8080

服务 2：ingestion-service（文档摄入流水线）
  语言：Python (LlamaIndex)
  职责：PDF → chunks → embeddings → Milvus
  依赖：milvus, minio
  独立测试：测试分块逻辑 + mock Milvus
  触发：REST API（/ingest/document）

服务 3：opcua-bridge（OPC-UA → Kafka → Ditto）
  语言：Python (asyncua)
  职责：订阅 OPC-UA tags → 发 Kafka → Ditto 消费
  依赖：kafka, ditto
  独立测试：FreeOpcUa 模拟器 + Kafka 本地
  profiles: real-data（mock 模式下不启动）

服务 4：graphrag-api（GraphRAG HTTP 封装）
  语言：Python (FastAPI + Microsoft GraphRAG)
  职责：graphrag local/global search → REST API
  依赖：minio（GraphRAG Parquet 文件）
  独立测试：固定 Parquet 测试数据
  端口：7474

服务 5：moirai-service（时序异常检测）
  语言：Python (PyTorch + uni2ts)
  职责：时序数据 → MOIRAI 2.0 → 异常概率 + 置信区间
  依赖：无（纯模型推理）
  独立测试：CSV 历史数据 + 已知异常点验证
  端口：8888

服务 6：sim-service（pandapipes 物理仿真）
  语言：Python (pandapipes)
  职责：What-If 参数 → 1D 管网仿真 → 压力/流量结果
  依赖：无（纯计算）
  独立测试：标准算例（ISO 5167 验证）
  端口：9000
```

### 4.2 每个服务的"独立"标准

```
判断标准：
  ① 是否可以独立启动、独立测试？YES
  ② 是否有清晰的 REST API 契约？YES
  ③ 是否不依赖其他我们自己写的服务（只依赖开源基础设施）？YES
  ④ 是否可以被单独替换（比如换掉 moirai-service → 改用 TimesFM）？YES

这 6 个服务满足以上所有标准，是真正独立的模块。
```

---

## 五、GPU 资源分配——Mac + GPU 服务器

### 5.1 Mac（Apple M 芯片）的合理用途

```
Mac 做什么：

① 3D 渲染（浏览器 WebGPU → Metal GPU）
   · Babylon.js 8 WebGPU → 自动使用 Mac 的 Metal GPU
   · 无需任何配置，浏览器原生支持
   · 适合：ClawTwin Studio 开发和展示

② 本地开发环境
   · Docker for Mac：运行 PostgreSQL, Milvus, MinIO, Ditto, Redis
   · 轻量级服务（不跑大模型）
   · 适合：Platform 6 个服务的开发和单元测试

③ ingestion-service（小模型 embedding）
   · mxbai-embed-large（335M，CPU 可以跑）
   · 首次知识库建立（batch 任务，不需要实时）

④ moirai-service（小型推理）
   · MOIRAI Small（91M 参数）在 M 芯片上可以运行
   · 开发测试用，生产用 GPU 服务器
```

### 5.2 GPU 服务器的合理用途

```
GPU 服务器做什么：

① Qwen3.6-35B-A3B INT4 推理（主力 LLM）
   · vLLM + INT4 量化 ≈ 24GB VRAM（RTX 3090 或 A6000 可以）
   · OpenAI-compatible API → OpenClaw 调用
   · 7×24 运行，支持并发推理

② MOIRAI 2.0 Large（生产级异常检测）
   · 全精度推理，更高准确率
   · 可与 vLLM 共存（分时使用 GPU）

③ LlamaIndex embedding（批量文档向量化）
   · 使用 bge-m3 或 mxbai-embed-large
   · 批量处理，GPU 加速 10x

④ GraphRAG 建图（周期性任务）
   · 需要大量 embedding 计算
   · 每周运行一次（新文档加入时）

GPU 服务器推荐配置：
  最低：RTX 3090 24GB × 1
  推荐：RTX 4090 24GB × 1（足够 35B INT4）
  可选：A100 80GB × 1（支持 72B 模型，面向客户）
```

### 5.3 部署拓扑

```
┌─────────────────────────────────────────────────────────┐
│                   Mac（开发 + 演示机）                   │
│  Docker: PostgreSQL + Milvus + MinIO + Ditto + Redis    │
│  Browser: Babylon.js 3D（WebGPU/Metal）                  │
│  Dev: Platform 6 服务（mock 模式）                       │
│  embedding: CPU small models                             │
└─────────────────────────────────────────────────────────┘
                         │ LAN / VPN
┌─────────────────────────────────────────────────────────┐
│                  GPU 服务器（推理机）                     │
│  vLLM + Qwen3.6-35B-A3B INT4  ← 主力 LLM               │
│  MOIRAI 2.0 Large              ← 生产级异常检测          │
│  embedding service             ← bge-m3 batch 向量化    │
│  GraphRAG indexer              ← 周期性知识图谱建图       │
└─────────────────────────────────────────────────────────┘
                         │ OpenAI-compatible API
┌─────────────────────────────────────────────────────────┐
│              用户现场（客户部署）                         │
│  同 Mac 配置（Docker 基础设施）                          │
│  + Platform 6 服务（real-data 模式）                     │
│  可选：连接客户自有 GPU 服务器 或 连接我们的推理 API      │
└─────────────────────────────────────────────────────────┘
```

---

## 六、用户需要但目前缺失的模块

### 6.1 检查清单——用户在真实场景中需要什么

**场景：凌晨 2:00，场站无人值守，C-001 压缩机振动报警**

```
✅ 有：MOIRAI 异常检测（每小时轮询）
✅ 有：Cron 触发告警 → 飞书推送
✅ 有：值班员飞书接收报警 → 查询 AI
✅ 有：AI 推理 + 引用来源 → 飞书卡片

❓ 缺：告警分级（P1/P2/P3）→ 不同升级路径
❓ 缺：电话通知（飞书电话？） → 仅消息可能被忽略
❓ 缺：确认超时处理 → 30分钟无响应自动升级
```

**场景：早班工程师 08:00 交班**

```
✅ 有：每天 07:00 晨报生成 → 飞书推送
❓ 缺：交班记录模板 → 下班员工填写，接班员工查看
❓ 缺：待处理工单列表 → 接班时快速了解未完成事项
```

**场景：新工程师入职，需要了解设备**

```
✅ 有：知识库查询（Milvus L0-L3，layer 过滤）
✅ 有：3D 数字孪生可视化（Studio）
❓ 缺：设备档案（Equipment Passport）→ 设备历史维修记录汇总
❓ 缺：培训模式 → 模拟历史故障，让工程师在虚拟环境中练习推理
```

**场景：知识管理员更新 OEM 手册**

```
✅ 有：Studio Admin 文档上传
✅ 有：LlamaIndex → Milvus 摄入
❓ 缺：更新通知 → "您关注的 C-001 设备的知识库已更新"
❓ 缺：文档版本管理 → 新旧版本对比
```

**场景：区域管理层查看多场站 KPI**

```
✅ 有：单场站 KPI 仪表盘（Studio）
❓ 缺：多场站聚合视图 → Region Dashboard
❓ 缺：场站间对比 → "A 站效率比 B 站低 15%"
❓ 缺：合规报告导出 → PDF/Excel（监管要求）
```

### 6.2 缺失模块的处理方式

```
阶段一（Phase A，立即需要）：
  ① 告警分级 + 升级规则
     实现：Cron 脚本 + 飞书消息优先级 + 超时升级逻辑
     代价：低（在 industrial-station-agent Cron 中添加逻辑）

  ② 设备档案（Equipment Passport）
     实现：Studio EquipmentDetailPanel 增加"历史工单"Tab
     数据：PostgreSQL 工单表 + Platform /v1/objects/equipment/{id}/history
     代价：低

阶段二（Phase B）：
  ③ 交班记录模板（Shift Handover）
     实现：TaskFlow workflow + 飞书表单（用飞书原生表单）
     代价：中

  ④ 多场站 Region Dashboard
     实现：Studio 新增 /region 路由，聚合多 Platform API
     代价：中

  ⑤ 合规报告导出（PDF）
     实现：Python WeasyPrint 生成 PDF → MinIO 存储 → Studio 下载
     代价：中

不做（用户其实不需要）：
  ❌ 培训模式（用户会用历史数据自己研究）
  ❌ 电话通知（飞书消息已够，不做 IVR）
  ❌ 文档版本对比（过于复杂，价值不大）
```

---

## 七、最终整体架构图（ADR-3 版本）

```
                          ┌────────────────────────────────────────┐
                          │            用户接触点                   │
                          │                                        │
                          │  飞书 App（手机/PC）                    │
                          │  ClawTwin Studio（PC 浏览器）           │
                          │  ClawTwin Command（大屏浏览器）         │
                          └──────────────────┬─────────────────────┘
                                             │
                          ┌──────────────────▼─────────────────────┐
                          │     OpenClaw Gateway（独立产品）         │
                          │                                        │
                          │  Feishu Channel → Agent（AI 推理）      │
                          │  Cron（定时：晨报/每小时告警轮询）      │
                          │  TaskFlow（HITL：工单审批/异常升级）    │
                          │                                        │
                          │  用户按任务加载 Skills（能力导向）：    │
                          │    · industrial-twin（实时状态）        │
                          │    · industrial-kb（知识推理）          │
                          │    · industrial-workorder（工单HITL）   │
                          │    · industrial-analytics（趋势分析）   │
                          └──────────────────┬─────────────────────┘
                                             │ HTTP 调用 /v1/tools/*
                          ┌──────────────────▼─────────────────────┐
                          │   ClawTwin Platform（我们开发）          │
                          │                                        │
                          │  ┌────────────────────────────────┐   │
                          │  │  Industrial Ontology Layer      │   │
                          │  │  /v1/objects/equipment/{id}     │   │
                          │  │  /v1/objects/workorder          │   │
                          │  │  /v1/actions/equipment/{id}     │   │
                          │  └────────────────────────────────┘   │
                          │                                        │
                          │  ┌────────────────────────────────┐   │
                          │  │  6 个独立 Tool API 服务          │   │
                          │  │  twin_read → Ditto              │   │
                          │  │  kb_search → Milvus             │   │
                          │  │  graph_query → GraphRAG         │   │
                          │  │  anomaly_detect → MOIRAI        │   │
                          │  │  sim_whatif → pandapipes        │   │
                          │  │  workorder_draft → PostgreSQL   │   │
                          │  └────────────────────────────────┘   │
                          └──────┬─────────┬──────────────────────┘
                                 │         │
              ┌──────────────────┘         └──────────────────────┐
              │ Mac 部署                                           │ GPU 服务器
              ▼                                                    ▼
┌─────────────────────────┐                        ┌─────────────────────────┐
│  开源基础设施（接口调用）│                        │  AI 推理服务             │
│  Eclipse Ditto          │                        │  vLLM + Qwen3.6-35B     │
│  Apache Kafka           │                        │  MOIRAI 2.0 Large       │
│  Milvus 2.5             │                        │  bge-m3 embedding       │
│  PostgreSQL + TimescaleDB│                       │  GraphRAG indexer       │
│  MinIO                  │                        └─────────────────────────┘
│  Redis                  │
└─────────────────────────┘
```

---

## 八、Phase A 第一周具体任务（ADR-4 修订版）

```
Day 1-2：Infrastructure 启动（Mac Docker）
  · docker-compose up：PostgreSQL + Milvus + MinIO + Redis + Ditto
  · 验证：各服务健康端点响应
  · 创建 platform-api 项目骨架（FastAPI + /health）

Day 3-4：Industrial Ontology API v0（Mock 数据）
  · GET /v1/objects/equipment/{id} → 返回 C-001 mock Equipment 对象
    （name/type/current/thresholds/status/citations 字段完整）
  · GET /v1/objects/station/S001 → 返回场站 mock 数据
  · 验证：curl 返回完整对象，citations 字段正确

Day 5-7：Babylon.js 3D 原型（Studio）
  · maibot-ui 扩展：新增 TwinSurface 组件
  · 加载 station-data.json → 3D 几何体渲染（WebGPU，Mac Metal 加速）
  · 点击设备 → 调用 /v1/objects/equipment/{id} → 右侧面板显示设备信息
  · 验证：浏览器中 3D 场站可见，点击有响应

Day 8-10：OpenClaw Skills 接入（4 个能力 Skills）
  · 用户 OpenClaw 安装 industrial-twin + industrial-kb（从本目录加载）
  · 配置 CLAWTWIN_PLATFORM_URL=http://platform-api:8080
  · 测试（飞书）："C-001 状态？" → twin_read → mock 数据回复 + citations
  · 验证：飞书消息卡片中出现设备状态 + citations 字段

Day 11-14：Platform Scheduler + 告警推送
  · platform-api 添加 APScheduler（每小时模拟异常检测）
  · 随机触发"WARNING" → FeishuClient 发送告警卡片
  · 工单草拟：用户回复"建个工单" → industrial-workorder → workorder_draft
  → Platform 推飞书审批卡片 → 点击确认
  · 验证：完整 HITL 流程端到端可跑通
```

---

## 九、ADR-3 核心结论

```
1. 与 Palantir AIP 的对比：
   · 理念完全一致（本体 + 行动 + 治理）
   · 我们多出工业专业层（物理仿真/3D孪生/时序模型）
   · Phase B 补充 Ontology Discovery（自动发现）

2. 竞争分析诚实评估：
   · 竞争对手保守有合理原因（安全责任/数据质量）
   · 我们的策略：信息层优先，不碰控制层，HITL 保驾
   · 目标客户：中小型管道公司，先免费换数据验证

3. Skills 重设计（ADR-4.0 最终版）：
   · 4 个能力导向 Skills（twin/kb/workorder/analytics）
   · Cron 在 Platform Scheduler，HITL 状态机在 Platform
   · 详见 ADR-4-SKILL-DESIGN-AND-REVIEW.md

4. GPU 资源分配：
   · Mac：3D 渲染 + 轻量开发
   · GPU 服务器：LLM 推理 + 大模型 embedding

5. 缺失模块：
   · Phase A 补充：告警分级 + 设备档案
   · Phase B 补充：交班记录 + 多场站视图 + PDF 报告

6. Phase A 第一周：
   · 从 Ontology API mock + 3D 原型开始，10 天出可展示 demo
```
