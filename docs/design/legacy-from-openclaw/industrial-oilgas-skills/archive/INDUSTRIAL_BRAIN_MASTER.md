# 工业大脑 · 智能场站数字孪生系统

**版本**：FINAL 1.0 · 2026-05-08  
**定位**：以「数字样机」为感知基础，以「AI Agent」为认知核心，让工业场站 24/7 自主运转  
**口号**：不是在做工业软件，而是在为工业场站装一个永不疲倦的大脑

---

## 一、2029 年的一天——产品终态场景

> **凌晨 02:47，某天然气输气站，无人值守。**
>
> 指挥中心大屏正在运转：整个场站以光线追踪品质的 3D 呈现，  
> 天然气在玻璃般透明的管道里流动着蓝色粒子，  
> 每台设备的表面以温度色谱叠加——绿意盎然，今晚一切正常。
>
> **02:49**：压缩机 C-001 的轴承振动频谱出现 0.3mm 轴向位移——  
> 不是传感器超限（传感器此时显示"正常"），  
> 而是 MOIRAI 时序大模型在 72 小时历史数据里发现了振动模式的细微漂移。
>
> **02:49:12**：工业大脑开始推理。  
> Qwen3.6 调用 GraphRAG 检索 C-001 的 OEM 维修手册第 7.3 节、  
> ISO 13709 泵轴封标准第 5.1 条、本站 2023 年 #WO-2341 同类历史记录。  
> 物理代理模型计算：当前磨损速率下，轴封失效概率在 72 小时内达 38%，  
> 若失效将触发 SDV-002 自关、停输 4 小时、损失约 ¥120 万。
>
> **02:49:44**：大屏上 C-001 从绿色变为橙色，3D 模型自动飞行到轴封位置，  
> 爆炸视图展开——轴封、密封圈、轴承座，螺栓级细节全部可见，  
> 振动频谱图在设备旁浮出，异常频段以红色标注。
>
> **02:49:51**：场站主管的飞书手机响了：
>
> ```
> 🔶 C-001 轴封风险预警 · AI 置信度 87%
> 依据：维修手册 §7.3 · ISO 13709 §5.1 · #WO-2341
> 预测：72h 内失效概率 38%，停输损失 ¥120万
>
> AI 建议工单草稿已生成：
>   · 检查轴封磨损量（测量工具：千分尺）
>   · 备件：密封圈 P/N: 7823-A（库存: 3 件 ✓）
>   · 建议窗口：明日白班（09:00-12:00）
>
> [批准工单] [修改后批准] [暂不处理]
> ```
>
> **02:50:03**：主管点「批准工单」，翻身继续睡觉。  
> 工单自动进入 CMMS 系统，备件领料单生成，班组长 07:00 收到晨会通知。  
> 整个过程，**人只花了 12 秒。**

**这就是工业大脑。** 下面是它的完整设计。

---

## 二、系统总体架构

### 2.1 大脑的五层认知结构

```
╔═══════════════════════════════════════════════════════════════════════════╗
║  层 5 · 交互与展示层（人机界面）                                           ║
║  指挥大屏 Babylon.js 8 WebGPU · PC 控制台 · 飞书卡片 · 移动端             ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  层 4 · 认知与决策层（AI 推理）                                            ║
║  Qwen3.6-35B-A3B · OpenClaw Cron/TaskFlow · GraphRAG · MOIRAI 2.0       ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  层 3 · 记忆与知识层（长期记忆）                                           ║
║  Milvus 向量库 · GraphRAG 知识图 · PostgreSQL 工单历史 · MinIO 文档        ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  层 2 · 感知与孪生层（实时镜像）                                           ║
║  Eclipse Ditto 数字孪生 · Kafka 数据总线 · MOIRAI 异常检测               ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  层 1 · 物理与数据层（真实世界）                                           ║
║  OPC UA 传感器 · 仪表 · 阀门 · 压缩机 · P&ID 图纸 · OEM 手册            ║
╚═══════════════════════════════════════════════════════════════════════════╝
             ↑━━━━━━━━━━━━ equipment_id 主线贯穿所有层 ━━━━━━━━━━━━↑
```

