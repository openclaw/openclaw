# 工业 AI 平台 · 技术决策文档

**版本**：1.0 · 2026-05-08（基于 OpenClaw 源码实际能力分析）  
**核心结论**：LangGraph 不需要；3D 迁移 Babylon.js 8 WebGPU；Phase 1 只用 6 个服务

---

## 一、LangGraph 分析：不需要，OpenClaw 已全覆盖

### 1.1 OpenClaw 原生能力（实际查阅源码确认）

```
src/cron/                     ← 完整的 Cron 调度系统
  types.ts                    ← CronSchedule: at / every / cron 表达式 + 时区
  isolated-agent/run.ts       ← 每次 cron 触发独立 Agent Session
  service/                    ← 状态管理、超时策略
  delivery*.ts                ← 结果推送（支持飞书 channel）

skills/taskflow-*/SKILL.md    ← TaskFlow 模式（*.lobster 工作流文件）
  taskFlow.createManaged()    ← 创建有状态工作流
  taskFlow.setWaiting()       ← 等待外部事件（如飞书审批回复）
  taskFlow.resume()           ← 收到回复后恢复执行
  taskFlow.finish()           ← 完成工作流
```

### 1.2 需求 → OpenClaw 原生映射

| 场景                             | LangGraph 方案        | OpenClaw 原生方案                                             | 结论                |
| -------------------------------- | --------------------- | ------------------------------------------------------------- | ------------------- |
| 早报定时推送（每天 6:00）        | LangGraph + 外部 cron | **OpenClaw Cron**（cron 表达式 + 隔离 Agent + 飞书 delivery） | ✅ 用 OpenClaw      |
| 工单审批 HITL（等待人点按钮）    | LangGraph interrupt   | **TaskFlow.setWaiting()** 等待飞书 webhook + resume           | ✅ 用 TaskFlow      |
| 告警→分析→推卡片（线性）         | LangGraph 简单图      | **OpenClaw 工具链**（tool 顺序调用）                          | ✅ 用 OpenClaw 工具 |
| 多 Agent 协作（监测→分析→工单）  | LangGraph 多节点      | **OpenClaw subagent** 系统                                    | ✅ 用 subagent      |
| 有复杂分支 + 跨天状态（Phase 3） | LangGraph 才体现价值  | TaskFlow 也可覆盖大部分                                       | ⚠ Phase 3 再评估    |

**结论：整个 Phase 1 和 Phase 2 完全不需要 LangGraph。**

### 1.3 早报 Cron 配置示例（OpenClaw 原生）

```json
{
  "kind": "cron",
  "expr": "0 6 * * *",
  "tz": "Asia/Shanghai",
  "delivery": {
    "mode": "announce",
    "channel": "feishu",
    "to": "站场工程师群 chat_id"
  },
  "session": "isolated",
  "prompt": "生成今日场站 AI 晨报。查询 RAG 知识库和设备状态，生成结构化飞书卡片，包含：① 异常摘要 ② 待处理工单 ③ 设备健康建议。每项必须有 citations 来源。"
}
```

### 1.4 工单 HITL 流程（TaskFlow + 飞书）

```
工程师发飞书消息: "SDV-001 需要 PST 测试"
  ↓
OpenClaw 工具调用: kb_search(规程) + asset_read(SDV-001)
  ↓
Qwen3.6 生成工单草稿 JSON
  ↓
TaskFlow.createManaged({ goal: "工单审批", stateJson: { draft: ... } })
  ↓
发送飞书审批卡片（含 [批准] [修改] [拒绝] 按钮）
  ↓
TaskFlow.setWaiting({ waitJson: { kind: "feishu_approval", cardId: "..." } })
  ↓
工程师点 [批准] → 飞书 webhook → OpenClaw 接收
  ↓
TaskFlow.resume() → 写入工单记录 → 发确认卡片
  ↓
TaskFlow.finish()
```

---

## 二、模块逐一分析与裁决

### 模块 1：LLM 推理

