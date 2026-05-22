# ClawTwin 产品包装与销售策略

**地位**: 🔵 参考 / Product Packaging  
**版本**: v1.0.0 (2026-05-13)  
**读者**: 产品、销售、解决方案工程师

---

## 一、产品包装设计原则

ClawTwin 的 Capability 系统（`infra/capabilities.py`）天然支持 SKU 包装：

```
不可关闭（Always-on）      可选能力（Optional）
──────────────────         ────────────────────────────────────
equipment                  kb · ai · playbook · feishu · robot
alarm                      pgvector · ingest · export
workorder                  outcome_tracking · recommendations
audit                      health_vector · causal_graph
```

**原则**：不同 SKU = 不同 Capability 组合 + 不同 IndustryPack。销售不同包装时，**核心代码完全相同**，只是激活的能力集不同。

---

## 二、四个产品 SKU

### SKU-0：ClawTwin Core（运营数字化底座）

**定位**：传统 OT/IT 系统的数字化升级入口，零 AI 成本，快速见效  
**竞争**：替代纸质/Excel 工单系统和孤立的告警管理

```
激活能力：equipment + alarm + workorder + audit + ingest + feishu
关闭能力：ai · playbook · kb · pgvector · outcome_tracking · recommendations

典型价值：
  ✓ 设备、告警、工单全数字化
  ✓ 实时数据接入（OPC-UA/Modbus）
  ✓ 飞书/钉钉告警推送
  ✓ 完整审计追踪（合规可查）
  ✗ 无 AI 诊断
  ✗ 无自动化工作流
```

**适合客户**：刚开始数字化的中小型工厂/场站，IT 预算受限，先证明价值  
**定价锚点**：按站点/月，低门槛进入  
**销售周期**：2-4 周 POC → 快速成交

---

### SKU-1：ClawTwin Intelligent（AI 辅助运营）

**定位**：AI 加持的运营辅助，给工程师"超级大脑"  
**竞争**：替代独立 AI 问答工具和人工经验依赖

```
激活能力：Core 全部 + ai + kb + recommendations + causal_graph
关闭能力：playbook · pgvector · outcome_tracking · export · health_vector

典型价值：
  ✓ AI 诊断（接入客户自有 LLM 或 Ollama 本地模型）
  ✓ CBR 知识库推荐（"以前类似情况怎么处理的"）
  ✓ 因果图分析（"设备 A 故障会影响哪些下游设备"）
  ✓ 自然语言查询设备状态
  ✗ 无自动化工作流（仍需人工触发）
  ✗ 飞轮未开启（推荐准确率随时间固定）
```

**适合客户**：已有数字化基础，想用 AI 提升工程师效率，但不想全自动化  
**定价锚点**：Core + AI token 用量计费（AI 成本透明可控）  
**销售周期**：1-2 个月，有明确 ROI（工程师诊断时间缩短）

---

### SKU-2：ClawTwin Autonomous（AI 自治运营）

**定位**：自动化工作流 + 持续学习飞轮，向 L3-L4 自治迈进  
**竞争**：替代 RPA 工具和硬编码自动化脚本

```
激活能力：Intelligent 全部 + playbook + pgvector + outcome_tracking + export + health_vector
关闭能力：robot（Phase B）

典型价值：
  ✓ Playbook 自动触发工作流（告警→诊断→工单→通知→HITL 一键）
  ✓ 高置信度操作自动执行（L3，无需每次审批）
  ✓ OutcomeEvent 飞轮（每次干预结果自动学习，推荐越来越准）
  ✓ 数字孪生健康评分（Mahalanobis 偏差检测）
  ✓ pgvector 向量检索（更准确的历史案例匹配）
  ✓ 训练数据导出（为未来专属 AI 模型准备）
```

**适合客户**：已验证 AI 价值，希望减少人工干预，追求持续优化的自动化  
**定价锚点**：企业合同，按站点/年  
**销售周期**：3-6 个月，需要实施服务

---

### SKU-3：ClawTwin + OpenClaw（全智能运营平台）

**定位**：自然语言驱动的企业 AI 操作中心  
**竞争**：替代 Palantir AIP（低价、私有部署、开放扩展）