### 2.2 完整系统架构图

```
                         物理世界（天然气场站）
         OPC UA 服务器 ──── 传感器/仪表/阀位 ──── 摄像头（Phase 3）
                │
                │ asyncua（Python）
                ▼
         ┌─────────────────────────────────────────────────────────┐
         │              Apache Kafka（消息总线）                     │
         │   Topic: sensors.raw / ditto.inbound / alerts.raw       │
         └──────────────┬──────────────────────┬───────────────────┘
                        │                      │
               ┌────────▼────────┐    ┌────────▼──────────────┐
               │  Eclipse Ditto  │    │   MOIRAI 2.0 Service   │
               │  数字孪生运行时  │    │   时序异常检测（CPU）   │
               │  Thing = 设备   │    │   → 异常事件 → Kafka   │
               │  Feature = 测点 │    └────────────────────────┘
               └────────┬────────┘              │
                        │ REST API              │ webhook
                        │                       │
         ┌──────────────▼───────────────────────▼───────────────────┐
         │                   OpenClaw Gateway                        │
         │                                                           │
         │  工具注册表（白名单，只读业务 API）：                        │
         │    twin_read(thingId)     → Ditto REST                   │
         │    kb_search(query)       → Milvus + GraphRAG            │
         │    asset_read(equipId)    → station-data.json API        │
         │    history_read(equipId)  → PostgreSQL TimescaleDB       │
         │    wo_draft(context)      → 生成工单草稿 JSON             │
         │    anomaly_explain(event) → MOIRAI + Qwen3.6 根因链      │
         │                                                           │
         │  Cron 调度（OpenClaw 内置）：                              │
         │    06:00 CST → 晨报 Agent → 飞书群推送                    │
         │    */30min   → 巡检 Agent → 全站状态扫描                   │
         │    事件触发  → 告警 Agent → 实时根因 + 飞书推送            │
         │                                                           │
         │  TaskFlow（工单 HITL）：                                   │
         │    create → 草稿 → setWaiting(飞书审批) → resume → 归档  │
         └──────────────┬──────────────────────────────────────────┘
                        │
         ┌──────────────▼──────────────┐
         │      Qwen3.6-35B-A3B        │
         │      vLLM INT4，1×H100      │
         │      文字 + 图像原生多模态    │
         └──────────────┬──────────────┘
                        │ 调用知识层
     ┌──────────────────┼──────────────────────┐
     │                  │                      │
┌────▼────────┐  ┌───────▼───────────┐  ┌──────▼──────────┐
│  Milvus     │  │   GraphRAG        │  │  PostgreSQL 16   │
│  语义向量库  │  │   知识图谱         │  │  + TimescaleDB  │
│  L0-L3 分层 │  │   MIT·v3.0.9     │  │  工单/台账/时序  │
│  citations  │  │   跨文档推理       │  │  + pgvector     │
└─────────────┘  └───────────────────┘  └─────────────────┘
                        │
                ┌───────▼────────────────────────────────┐
                │              MinIO                      │
                │   PDF 手册 · P&ID 图纸 · 模型权重        │
                └────────────────────────────────────────┘
                        │
         ┌──────────────▼──────────────────────────────────┐
         │               展示层（Babylon.js 8 WebGPU）       │
         │                                                   │
         │   指挥大屏（全屏）：                                │
         │     HDRI 环境光 + OpenPBR 材质 + 粒子流 + 热场    │
         │     实时 Ditto 状态 → 3D 颜色叠加                 │
         │     活跃告警 → 3D 自动飞行到异常设备位置           │
         │                                                   │
         │   PC 控制台（三列）：                               │
         │     AI 对话（左）+ 3D 视口（中）+ 数据面板（右）   │
         │                                                   │
         │   飞书：卡片 + 语音 + 审批（OpenClaw 桥接）        │
         └────────────────────────────────────────────────┘
```

---

## 三、数字孪生 3D 视觉设计（Babylon.js 8 WebGPU）

### 3.1 视觉层级规范

