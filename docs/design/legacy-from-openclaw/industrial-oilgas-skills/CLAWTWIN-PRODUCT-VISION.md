# ClawTwin 产品愿景与战略定位

**地位**: 🔵 参考 / Product Vision  
**版本**: v2.0.0 (2026-05-13)  
**关键修订**: 正确映射 Studio=Gotham；澄清 Platform 不是 AI 智能体；强调充分利用已有资源  
**详细架构**: 见 `CLAWTWIN-ENTERPRISE-AI-ARCHITECTURE.md`

---

## 一、产品使命

> 在现有企业 IT/OT 系统之上，以最小侵入性加入**语义层 + AI 行动层 + 工作台**，让运营 AI 化成为每一个运营主体的现实，而非奢侈品。

**绝不重复建设**：AI 推理用 OpenClaw（或客户选择的 Agent）；数据库用客户现有的；控制系统不碰；只在语义和编排层创造独特价值。

---

## 二、与 Palantir 四产品的正确对照

| Palantir 产品           | 定位                                    | ClawTwin 对应                       | 说明                              |
| ----------------------- | --------------------------------------- | ----------------------------------- | --------------------------------- |
| **Gotham**              | 用户应用层（分析师/运营人员的工作界面） | **ClawTwin Studio**                 | 运营人员的日常工作台              |
| **Foundry**             | 企业语义数据平台                        | **ClawTwin Platform（Foundry 层）** | 本体 + 对象 + 管道 + 连接器       |
| **AIP**                 | AI 行动平台（LLM + 数据 + 编排）        | **ClawTwin Platform（AIP 层）**     | 函数执行 + 工作流 + MCP           |
| **Apollo**              | 部署运维管理                            | **ClawTwin Platform（Apollo 层）**  | Doctor + Health + CLI（轻量内嵌） |
| _AIP Assist（对话 AI）_ | _Palantir 自带的 LLM 对话界面_          | **OpenClaw（外部接入）**            | 客户可选，不锁定                  |

**核心差异**：Palantir 把 AIP Assist（对话 AI）做成自己的产品；ClawTwin 的 AI 智能体能力通过**开放接入外部 Agent（OpenClaw/Coze/Dify）**实现，客户有完整选择权。

---

## 三、三层产品结构

```
┌─────────────────────────────────────────────────────────────────────────┐
│  企业 AI 套件                                                             │
│                                                                         │
│  OpenClaw（外部 AI 智能体）    ClawTwin Studio（运营工作台 = Gotham）       │
│  "AI 推理大脑"                 "运营人员的界面"                            │
│       │                              │                                  │
│       │ MCP（工具调用）              │ REST/SSE                          │
│       └──────────────┬───────────────┘                                  │
│                      ▼                                                   │
│  ClawTwin Platform（运营语义平台 = Foundry + AIP + Apollo）               │
│  "连接现有系统 + 语义化 + AI 编排"                                         │
│       │                                                                  │
│       │ OPC-UA / REST / Webhook                                          │
│       ▼                                                                  │
│  现有 IT/OT 系统（全部保留）                                               │
│  SCADA · ERP · MES · CMMS · 飞书 · 钉钉                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 四、Platform 的 AI 能力边界（重要澄清）

**Platform 不是 AI 智能体**。Platform 的 AI 能力仅限于：

| AI 类型                                         | 谁负责                            | 说明                                      |
| ----------------------------------------------- | --------------------------------- | ----------------------------------------- |
| **对话推理**（多步、上下文、工具调用循环）      | **OpenClaw**（AgentRuntime 委托） | Platform 委托出去，不自己做               |
| **单次确定性 AI 函数**（结构化输入→结构化输出） | **Platform**（FunctionExecutor）  | 等同于"AI 数据库查询"，< 8 秒，自动化可靠 |

Platform 调 LLM 的唯一理由：FunctionType 单次推理（类比 SQL 查询，只是底层用 LLM）。**不做对话，不做规划，不做多步推理**——这些统统交给 OpenClaw。

---

## 五、通用平台 + 场景 Pack

**核心不含任何行业知识**，场景通过 Pack 加载：

```
启动 + oilgas Pack   → 油气运营平台
启动 + manufacturing Pack → 制造业平台
启动 + healthcare Pack  → 医疗运营平台
启动（无 Pack）      → 通用运营数字化底座
```

同一份代码，不同 Pack，不同行业。

---

## 六、多行业通用性证明

| 行业   | Equipment | Alarm    | WorkOrder | Station   |
| ------ | --------- | -------- | --------- | --------- |
| 油气   | 压缩机/泵 | 工艺告警 | 维护工单  | 场站      |
| 制造   | 机床/AGV  | 质量异常 | 生产工单  | 产线      |
| 医疗   | 医疗设备  | 临床告警 | 护理任务  | 科室      |
| IT运营 | 服务器    | 系统告警 | IT工单    | 机房      |
| 楼宇   | 暖通设备  | 环境告警 | 维修工单  | 楼层/区域 |

4 个核心本体类型（Equipment/Alarm/WorkOrder/Station）覆盖所有运营场景——这是"运营领域通用原语"，不是工业特有的。

---

## 七、产品包装（SKU 概览）

完整定义见 `CLAWTWIN-PRODUCT-PACKAGING.md`。

| SKU             | 激活能力                  | 适合阶段                       |
| --------------- | ------------------------- | ------------------------------ |
| **Core**        | 数字化底座（无 AI）       | 第 1 阶段：替代 Excel/纸质工单 |
| **Intelligent** | +AI 函数 +KB +推荐        | 第 2 阶段：工程师效率提升      |
| **Autonomous**  | +Playbook +飞轮 +数字孪生 | 第 3 阶段：工作流自动化        |
| **+OpenClaw**   | +MCP +AgentRuntime        | 第 4 阶段：自然语言驱动运营    |

---

## 八、与 Palantir 的竞争定位

|      | Palantir           | ClawTwin                      |
| ---- | ------------------ | ----------------------------- |
| 部署 | 云优先，复杂       | 单机 Docker，5 分钟启动       |
| AI   | AIP 自带，闭源，贵 | 接入 OpenClaw/Coze 等，客户选 |
| 扩展 | 专有 SDK           | Python + YAML + Pack          |
| 价格 | 百万美元年合同     | 按站点，无天价授权            |
| 飞轮 | 无                 | ✅ OutcomeEvent 持续学习      |

---

_产品定位随市场反馈更新。详见配套文档 `CLAWTWIN-ENTERPRISE-AI-ARCHITECTURE.md`（客户向架构图）和 `CLAWTWIN-DEFINITIVE-REFERENCE.md`（技术权威）。_