```
方案：Qwen3.6-35B-A3B (vLLM) + OpenClaw Gateway 连接
裁决：✅ 正确，不变
理由：3B 激活参数 = 快；35B 权重 = 质量；文字+图像原生 = 不需要额外视觉模型
     vLLM 提供 OpenAI 兼容接口，OpenClaw 直接对接
注意：INT4 量化部署（AWQ），2×A100 40G 或 1×H100 80G 可跑
```

### 模块 2：RAG 知识引擎

```
Phase 1 方案：LlamaIndex + pgvector（PostgreSQL 向量扩展）
  · pgvector：PostgreSQL extension，1 条 Docker 服务搞定
  · 完全取代 Milvus（Milvus 需要 etcd + minio + milvus = 3 个服务）
  · LlamaIndex 文档解析 + 分块 + 向量化（已有最佳实践）
  · 够用规模：100 万以内向量（工业场站文档体量）

Phase 2 扩展：迁移到 Milvus
  · 触发条件：pgvector 查询 >200ms 或向量数 >500 万

知识图谱（Phase 1 跳过，Phase 2 引入）：
  · Phase 2：Microsoft GraphRAG v3.0.9（MIT，2026-04 更新，活跃维护）
  · GraphRAG 自动从文档提取知识图谱（用 Qwen3.6 作提取 LLM）
  · 取代 Jena Fuseki 的角色（更易用，无需 SPARQL 专业知识）
  · Phase 2 之前：用 station-data.json JSON 关系替代知识图谱

裁决：
  Phase 1: LlamaIndex + pgvector ✅（删除 Milvus + Jena Fuseki）
  Phase 2: + GraphRAG（跨文档推理），+ Milvus（规模）
```

### 模块 3：数字孪生运行时

```
Phase 1 方案：完全跳过 Ditto
  · station-data.json 提供静态设备数据
  · 仿真值（JavaScript 随机模拟）作为实时数据展示
  · 零运维成本；POC 快速交付

Phase 2 方案：Eclipse Ditto + OPC UA
  · 触发条件：客户有真实 OPC UA 服务器 + 付费合同签署
  · 此时才有价值接入真实数据

裁决：Phase 1 删除 Ditto ✅（节省 2 个服务 + 大量配置工作）
```

### 模块 4：时序异常检测

```
方案：MOIRAI 2.0（Salesforce，Apache 2.0，2025-08 发布）
优势：
  · 比 MOIRAI 1.0 快 44%，小 96%（极轻量）
  · 零样本：无需标注数据直接检测异常
  · CPU 可运行（不占 GPU）
部署：Python 服务，Docker 容器，调用 REST API

Phase 1 数据来源：模拟 OPC UA（Python 生成历史数据 CSV）
Phase 2 数据来源：真实 OPC UA → Kafka → MOIRAI

裁决：✅ 正确，Phase 1 用模拟数据跑通 MOIRAI pipeline 即可
```

### 模块 5：3D 渲染（最重要的体验决策）

```
当前：Three.js r165（浏览器端）
问题：Three.js WebGPU 渲染器成熟度不及 Babylon.js；缺乏 OpenPBR 支持

目标：Babylon.js 8（最新稳定版）WebGPU 后端
特性（2025-2026 新增，均已合并 main）：
  · PBR 完整移植 WGSL（WebGPU Shading Language）
  · OpenPBR Material + KHR_materials_openpbr glTF 扩展（2025-10）
  · Clustered Lighting（2025-08，支持工业场景多光源）
  · SSAO / Bloom / 色调映射（内置后处理）
许可：Apache 2.0，可商用

迁移策略（降低风险）：
  · PC Studio 控制台：维持 Three.js（功能优先，不追求极致视觉）
  · 指挥大屏（Command）：新建 Babylon.js 8 WebGPU 应用 ← 视觉旗舰
  · 飞书 3D 预览：Three.js WebGL（移动端兼容性优先）

3D 效果最大化公式：
  好引擎（Babylon.js 8）+ 好光照（HDRI）+ 好材质（OpenPBR）+ 后处理

裁决：Command 大屏用 Babylon.js 8 ✅；Studio 当前 Three.js 可继续
```