```
LOD 0（全站视图，< 100m）：
  · 设备以发光图标表示（颜色 = 状态：绿/橙/红）
  · 管道以粗线表示
  · KPI 数字浮层（进站压力/流量/差压）
  · 流向箭头动画

LOD 1（区域视图，< 30m）：
  · 程序化几何体（圆柱/球体/管段）
  · 单色 PBR 材质（钢铁灰）
  · 设备标签（位号 + 实时测点值）
  · 连接线（拓扑关系）

LOD 2（设备视图，< 10m，默认选中时）：
  · OpenPBR 材质（metalness + roughness + normal map）
  · ambientCG 工业材质库：
    - 碳钢管道：Metal047（metallic 0.95，rough 0.4）
    - 球阀阀体：Metal030（抛光，metallic 0.98，rough 0.1）
    - 仪表壳：Plastic020（metallic 0.0，rough 0.6）
    - 保温棉：Fabric030（蓬松感，rough 0.9）
  · polyhaven HDRI：industrial_workshop_foundry_4k.hdr
  · SSAO（环境光遮蔽）：边缝阴影真实感
  · Bloom：仪表发光效果

LOD 3（法兰/螺栓级，选中装配时）：
  · 参数化螺栓阵列（已实现：8 颗 M16 × 60mm）
  · 垫片可见
  · 法兰密封面纹理
  · 爆炸视图动画（拆解演示）
  · 测量工具：显示法兰 DN/PN/材质
```

### 3.2 实时数据可视化叠加

```
温度场（Phase 2）：
  · 每台设备 temperature 测点 → 色谱渐变叠加在几何表面
  · 颜色：蓝（冷）→ 绿（正常）→ 黄（偏高）→ 红（告警）
  · Babylon.js ShaderMaterial 实现（WGSL 着色器）

压力流向（Phase 2）：
  · 天然气流向以蓝色发光粒子在管道中流动
  · 粒子速度 = 归一化流量值
  · 分叉点粒子分流（物理感知）
  · 关闭阀门 → 粒子堆积在阀前

设备状态叠加：
  · 正常：绿色轮廓发光（emissive glow）
  · 偏差：橙色脉冲光晕（Babylon.js GlowLayer）
  · 告警：红色闪烁 + 飞书立即推送
  · 离线：灰色 + 虚线轮廓

AI 根因路径（告警时）：
  · 3D 场景自动飞行到异常设备（ArcRotateCamera animation）
  · 故障传播路径以红色箭头可视化（关联设备高亮）
  · 右侧面板展开根因链 + citations

P&ID 视图切换（2D/3D 联动）：
  · 工具栏切换：3D 模型 ↔ P&ID 图纸
  · 选中 SDV-001：3D 高亮 + P&ID 对应符号高亮
  · 两个视图共用 equipment_id 主线
```

### 3.3 指挥大屏布局

```
┌──────────────────────────────────────────────────────────────────────┐
│  [场站名称] · [当前时间] · AI 大脑状态: 正常运行 · [告警数: 0]         │ ← 顶栏
├──────┬───────────────────────────────────────────────────┬───────────┤
│      │                                                   │           │
│  资  │          3D 场站全景（Babylon.js 8 WebGPU）         │  活跃告   │
│  产  │          天然气粒子流动 · HDRI 工厂环境光           │  警列表   │
│  状  │          实时温度色谱叠加                           │           │
│  态  │          设备状态发光效果                           │  AI 当前  │
│  热  │                                                   │  分析中   │
│  力  │          进站 SDV-001 → 过滤器 → 压缩机 →         │  （动态）  │
│  图  │          计量 → 出站 SDV-003                       │           │
│      │                                                   │  工单待   │
│  (左)│                                    （中央主视口）  │  审批: 2  │
├──────┴───────────────────────────────────────────────────┴───────────┤
│  进站压力: 6.8 MPa ✓ │ 出站流量: 823 Mm³/d │ 差压: 0.3 MPa │ 气质: 97.2% CH₄│ ← KPI 条
└──────────────────────────────────────────────────────────────────────┘
```

---