```
ClawTwin Autonomous + OpenClaw 集成：
  激活额外能力：MCP Server + AgentRuntime（OpenClaw）

典型价值：
  ✓ 一句话："帮我检查下 C-001 压缩机最近的状态" → 自动查询+分析+汇报
  ✓ 飞书机器人 → ClawTwin MCP → 执行操作，全闭环
  ✓ 复杂推理委托给 OpenClaw，操作执行在 ClawTwin
  ✓ 任何人（非工程师）都能通过对话访问运营智能
```

**适合客户**：已有 OpenClaw 部署，希望接入业务系统；或大型企业需要 AI 驱动运营中枢  
**定价锚点**：ClawTwin 企业版 + OpenClaw 授权捆绑  
**销售周期**：6-12 个月大项目

---

## 三、SKU 能力对照表（一眼看清）

| 能力                                  | Core | Intelligent | Autonomous | +OpenClaw |
| ------------------------------------- | :--: | :---------: | :--------: | :-------: |
| equipment / alarm / workorder / audit |  ✅  |     ✅      |     ✅     |    ✅     |
| ingest（OPC-UA/Modbus 数据接入）      |  ✅  |     ✅      |     ✅     |    ✅     |
| feishu（飞书通知）                    |  ✅  |     ✅      |     ✅     |    ✅     |
| ai（LLM 诊断推理）                    |  ❌  |     ✅      |     ✅     |    ✅     |
| kb（知识库）                          |  ❌  |     ✅      |     ✅     |    ✅     |
| recommendations（CBR 推荐）           |  ❌  |     ✅      |     ✅     |    ✅     |
| causal_graph（因果图）                |  ❌  |     ✅      |     ✅     |    ✅     |
| playbook（自动工作流）                |  ❌  |     ❌      |     ✅     |    ✅     |
| pgvector（向量检索）                  |  ❌  |     ❌      |     ✅     |    ✅     |
| outcome_tracking（飞轮）              |  ❌  |     ❌      |     ✅     |    ✅     |
| health_vector（数字孪生健康）         |  ❌  |     ❌      |     ✅     |    ✅     |
| export（训练数据导出）                |  ❌  |     ❌      |     ✅     |    ✅     |
| MCP Server（对外工具暴露）            |  ❌  |     ❌      |     ❌     |    ✅     |
| OpenClaw AgentRuntime                 |  ❌  |     ❌      |     ❌     |    ✅     |

---

## 四、行业 Pack × SKU 矩阵

Pack 与 SKU 正交——任何 Pack 可搭配任何 SKU：

| Pack             | 覆盖场景           | 推荐起步 SKU       | 完整价值 SKU |
| ---------------- | ------------------ | ------------------ | ------------ |
| `oilgas/`        | 油气田、场站、管道 | Intelligent        | Autonomous   |
| `manufacturing/` | 离散制造、装配线   | Core → Intelligent | Autonomous   |
| `healthcare/`    | 医院设备、护理流程 | Intelligent        | +OpenClaw    |
| `itops/`         | 数据中心、SRE      | Intelligent        | +OpenClaw    |
| `bms/`           | 楼宇、能源管理     | Core               | Autonomous   |
| `fleet/`         | 车队、物流         | Core → Intelligent | Autonomous   |

**没有 Pack 也可以运行**（用核心默认的 Equipment/Alarm/WorkOrder/Station），客户用自己的 ObjectType YAML 描述业务对象。

---

## 五、部署配置 × 客户规模

### 5.1 单站点轻量部署（Edge）

```yaml
# 适合: 小型工厂、偏远场站、网络受限
CLAWTWIN_CAPABILITIES: "ingest,feishu"
# -ai,-playbook,-pgvector（用 Ollama 本地推理可选开 ai）
CLAWTWIN_DB: "sqlite:///./clawtwin.db"
CLAWTWIN_AI_PROVIDER: "ollama" # 可选：本地 LLM
```

- **特点**：单机 Docker，无需外网，断网可用
- **SKU 建议**：Core 或 Intelligent（Ollama 本地 AI）