### 模块 6：免费 3D 资产资源（CC0 可商用）

```
HDRI 环境光照（最影响视觉效果的单一因素）：
  polyhaven.com → 700+ 工业/户外 HDRI（CC0，免费商用）
  推荐工业场景：
    · "industrial_workshop_foundry_4k.hdr"（工厂内部）
    · "outdoor_umbrellas_4k.hdr"（室外设施）
  接入：Babylon.js CubeTexture / HDRCubeTexture

PBR 材质库（金属/管道/阀体/混凝土）：
  ambientCG.com → 1000+ CC0 PBR 材质（含 Metal, Rust, Concrete, Pipe）
  polyhaven.com → 500+ CC0 材质（更高质量）
  接入：glTF PBRMaterial（metalness + roughness + normal map）

参数化设备 3D 模型（我们自建，CC0 友好）：
  使用 THREE.js / Babylon.js 程序化几何：
    · TubeGeometry → 管道
    · CylinderGeometry → 阀体/仪表壳
    · TorusGeometry → 法兰
    · 螺栓：已实现参数化（LOD3）
  材质：接入 ambientCG 工业金属材质
  效果：≥ 商业 3D 游戏工厂场景

开源工业 3D 模型：
  Sketchfab（CC0 过滤）：搜索 "industrial valve CC0"、"pipeline equipment CC0"
  NASA 3D Resources：航空航天设备高精度模型（政府公开）
  GrabCAD（部分项目许可）：谨慎使用，逐个确认许可证
```

### 模块 7：P&ID 解析

```
方案：Qwen3.6-35B-A3B 视觉模式
流程：P&ID PDF → PDF 转 PNG（pymupdf）→ Qwen3.6-VL → 结构化 JSON

Prompt 策略（few-shot）：
  "图中是一张 P&ID 工艺管道仪表图。请识别：
  1. 所有设备位号（格式如 SDV-001, PRV-030）
  2. 设备类型（根据符号：阀门/仪表/泵/换热器）
  3. 管道连接关系（from 位号 → to 位号）
  以 JSON 格式返回..."

准确率预期：位号识别 ~88%，连接关系 ~70%（人工确认剩余）
增强：LayoutParser（开源，Apache 2.0）做预处理→提升结构检测

裁决：✅ 正确方案，增加 LayoutParser 预处理
```

### 模块 8：数据库选型

```
Phase 1（单机全部）：
  PostgreSQL 16 + pgvector + TimescaleDB
    · pgvector：向量检索（替代 Milvus）
    · TimescaleDB：时序数据（替代 InfluxDB）
    · 一个数据库覆盖：关系数据 + 向量 + 时序
  SQLite：工单记录（极简，文件型，零运维）

Phase 2：
  + Milvus（向量规模化）
  + Redis（缓存和队列）

裁决：Phase 1 用 PostgreSQL + pgvector + TimescaleDB ✅
     删除：Milvus、InfluxDB、独立向量库
```

### 模块 9：部署架构

```
Phase 1 最小服务栈（6 个 Docker 服务）：
  1. openclaw-gateway    ← OpenClaw + 工业工具 + Cron + TaskFlow
  2. qwen36-vllm         ← Qwen3.6-35B-A3B（vLLM，INT4，GPU）
  3. postgres            ← PostgreSQL + pgvector + TimescaleDB
  4. minio               ← 文档存储（LlamaIndex 需要）
  5. moirai-service      ← MOIRAI 2.0 REST 服务（CPU）
  6. web-app             ← Three.js Studio + Nginx 静态服务

Docker Compose 一键启动（目标：30 分钟完成客户部署）

Phase 2 新增（4 个）：
  7. ditto               ← Eclipse Ditto（真实 OPC UA）
  8. kafka               ← 数据总线
  9. zookeeper           ← Kafka 依赖
  10. babylon-command    ← 指挥大屏（Babylon.js 8 WebGPU）
```

---

## 三、最终精简技术栈（完整版）