## 四、AI 大脑的自主运转机制

### 4.1 三个常驻 Agent（24/7 循环）

```
Agent 1：感知 Agent（Sensor Monitor）
─────────────────────────────────────
触发：OpenClaw Cron · every 30s
工具：twin_read(all) → 拉取全站 Ditto 实时快照
      moirai_score(features) → 获取 MOIRAI 异常分数
逻辑：
  for each equipment in station:
    score = moirai_score(equipment.time_series)
    if score > threshold_orange:
      trigger → 分析 Agent（携带 thingId + 异常 features）
    if score > threshold_red:
      trigger → 分析 Agent + 立即飞书 @相关人
输出：更新 PostgreSQL anomaly_log 表

Agent 2：分析 Agent（Root Cause Analyst）
─────────────────────────────────────────
触发：感知 Agent 触发 OR 用户飞书提问
工具：asset_read(equipId) → 设备规格 + 历史工单
      kb_search(query) → RAG（L0-L3，citations 强制）
      graphrag_query(entity) → 跨文档知识图谱推理
      history_read(equipId, 90days) → 历史趋势
      twin_read(related_eqs) → 关联设备状态
逻辑：
  context = asset + history + twin_state + related_devices
  knowledge = kb_search + graphrag_query
  analysis = Qwen3.6(context + knowledge + anomaly_features)
  → 生成：根因链 + 风险量化 + 规程引用（citations 来自 L0-L3）
  → 触发：工单 Agent（若风险分 > 70）
  → 推送：飞书卡片（含 3D 跳转深链）
输出：analysis_result（含 cited_sources[]）

Agent 3：工单 Agent（Work Order HITL）
──────────────────────────────────────
触发：分析 Agent 触发 OR 用户请求
工具：asset_read + kb_search（规程步骤）
      inventory_check(part_numbers) → 备件库存
      wo_draft(analysis_result) → 生成标准工单 JSON
逻辑（OpenClaw TaskFlow）：
  flow = taskFlow.createManaged({
    goal: "工单审批",
    stateJson: { draft: wo_draft, analysis: analysis_result }
  })

  // 发飞书审批卡片
  send_feishu_card(approval_card)
  taskFlow.setWaiting({ waitJson: { kind: "feishu_approval" } })

  // 等待人点按钮（可能几分钟到几小时）
  // 飞书 webhook → OpenClaw → TaskFlow.resume()

  if approved:
    write_wo_to_db() + notify_maintenance_team()
    taskFlow.finish()
  if modified:
    apply_edits() + resubmit_card()
  if rejected:
    log_rejection_reason() + taskFlow.finish()
输出：工单记录（含完整审计链）+ 数据进入训练集
```

### 4.2 知识分层与 citations 机制

```
知识层级（L0 最权威，L3 最具体）：

L0 · 国际/国家标准（最高权威）
  · GB 50251、GB 50253（输气管道设计规范）
  · SY/T 6883（天然气输气站运行规程）
  · ISO 13709（离心泵标准）
  · API 6D（管线阀门标准）
  · OREDA 失效率数据库

L1 · 行业通用知识
  · 压缩机、球阀、仪表等通用维修方法
  · 失效模式与影响分析（FMEA 案例）
  · 工业通用操作 SOP

L2 · OEM 设备手册（厂家文档）
  · Emerson 调节阀维修手册
  · Endress+Hauser 流量计说明书
  · 压缩机厂家 OEM 规程
  · AASX 数字包（从厂家 portal 下载）

L3 · 本站专有知识（最近原则）
  · 历史工单（每条确认工单自动入库）
  · 本站运行规程（本地化版本）
  · 工程师手动添加的注意事项
  · AI 推理被采纳的建议（反馈学习）

citations 规则：
  · 所有 AI 输出必须附 citations[]
  · 每条 citation 标注：层级(L0-L3) + 文档名 + 章节 + 置信度
  · 无 citations → OpenClaw 拦截，不推送到飞书
  · 优先级：L0 > L1 > L2 > L3（但 L3 最具体，同等条件优先）
```

### 4.3 数据飞轮（复利机制）