### 5.2 标准企业部署

```yaml
# 适合: 中型企业、多设备、有 IT 支持
CLAWTWIN_CAPABILITIES: "+ai,+playbook,+kb,+feishu,+outcome_tracking"
CLAWTWIN_DB: "postgresql://..."
CLAWTWIN_AI_PROVIDER: "openai" # 或 anthropic
```

- **特点**：Postgres + 完整能力，单服务器或小 K8s
- **SKU 建议**：Intelligent 或 Autonomous

### 5.3 大型企业多站点部署

```yaml
# 适合: 集团企业、多工厂、集中管控
# 多个 ClawTwin 实例（每站点一个）+ 集中监控
# M6 规划: 多站点联邦架构
```

- **特点**：每站点独立实例，集中审计和 KB 共享（M6）
- **SKU 建议**：Autonomous + OpenClaw（集中 AI 大脑）

---

## 六、典型销售路径（5 步递进）

```
Step 1 — 数据连接（2 周）
  ├── 交付：OPC-UA 接入 + 设备台账数字化
  ├── 能力：ingest + equipment + alarm
  └── 价值证明：实时数据可见，不再手工记录

Step 2 — 智能告警（4 周）
  ├── 交付：告警规则配置 + 飞书推送 + 工单自动创建
  ├── 能力：+feishu + workorder
  └── 价值证明：告警响应时间缩短 40%

Step 3 — AI 辅助（6-8 周）
  ├── 交付：AI 诊断函数 + CBR 推荐 + KB 初始化（50 条案例）
  ├── 能力：+ai + kb + recommendations
  └── 价值证明：工程师诊断时间从 2 小时→30 分钟

Step 4 — 工作流自动化（3-4 个月）
  ├── 交付：Playbook 编排 + HITL 审批 + OutcomeEvent 飞轮
  ├── 能力：+playbook + outcome_tracking + pgvector
  └── 价值证明：80% 常规告警自动处理，工程师处理异常情况

Step 5 — 全智能运营（6-12 个月）
  ├── 交付：OpenClaw 集成 + 自然语言操控 + ERP/MES 对接
  ├── 能力：+MCP + +AgentRuntime + ERP Connector
  └── 价值证明：运营决策 L3-L4 自治，ROI 可量化
```

**关键原则**：每一步都有**独立的可量化价值**，客户可以在任何步骤停下来，不需要一次买完整套。

---

## 七、定价维度建议（框架，非最终）

| 计费维度             | SKU          | 说明                               |
| -------------------- | ------------ | ---------------------------------- |
| 站点许可（/月或/年） | 所有         | 按部署实例数                       |
| 设备数（可选分级）   | Core+        | 管理 <100 / <500 / 无限            |
| AI Token 用量        | Intelligent+ | 透传客户 AI provider 成本 + 服务费 |
| Pack 许可            | 按 Pack      | 行业 Pack 单独计费（或捆绑）       |
| 实施服务             | 按项目       | 本体配置 / 数据接入 / 培训         |

**AI Token 透传策略**：客户自带 OpenAI/Anthropic key，ClawTwin 不赚 token 差价，赚平台价值。这与 Palantir AIP 的"客户自带 LLM"策略一致，降低客户对 AI 成本的抵触。

---

## 八、竞争定位总结

| 对比维度 | 传统 SCADA 厂商 | Palantir AIP | ClawTwin                    |
| -------- | --------------- | ------------ | --------------------------- |
| 部署     | 本地，封闭      | 云优先，复杂 | 单机 Docker，5 分钟启动     |
| 定制难度 | 需厂商开发      | 专有 SDK     | Python + YAML，任何开发者   |
| AI 层    | 无或弱          | 强但价格极高 | 开放 provider，客户自带 key |
| 飞轮学习 | 无              | 无           | ✅ OutcomeEvent 持续优化    |
| 最小可用 | 需全套实施      | 需企业合同   | Core SKU 2 周 POC           |
| 开放扩展 | 闭源            | 专有         | Pack = 任何行业             |

---

_本文档指导产品打包与销售策略，不影响代码架构。Capability 实现见 `infra/capabilities.py`。_