```
AI 推理层：
  LLM：          Qwen3.6-35B-A3B（vLLM，INT4，2×A100 可跑）
  时序：          MOIRAI 2.0（Salesforce，Apache 2.0，CPU）
  P&ID 视觉：    Qwen3.6-35B-A3B 视觉模式（同一模型）

Agent 编排层：
  定时任务：      OpenClaw Cron（内置，无需 LangGraph）
  工作流 HITL：  OpenClaw TaskFlow + lobster（内置，无需 LangGraph）
  工具调用：      OpenClaw 工具系统（内置）
  飞书集成：      OpenClaw 飞书桥接（内置）
  ❌ LangGraph：不需要，Phase 3 再评估

知识层：
  文档 RAG：     LlamaIndex 0.12+（Apache 2.0）+ pgvector
  知识图谱：     Phase 2 引入 Microsoft GraphRAG（MIT）
  文档存储：     MinIO（Apache 2.0）
  ❌ Jena Fuseki：Phase 2 之前不需要
  ❌ Milvus：    Phase 2 触发时引入

数据层：
  主库：          PostgreSQL 16 + pgvector + TimescaleDB（一体化）
  工单记录：      SQLite（轻量）
  ❌ Ditto：      Phase 2 引入（真实 OPC UA 时）
  ❌ Kafka：      Phase 2 引入

3D 渲染层：
  PC 控制台：    Three.js（现有代码，继续维护）
  指挥大屏：     Babylon.js 8 + WebGPU + OpenPBR（新建）
  HDRI：         polyhaven.com（CC0，工业环境光）
  材质：         ambientCG.com（CC0，PBR 金属/管道材质）
  设备模型：     参数化程序化几何 + CC0 材质

飞书通信：
  主入口：       飞书 App（语音消息 → 飞书 ASR → 文字 → OpenClaw）
  卡片：         飞书富文本交互卡片（工单/告警/晨报）
  审批：         飞书审批 API（HITL 走飞书原生审批流程）
  ❌ 自建 ASR/TTS：不需要，飞书原生搞定
```

---

## 四、可借鉴的开源项目清单

### 4.1 数据和知识资源（免费获取）

```
GB/SY 标准文本：
  · 国家标准全文公开系统（std.samr.gov.cn）→ 部分免费 PDF
  · 重点：GB 50251、GB 50253、SY/T 系列
  · 摄入：pymupdf + LlamaIndex SimpleDirectoryReader

OEM 设备手册（合法爬取）：
  · Emerson 文档中心（emerson.com/documents）→ 公开 PDF
  · Endress+Hauser（endress.com/en/downloads）→ 公开技术手册
  · 方法：Playwright 自动化下载 + LlamaIndex 批量摄入

OREDA 数据（结构化）：
  · 购买 OREDA 2015 版（约 $2000）
  · 用 Qwen3.6 提取失效率 λ + MTTF → 结构化 JSON → L0 知识层

工业流程图纸（合法 CC0）：
  · Wikimedia Commons：大量 P&ID 示意图（教学用）
  · 用于 P&ID 解析模型 few-shot examples
```

### 4.2 开源工具库（直接使用，不重复造轮子）

```
文档处理：
  · pymupdf（AGPL）：PDF → 图片/文本提取
  · LayoutParser（Apache 2.0）：文档版面分析，P&ID 预处理
  · LlamaIndex（MIT）：RAG 编排，文档分块，向量化

3D 处理：
  · Open CASCADE Technology（LGPL）：STEP/IGES CAD 格式读取
  · ifcOpenShell（LGPL）：IFC 格式处理
  · MeshOptimizer（MIT）：网格优化，LOD 生成
  · draco（Apache 2.0）：几何压缩（体积减少 90%）

P&ID 辅助：
  · LayoutParser（Apache 2.0）：符号区域检测
  · easyocr（Apache 2.0）：位号文字识别（补充 Qwen3.6）

数据管道：
  · asyncua（MIT）：Python OPC UA 客户端（Phase 2）
  · aiokafka（Apache 2.0）：Kafka 客户端（Phase 2）

可视化（非 3D）：
  · Apache ECharts（Apache 2.0）：时序趋势图（在飞书卡片中嵌入）
  · Recharts（MIT）：React 图表（Studio 控制台）
```