```
第一轮：客户数据 → 更好的 L3 知识
  工程师批准工单 → 写入 L3 → 下次类似情况召回率更高

第二轮：标注数据 → 领域模型微调
  10 客户 × 12 个月 ≈ 80000 条标注交互
  → Qwen3.6-35B-A3B LoRA 微调（工业 SFT v1）
  → 工单准确率 65% → 85%；规程命中 70% → 92%

第三轮：微调模型 → 更好的产品 → 更多客户 → 更多数据
  → 护城河越来越宽（竞争对手没有这 3 年的工业标注数据）

第四轮：7B 领域小模型（2027 年底）
  → RTX 4090 本地运行
  → 客户可完全离线部署
  → 边远场站无公网也能运行完整 AI 大脑
```

---

## 五、完整技术栈（一次决定，版本锁定）

### 5.1 服务清单

| #   | 服务         | 镜像 / 版本                | 职责                            | 许可        |
| --- | ------------ | -------------------------- | ------------------------------- | ----------- |
| 1   | **openclaw** | openclaw/openclaw:latest   | LLM 网关·Cron·TaskFlow·飞书桥   | proprietary |
| 2   | **vllm**     | vllm/vllm-openai:v0.6+     | Qwen3.6-35B-A3B INT4 推理       | Apache 2.0  |
| 3   | **milvus**   | milvusdb/milvus:v2.5       | 语义向量检索 L0-L3              | Apache 2.0  |
| 4   | **etcd**     | bitnami/etcd:3.5           | Milvus 元数据                   | Apache 2.0  |
| 5   | **minio**    | minio/minio:RELEASE.2025   | 文档·模型·资产对象存储          | AGPL 3.0    |
| 6   | **postgres** | timescale/timescaledb:pg16 | 工单·台账·时序·用户数据         | Apache 2.0  |
| 7   | **ditto**    | eclipse/ditto:3.7          | 数字孪生运行时 (Thing/Feature)  | EPL 2.0     |
| 8   | **kafka**    | bitnami/kafka:3.7          | OPC UA → Ditto 消息总线         | Apache 2.0  |
| 9   | **moirai**   | 自构建 Python              | MOIRAI 2.0 时序异常检测         | Apache 2.0  |
| 10  | **graphrag** | 自构建 Python              | GraphRAG v3.0.9 知识图谱        | MIT         |
| 11  | **web**      | 自构建 Node+Nginx          | Babylon.js 8 + Studio + Command | Apache 2.0  |

### 5.2 AI 模型选型（版本锁定）

| 模型                | 版本       | 用途                          | 许可       | GPU         |
| ------------------- | ---------- | ----------------------------- | ---------- | ----------- |
| **Qwen3.6-35B-A3B** | 2026-04-16 | 主力 LLM：推理·工单·P&ID·铭牌 | Apache 2.0 | 1×H100 INT4 |
| **Qwen3.6-27B**     | 2026-04    | 重型推理：合规审查·报告生成   | Apache 2.0 | 按需启动    |
| **MOIRAI 2.0**      | 2025-08    | 时序异常检测（零样本）        | Apache 2.0 | CPU         |
| **SAM 2.1**         | Meta       | 图像分割（Phase 3 摄像头）    | Apache 2.0 | GPU         |

### 5.3 3D 技术栈

| 组件                 | 版本          | 用途                       | 许可       |
| -------------------- | ------------- | -------------------------- | ---------- |
| **Babylon.js**       | 8.x（WebGPU） | 全部 3D 渲染               | Apache 2.0 |
| **OpenPBR Material** | 已合并 8.x    | 物理精准材质               | Apache 2.0 |
| **polyhaven.com**    | 持续更新      | HDRI 环境光（工业场景）    | CC0        |
| **ambientCG.com**    | 持续更新      | PBR 材质（金属/管道/阀体） | CC0        |
| **Open CASCADE**     | 7.8           | STEP/IGES CAD 转换         | LGPL       |
| **MeshOptimizer**    | 0.21          | LOD 生成·网格优化          | MIT        |
| **Draco**            | 1.5           | 几何压缩（体积减少 90%）   | Apache 2.0 |