### 4.3 Babylon.js 8 最佳效果实现参考

```
官方示例（babylon.js 官网 Playground）：
  · PBR Material Viewer：metalness + roughness + normal map 实时预览
  · GLTF Loader with OpenPBR：导入 OEM glTF 模型并应用 OpenPBR 材质
  · Post-processing pipeline：SSAO + Bloom + Tone mapping

社区资源：
  · GitHub: BabylonJS/Babylon.js（Apache 2.0，71k stars）
  · Doc: doc.babylonjs.com（完整 API 文档）
  · Forum: forum.babylonjs.com（活跃社区）

工业 3D 效果关键配置：
```

```javascript
// Babylon.js 8 工业场景最优配置
const engine = new WebGPUEngine(canvas);
await engine.initAsync();
const scene = new Scene(engine);

// 1. HDRI 环境光（来自 polyhaven.com CC0）
const hdrTexture = CubeTexture.CreateFromPrefilteredData(
  "/assets/industrial_workshop_4k.env",
  scene,
);
scene.environmentTexture = hdrTexture;
scene.environmentIntensity = 1.2;

// 2. OpenPBR 金属管道材质（来自 ambientCG.com CC0）
const pipeMat = new PBRMaterial("pipe-steel", scene);
pipeMat.metallic = 0.9;
pipeMat.roughness = 0.3;
pipeMat.albedoTexture = new Texture("/assets/metal_albedo.jpg", scene);
pipeMat.bumpTexture = new Texture("/assets/metal_normal.jpg", scene);
pipeMat.metallicTexture = new Texture("/assets/metal_orm.jpg", scene);

// 3. 后处理管线（SSAO + Bloom）
const pipeline = new DefaultRenderingPipeline("main", true, scene);
pipeline.ssaoEnabled = true;
pipeline.bloomEnabled = true;
pipeline.bloomThreshold = 0.8;
pipeline.imageProcessingEnabled = true;
pipeline.imageProcessing.toneMappingEnabled = true;
pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
```

---

## 五、阶段目标与成功标准（精简可执行版）

### Phase 1（2026 Q2，12 周，单客户 MVP）

**技术目标：6 个 Docker 服务，30 分钟部署**

```
Week 1-2：模型 + 基础
  □ Qwen3.6-35B-A3B INT4 vLLM 部署验证（对话正常）
  □ OpenClaw 连接 Qwen3.6（工具调用验证）
  □ PostgreSQL + pgvector 启动（向量查询验证）
  □ 飞书桥接验证（发一条 OpenClaw 消息到飞书）

Week 3-4：数据 + 知识库
  □ 30 台设备 station-data.json（P&ID OCR 或手动录入）
  □ 5 份 GB 标准 PDF → LlamaIndex 摄入 → pgvector
  □ 5 份设备手册 PDF → 摄入（L2 知识层）
  □ OpenClaw 工具：asset_read、kb_search（citations 验证）

Week 5-8：核心功能
  □ OpenClaw Cron：每天 6:00 晨报（飞书卡片推送）
  □ OpenClaw TaskFlow：工单 HITL（草稿→审批→归档）
  □ MOIRAI 2.0：模拟数据异常检测（阈值超出推飞书）
  □ Three.js Studio：基础 3D 场景（30 台设备可视化）

Week 9-12：上线 + 迭代
  □ Docker Compose 一键部署脚本（客户内网）
  □ 飞书晨报连续 7 天
  □ 工单流程完整走通 5 次
  □ 签署年度合同

成功标准：
  · 晨报准时率 ≥ 95%
  · 工单草稿客户满意度 ≥ 60%（问卷）
  · 规程 RAG 命中相关段落 ≥ 70%
  · 合同：≥ ¥20 万首年
  · 数据：≥ 200 条工单交互记录（为 Phase 3 准备）
```

### Phase 2（2026 Q3-Q4，16 周，3 客户 + 视觉升级）