### 5.4 Python 服务依赖

```python
# services/moirai/requirements.txt
uni2ts>=2.0.0          # MOIRAI 2.0（Salesforce，Apache 2.0）
kafka-python>=2.0      # Kafka 消费者
fastapi>=0.111         # REST API
numpy>=1.26
torch>=2.3             # CPU 推理

# services/graphrag/requirements.txt
graphrag>=3.0.9        # Microsoft GraphRAG（MIT）
pymupdf>=1.24          # PDF → 文本
layoutparser>=0.3      # 版面分析（P&ID 预处理）
llama-index>=0.12      # RAG 框架（MIT）
pymilvus>=2.5          # Milvus Python SDK

# services/opc-ua-bridge/requirements.txt（Phase 2）
asyncua>=1.1           # OPC UA 客户端（MIT）
kafka-python>=2.0
```

---

## 六、数据接入与知识建立（从零开始的路径）

### 6.1 新客户上线 4 步走

```
Step 1（Day 1-3）：设备台账导入
  输入：客户 Excel 台账 OR P&ID 图纸扫描件
  工具：Qwen3.6 视觉 → 位号识别 → station-data.json 自动生成
  输出：equipment_id 主线建立（所有后续工作的基础）

Step 2（Day 3-7）：知识库建立
  输入：
    GB/SY 标准 PDF（从国家标准全文公开系统下载，部分免费）
    OEM 设备手册（Emerson/E+H 官网公开下载）
    客户自有规程文档
  工具：
    pymupdf → PDF 提取文本
    LlamaIndex → 分块向量化 → Milvus（L0-L3 分层）
    GraphRAG → 自动提取设备关系知识图谱
  输出：可查询的分层知识库（L0-L3），citations 体系就绪

Step 3（Day 7-14）：3D 场景建立
  输入：
    客户 P&ID → Qwen3.6 视觉解析 → 设备拓扑关系
    设备类型 → 参数化几何生成（阀门/管道/仪表/压缩机）
  工具：
    Babylon.js 程序化几何 + OpenPBR 材质
    设备摆放：按 P&ID 管道连接关系自动布局（力导向图）
  输出：3D 场站模型（LOD 1-2 就绪），与 equipment_id 绑定

Step 4（Day 14-21）：数据接入
  Phase 1：mock OPC UA 生产者（Python 脚本，模拟 30 个测点）
  Phase 2：真实 asyncua 桥接 → Kafka → Ditto
  输出：3D 场景实时数据叠加就绪
```

### 6.2 免费数据资源获取清单

```
① 国家标准全文（std.samr.gov.cn）
  · 免费：部分推荐性标准全文
  · 购买：强制性标准（单份约 ¥20-80）
  · 总预算：¥2000 购买完整油气相关标准集

② OEM 设备手册（免费公开）
  · Emerson 文档中心：emerson.com/documents
  · Endress+Hauser：endress.com/en/downloads
  · ABB：library.abb.com
  · Siemens：support.industry.siemens.com
  · 工具：Playwright + 批量 PDF 下载脚本

③ OREDA 失效率数据库
  · 购买：OREDA 2015 版（~$2000 约¥14000）
  · 用 Qwen3.6 提取结构化 λ/MTTF → L0 知识库

④ polyhaven.com（HDRI + 材质，CC0）
  · 工业场景 HDRI：industrial_workshop_foundry、concrete_floor
  · 材质：Metal047（管道钢）、Metal030（阀体）
  · 完全免费商用

⑤ ambientCG.com（PBR 材质，CC0）
  · Metal 系列：各类工业金属表面
  · Concrete 系列：地面/墙面
  · 完全免费商用

⑥ AASX 数字样机包（厂家主动发布）
  · Festo、Phoenix Contact、Endress+Hauser 已发布
  · 包含：3D 几何 + 技术规格 + 接口定义
  · 下载地址：idta.app（IDTA 官方库）
```

---

## 七、产品交付物定义（可销售）

### 7.1 四个产品

```
产品 1：ClawTwin Studio（PC 运维控制台）
  核心体验：AI 对话窗口（左）+ Babylon.js 3D 场景（中）+ 数据面板（右）
  主要功能：
    · 飞书/网页双入口 AI 对话
    · 设备选中 → 3D 飞行 + LOD 细节展示
    · 实时 Ditto 数据叠加（颜色 + 测点标签）
    · 装配视图（法兰/螺栓 LOD 3）
    · AI 分析面板（根因 + citations）
    · 工单全生命周期（AI 草稿 → 审批 → 执行 → 归档）
    · P&ID / 3D 视图联动切换
  年费：¥15 万/场站

产品 2：ClawTwin Command（指挥大屏）
  核心体验：全屏光线追踪质量 3D + 实时数据 + AI 摘要
  主要功能：
    · HDRI + OpenPBR 全真实感渲染
    · 天然气流动粒子可视化
    · 温度/压力热场叠加
    · 告警 → 3D 自动飞行到异常位置
    · AI 24 小时值班摘要（右侧滚动）
    · 一触进入 Studio 深链
  年费：¥18 万/套

产品 3：ClawTwin Mobile（飞书 AI 助手）
  核心体验：飞书卡片 + 语音对话 + 工单审批
  主要功能：
    · 每天 6:00 AI 晨报（晨报包含 3D 状态截图缩略图）
    · 异常实时推送 + 根因摘要 + 跳转深链
    · 工单审批卡片（一键批准/修改/拒绝）
    · 语音查询：「C-001 上次维修是什么时候？」
    · 铭牌拍照 → AI 自动录入设备台账
  年费：¥8 万/场站

产品 4：ClawTwin Platform（数据接口层）
  核心体验：REST API + Webhook，供第三方系统调用
  接口：
    GET  /v1/assets/{id}          ← 设备档案（含 AAS Shell）
    GET  /v1/twins/{id}/state     ← 实时 Ditto 状态
    POST /v1/ai/analyze           ← AI 分析（返回 citations）
    POST /v1/workorders           ← 工单创建入口
    WS   /v1/events               ← 告警实时推流
  年费：¥20 万（含 API 调用量）
```

### 7.2 服务

| 服务               | 内容                                   | 价格      |
| ------------------ | -------------------------------------- | --------- |
| **S1 知识工程**    | L0-L3 知识库建立（摄入+验证+RAG 测试） | ¥10-25 万 |
| **S2 数字样机**    | P&ID 解析 + 台账导入 + 3D 场景建立     | ¥15-40 万 |
| **S3 OPC UA 接入** | asyncua 桥接 + Ditto 配置 + 测点映射   | ¥8-15 万  |
| **S4 系统集成**    | SAP PM / Maximo / SCADA 工单对接       | ¥10-20 万 |
| **S5 领域微调**    | Qwen3.6 LoRA 微调（需 >1000 条数据）   | ¥30-60 万 |

---

## 八、实施阶段（一套架构，三个激活阶段）