```
优先交付：
  □ P&ID OCR 解析 pipeline（Qwen3.6 视觉，新客户上线提速）
  □ Babylon.js 8 指挥大屏（HDRI + OpenPBR，视觉旗舰）
  □ Eclipse Ditto + asyncua（真实 OPC UA，1 个客户试点）
  □ MOIRAI 接真实传感器历史数据
  □ Microsoft GraphRAG（跨文档知识图谱，替代 Jena Fuseki）
  □ 多租户（每客户独立命名空间）

成功标准：
  · 3 家付费客户
  · Babylon.js 大屏在客户指挥室运行 ≥ 30 天
  · ARR ≥ ¥100 万
  · 数据：≥ 2000 条标注交互
```

### Phase 3（2027+，数据飞轮）

```
启动条件：≥ 10 客户 OR ≥ 50000 条标注数据

行动：
  □ Qwen3.6-35B-A3B LoRA 微调（工业 SFT v1）
  □ 工单准确率 70% → 85%
  □ 7B 领域小模型训练（RTX 4090 可运行）
  □ 物理代理模型（MOIRAI 输出驱动 PINN 补全）

成功标准：
  · 10 客户，ARR ≥ ¥500 万
  · 领域模型比通用 Qwen3.6-7B 强 25%（工业基准测评）
```

---

## 六、技术选型最终裁决表

| 模块            | 选型                        | Phase 1 | Phase 2       | 理由                 |
| --------------- | --------------------------- | ------- | ------------- | -------------------- |
| LLM             | Qwen3.6-35B-A3B (vLLM)      | ✅      | ✅            | 文字+图像，3B 激活快 |
| Agent 编排      | OpenClaw Cron + TaskFlow    | ✅      | ✅            | 原生，零引入成本     |
| **LangGraph**   | **不引入**                  | **❌**  | **❌**        | OpenClaw 已全覆盖    |
| 向量检索        | pgvector（PostgreSQL 扩展） | ✅      | → Milvus      | 单服务，零运维       |
| 知识图谱        | 跳过                        | ❌      | GraphRAG(MIT) | Phase 1 不需要       |
| 孪生运行时      | Eclipse Ditto               | ❌      | ✅            | 真实 OPC UA 后引入   |
| 时序 AI         | MOIRAI 2.0（CPU）           | ✅      | ✅            | 零样本，极轻量       |
| 3D PC 控制台    | Three.js                    | ✅      | ✅            | 现有代码，够用       |
| **3D 指挥大屏** | **Babylon.js 8 WebGPU**     | ❌      | **✅**        | 最佳视觉效果         |
| HDRI + 材质     | polyhaven + ambientCG       | —       | ✅            | CC0 免费商用         |
| 语音            | 飞书原生 ASR                | ✅      | ✅            | 无需自建             |
| 工单 HITL       | OpenClaw TaskFlow           | ✅      | ✅            | 原生，Feishu webhook |
| 主数据库        | PostgreSQL 16               | ✅      | ✅            | 一体化，覆盖全部     |
| 文档 RAG        | LlamaIndex + pgvector       | ✅      | ✅            | 成熟，开箱即用       |
| P&ID 解析       | Qwen3.6 视觉                | ✅      | ✅            | 内置多模态           |

---

## 七、一句话技术宗旨

> **最好的代码是不写的代码。**  
> OpenClaw 的 Cron + TaskFlow 已经是工业工作流引擎；  
> Qwen3.6-35B-A3B 的视觉能力已经是 P&ID 解析器；  
> 飞书的 ASR + 审批是声音交互和 HITL；  
> polyhaven + ambientCG 是 3D 视觉升级的直接原料；  
> 我们的价值在于：把这些拼对，聚焦在工业场景真正缺失的部分。

---

_模型依据：Qwen3.6-35B-A3B（2026-04-16）· MOIRAI 2.0（2025-08，论文 2026-02）_  
_Babylon.js 依据：OpenPBR merged Oct 2025 · Clustered Lights Aug 2025 · WGSL PBR 完整移植_  
_OpenClaw 依据：源码 src/cron/ + skills/taskflow-inbox-triage/SKILL.md_