```
Phase 1 · 点火（12 周）
──────────────────────────────────────────────
目标：1 个客户，工业大脑开始运转（mock 数据）
架构：11 个服务全部部署，mock OPC UA profile 激活
激活功能：
  ✅ AI 晨报（OpenClaw Cron 06:00）
  ✅ 飞书工单 HITL（TaskFlow）
  ✅ RAG 规程查询（L0-L3 知识库）
  ✅ Babylon.js 3D 场景（30 台设备，程序化几何）
  ✅ MOIRAI 异常检测（mock 数据）
  ✅ Ditto 数字孪生（mock OPC UA 数据）
  ✅ GraphRAG 知识图谱（5 份手册）
里程碑：连续 7 天晨报 + 3 条工单走完 HITL → 签合同

Phase 2 · 起飞（16 周）
──────────────────────────────────────────────
目标：3 个客户，1 个真实 OPC UA，视觉旗舰上线
架构：同一套，切换 production OPC UA profile
激活功能：
  ✅ 真实 OPC UA → Kafka → Ditto（1 客户）
  ✅ Babylon.js HDRI + OpenPBR + SSAO + Bloom（视觉旗舰）
  ✅ 天然气流动粒子
  ✅ 温度热场叠加
  ✅ P&ID OCR 全自动解析（Qwen3.6 视觉）
  ✅ 多租户（每客户独立数据命名空间）
  ✅ GraphRAG 跨文档推理（100 份文档）
  ✅ CMMS 工单对接（SAP PM 或 Maximo）
里程碑：ARR ≥ ¥100 万，Command 大屏在客户指挥室常驻运行

Phase 3 · 自主（12 个月+）
──────────────────────────────────────────────
目标：10+ 客户，领域模型自进化，AI 自主运转率 > 80%
激活功能：
  ✅ Qwen3.6-35B-A3B LoRA 微调（≥50K 标注数据触发）
  ✅ 设备 RUL 预测（MOIRAI + 物理代理模型）
  ✅ 摄像头视觉感知（SAM 2.1 + Qwen3.6 视觉）
  ✅ 7B 领域小模型（RTX 4090 可运行，完全离线）
  ✅ AR 现场引导（设备扫描 → 3D 叠加 → 步骤指引）
  ✅ 跨站知识迁移（一站学到的，全网受益）
  ✅ 工业知识库 SaaS（L0/L1 对外订阅）
里程碑：ARR ≥ ¥500 万，领域模型比通用强 30%+
```

---

## 九、equipment_id 主线：整个系统的灵魂

```
这是整个系统最重要的设计决定：
一个设备位号（如 SDV-001）在所有层次中保持同一个 ID。

P&ID 上：        SDV-001（位号标注）
station-data：   { "id": "SDV-001", "type": "ESD_Valve" ... }
OWL 本体：       twin:SDV-001 a twin:EmergencyShutoffValve
AAS Shell：      { "globalAssetId": "urn:...SDV-001" }
Ditto Thing：    "station-szp-a:SDV-001"
Kafka Topic：    sensors.raw → { "thingId": "station-szp-a:SDV-001" }
Milvus：         每个 chunk 的 metadata.equipment_ids = ["SDV-001"]
GraphRAG：       Node "SDV-001" → 边 → "PRV-030", "SDV-002"
3D 场景：        mesh.metadata.equipmentId = "SDV-001"
工单记录：       { "equipment_id": "SDV-001", "wo_id": "WO-2024-..." }
飞书卡片：       深链 https://twin.example.com/#SDV-001/ai

效果：
  · 3D 点击 SDV-001 → 自动查所有系统的 SDV-001 数据
  · AI 分析 SDV-001 → citations 包含所有与 SDV-001 相关的文档
  · 工单 WO → 自动关联 SDV-001 的历史工单和维修记录
  · 飞书卡片跳转 → 3D 自动高亮 SDV-001

没有这条主线，各系统就是一盘散沙。
有了这条主线，工业大脑才能真正理解「这台设备」是什么。
```

---

## 十、一句话

> **工业大脑不是工业软件的升级版，**  
> **而是为物理场站建造的数字意识——**  
> **它看见的是 3D 中每一个螺栓，**  
> **它记住的是每一份规程的每一个章节，**  
> **它感知的是每一个传感器的每一次跳动，**  
> **它推理的依据，是有据可查的每一条标准。**
>
> **工程师的角色从「找信息」变成「审批建议」，**  
> **从「盯大屏」变成「收到飞书点一个按钮」，**  
> **从「凌晨三点接告警电话」变成「早上七点收到 AI 已处理报告」。**
>
> **这就是工业大脑运转的样子。**

---

_综合前序文档：FINAL_ARCHITECTURE · TECH_DECISIONS · FINAL_PRODUCT_PLAN · MASTER_PRODUCT_STRATEGY · FUTURE_AI_NATIVE_VISION · AI_MODEL_LANDSCAPE_  
_模型依据：Qwen3.6-35B-A3B 2026-04-16 · MOIRAI 2.0 2025-08 · Babylon.js 8 OpenPBR 2025-10 · GraphRAG v3.0.9 2026-04_
