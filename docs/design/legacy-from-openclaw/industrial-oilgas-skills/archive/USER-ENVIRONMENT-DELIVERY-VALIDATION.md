# ClawTwin 用户环境与交付校验

> **版本**：v1.1 · 2026-05-11  
> **目的**：以**用户真实环境（飞书 + OpenClaw/HiAgent + IMS）**反推架构，验证 Foundry 设计能正确交付  
> **地位**：交付层最高权威。与 `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`（架构层）和 `TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md`（选型层）并列三大权威文档

> ★ **配套权威文档**：
>
> - **架构层**：`INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`（Foundry / Ontology / 7 层架构）
> - **交付层**（本文）：`USER-ENVIRONMENT-DELIVERY-VALIDATION.md`
> - **选型层**：`TECH-STACK-RATIONALIZATION-AND-VALUE-AUDIT.md`（buy/borrow/build 三问）
> - **总入口**：`DESIGN-FINAL-MASTER-INDEX.md`

---

## 一、用户真实环境画像

```
客户（油气管输公司、化工厂、电厂、矿山等工业用户）

┌────────────────────────────────────────────────────────────────────┐
│ 客户已经拥有的（不要替代，要协同）                                   │
│                                                                    │
│ ① 飞书（Feishu Lark）                                              │
│    · 全员日常沟通工具                                                │
│    · 已有大量群、机器人、工作流                                      │
│    · 客户希望 AI 通过飞书"长在身边"，不要再装一个新 App              │
│                                                                    │
│ ② AI Agent 平台（OpenClaw 或 HiAgent，二选一或并存）                │
│    · OpenClaw：开源、自托管、技术控/中小客户偏好                     │
│    · HiAgent：火山引擎企业 AI 平台、SaaS、大型企业偏好               │
│    · 用户已配置好飞书 Bot、Plugin/Skill、知识库等                    │
│                                                                    │
│ ③ IMS（Information Management System）—— 客户已有信息系统群         │
│    · ERP（SAP/Oracle/用友/金蝶）                                    │
│    · CMMS（设备维护：Maximo/SAP-PM/MainSaver）                      │
│    · MES（制造执行）                                                │
│    · SCADA/DCS（工艺控制：Honeywell/Emerson/和利时）                │
│    · PI 历史库（OSIsoft / 浪潮 / 东方国信）                         │
│    · HSE / ESG 系统                                                 │
│    · 各类自研的 Excel / Web 表单                                    │
│                                                                    │
│ ④ OT 现场（数据采集层）                                             │
│    · OPC-UA 服务器（设备厂商提供）                                   │
│    · Modbus / DNP3 / IEC-104 等老协议                              │
│    · 视频监控、巡检手持终端                                          │
│                                                                    │
│ ⑤ 网络与权限                                                        │
│    · OT 区 / IT 区 / DMZ / 公网 四层网络分区                        │
│    · 强企业身份系统（AD / LDAP / 飞书企业账号）                     │
└────────────────────────────────────────────────────────────────────┘

客户为什么买 ClawTwin（业务价值，不要混淆）：
  ❌ 不是买 AI Agent（已有 OpenClaw/HiAgent）
  ❌ 不是买 ERP（已有 IMS）
  ❌ 不是买 IM（已有飞书）
  ❌ 不是买 SCADA（已有 OT 系统）
  ❌ 不是买 BI（已有 Tableau / Grafana / 帆软）

  ✅ 买的是【工业语义层 + 智能装配能力】：
     · 把 IMS 数据语义化（让 AI 理解什么是"压缩机轴温异常"）
     · 把 OT 实时数据汇聚为 Object 状态（让 AI 看到全局）
     · 把工业知识结构化（让 AI 引用而非编造）
     · 把多个 Agent 平台桥接到统一 Foundry（让 AI 能力可演进）
     · 把审批/工单/巡检/班次流程跑在飞书里（让一线员工真用起来）
     · 沉淀工业本体资产（设备模型、流程模型、知识库），随时间增值
```

---

## 二、ClawTwin 在用户环境中的位置（终极定位图）

```
                    [客户员工的飞书]                        [客户管理层 / 工程师]
                       │                                       │
                       │ 对话/卡片/审批                         │ 浏览/分析/配置
                       ▼                                       ▼
         ┌──────────────────────────────┐         ┌─────────────────────────┐
         │  AI Agent Runtime（任选）     │         │  ClawTwin Studio        │
         │  · OpenClaw（自托管）        │         │  （Workshop 风格 Web）   │
         │  · HiAgent（SaaS/私有化）    │         │  · 70% Object 自动生成   │
         │  · Dify / Coze / 其他       │         │  · 30% 自定义 App        │
         │  ↑ 通过 MCP 或 OpenAPI 调用  │         └────────────┬─────────────┘
         └────────────┬─────────────────┘                      │
                      │                                        │
                      ▼                                        ▼
            ┌────────────────────────────────────────────────────────────┐
            │ ★ ClawTwin Industrial Foundry（我们交付的核心）             │
            │                                                            │
            │  AIP Layer（AgentRuntime 抽象 + MCP/OpenAPI 双协议暴露）    │
            │  ──────────────────────────────────────────────────────   │
            │  Industrial Ontology（Object/Action/Function/Pipeline）    │
            │  ──────────────────────────────────────────────────────   │
            │  Apps Layer（Studio/Feishu Cards/CLI/Mobile）              │
            │  ──────────────────────────────────────────────────────   │
            │  Pipeline Layer（IMS/OT/KB Connector，声明式接入）          │
            │  ──────────────────────────────────────────────────────   │
            │  Foundation（PostgreSQL+TimescaleDB+pgvector / Redis）      │
            └─────────────────────┬──────────────────────────────────────┘
                                  │
            ┌─────────────────────┼──────────────────────┐
            │                     │                      │
            ▼                     ▼                      ▼
    ┌─────────────┐       ┌──────────────┐      ┌──────────────┐
    │ 客户 IMS    │       │ 客户 OT      │      │ 客户 KB 资产 │
    │ SAP/Oracle/ │       │ OPC-UA/PI/  │      │ 标准/规程/   │
    │ 用友/Maximo │       │ Modbus       │      │ 历史工单/手册│
    └─────────────┘       └──────────────┘      └──────────────┘

                      [飞书企业账号 / 客户 AD]
                                ↕ SSO
                      [ClawTwin 身份与 Marking]
```

**核心理解**：

- **入口**：员工在飞书；管理者在 Studio Web
- **大脑**：客户已有的 OpenClaw / HiAgent（AI 推理）
- **能力库**：ClawTwin Foundry（提供 Object/Action/Function 给 Agent 调用）
- **数据源**：客户的 IMS + OT + KB
- **沉淀物**：Industrial Ontology（设备本体、流程本体、知识本体）

---

## 三、AgentRuntime 抽象（让 OpenClaw / HiAgent 可切换）

### 3.1 不同 Agent 平台的接入差异

| 维度             | OpenClaw                   | HiAgent                      | Dify                   | Coze          |
| ---------------- | -------------------------- | ---------------------------- | ---------------------- | ------------- |
| **协议**         | MCP (stdio/HTTP/SSE)       | OpenAPI 插件 + 工具描述 JSON | 自定义 Plugin Manifest | 自定义 Plugin |
| **鉴权**         | Service Token              | API Key + RBAC               | Bearer + Workspace     | OAuth 2.0     |
| **工具描述**     | MCP `tools/list`           | OpenAPI 3.0 + 自定义 schema  | Manifest YAML          | Manifest YAML |
| **流式响应**     | SSE / WebSocket            | SSE                          | SSE                    | SSE           |
| **飞书集成**     | 内置 Feishu Channel        | 火山引擎飞书企业版打通       | 通过插件               | 通过插件      |
| **部署位置**     | 客户内网（最常见）         | 火山云 SaaS / 私有化         | 客户内网 / SaaS        | 字节云 SaaS   |
| **典型客户画像** | 中小工业、技术控、安全敏感 | 大型央企、与字节有合作       | 中小创新公司           | 互联网+       |

**关键洞察**：协议不一样，但**它们要的都是"工具列表 + 工具调用"**。所以 ClawTwin 只需在 AIP Layer 增加 AgentRuntime 抽象。

### 3.2 AgentRuntime 抽象层设计

```python
# aip/agent_runtimes/_base.py
class AgentRuntime(Protocol):
    """统一的 Agent 平台适配接口。"""

    name: str                                           # "openclaw" / "hiagent" / ...

    def export_tool_descriptors(self, tools: list[ToolSpec]) -> dict:
        """
        把 Foundry 自动生成的 ToolSpec 转换为该平台所需的 schema。
        OpenClaw  → MCP tools/list JSON
        HiAgent   → 火山引擎插件 OpenAPI Spec
        Dify      → Dify Plugin Manifest YAML
        """

    def authenticate_request(self, headers: dict) -> AgentActor:
        """
        把 Agent 平台的鉴权信息解析为 Foundry Actor。
        OpenClaw  → Service Token → 找出对应的 organization + station_ids
        HiAgent   → API Key → 同上
        """

    def stream_response(self, result: ActionResult | FunctionResult) -> AsyncIterator[bytes]:
        """
        把 Foundry 的执行结果按该平台所需的流式格式发送。
        """
```

### 3.3 双协议暴露（MCP + OpenAPI）

ClawTwin AIP Layer 同时暴露两套协议（同一个 Ontology，两种协议视图）：

```
                  ┌─────────────────────────────────────┐
                  │  ClawTwin AIP Layer                  │
                  │                                      │
   OpenClaw ────► │  /mcp                                │
                  │  (FastMCP，stdio/HTTP/SSE)          │
                  │                                      │
   HiAgent  ────► │  /v1/openapi                         │
                  │  (FastAPI 自动 OpenAPI 3.0 + 火山自定义扩展) │
                  │                                      │
   Dify     ────► │  /v1/openapi  (自动兼容)             │
   Coze     ────► │  /v1/openapi                         │
                  │                                      │
   Custom   ────► │  /v1/grpc (Phase B+)                │
                  └────────────┬─────────────────────────┘
                               │
                               ▼
                  ┌─────────────────────────────────────┐
                  │  Industrial Ontology（同一个 Source）  │
                  └─────────────────────────────────────┘
```

**实现要点**：

1. `aip/mcp_server.py`：FastMCP 实例，启动时遍历 ONTOLOGY 注册所有 Object/Action/Function
2. `aip/openapi_exporter.py`：FastAPI 自动生成 OpenAPI Spec，加上 HiAgent / Dify 各自的扩展字段
3. `aip/agent_runtimes/openclaw.py` / `hiagent.py` / `dify.py`：每个平台一个适配器
4. **CLI 一键导出**：`clawtwin agent export --runtime=hiagent > hiagent_plugin.json`

### 3.4 客户切换 Agent 平台时发生什么

```
T0：客户用 OpenClaw
    Foundry 暴露 MCP；OpenClaw Skill 调用工具；员工在飞书对话

T1：客户决定换 HiAgent
    1. 客户在 HiAgent 控制台创建新的 Agent
    2. 在 ClawTwin Studio 点击"导出 HiAgent 插件" → 下载 OpenAPI Spec
    3. 在 HiAgent 导入插件 → 配置 API Key（ClawTwin 生成的 Service Token）
    4. HiAgent Agent 自动获得所有 Object/Action/Function 调用能力
    5. 切换飞书 Bot 的后端（OpenClaw → HiAgent）
    6. 业务无感知

关键：Ontology 没动，只是换了"大脑"，"能力库"还是一套。
这就是 Foundry 价值——能力沉淀在 Foundry，Agent 平台可换。
```

### 3.5 多 Agent 并存的支持

实际客户场景：

- 一线员工用飞书 + OpenClaw（中文、轻量）
- 高管用 PC Studio + HiAgent（深度分析、跨业务）
- 程序员用 Cursor + ClawTwin MCP（开发用）

**所有这些 Agent 都调同一套 Foundry Ontology**，无需重复实现工具。

---

## 四、IMS Connector 抽象（客户已有信息系统接入标准）

### 4.1 IMS 接入的真实复杂度

不同客户 IMS 的差异极大：

```
客户 A（央企油气）：
  · SAP PM 模块（设备维护工单）
  · OSIsoft PI（历史时序）
  · 自研 HSE 系统（HTTP REST）
  · 飞书审批

客户 B（化工厂）：
  · 用友 ERP（U8 NC）
  · Maximo（CMMS）
  · Honeywell PHD 历史库
  · 钉钉审批

客户 C（民营管输）：
  · 金蝶云（生产管理）
  · 自研 Excel + 邮件
  · 第三方 SCADA 数据接口
  · 飞书审批
```

**结论**：不能为每个客户写定制代码，必须有 **Connector 抽象 + 配置驱动**。

### 4.2 IMS Connector 抽象设计

```yaml
# pipelines/connectors/sap_pm_workorder.yaml
connector:
  name: sap_pm_workorder_sync
  display_name: SAP PM 工单同步
  vendor: sap
  product: pm

  source:
    protocol: rest # rest | soap | jdbc | odata | file | sftp
    endpoint: ${SAP_PM_BASE_URL}/sap/opu/odata/sap/PM_WORKORDER_SRV
    auth:
      type: oauth2_client_credentials
      token_url: ${SAP_OAUTH_URL}
      client_id_secret_ref: vault://sap/clawtwin/client_id
      client_secret_secret_ref: vault://sap/clawtwin/client_secret
    pagination:
      type: odata
      page_size: 200

  schedule:
    type: cron
    expr: "*/15 * * * *" # 每 15 分钟拉一次
    catchup: false

  field_mapping:
    # SAP 字段 → Foundry Object 属性
    AUFNR: external_id
    QMNUM: external_quality_id
    PRIOK: priority # 同时做枚举映射（见下）
    KTEXT: title
    LTRMI: planned_start
    LTRMA: planned_end
    EQUNR: equipment.external_id # 通过 Link 关联到 Equipment

  enum_mapping:
    priority:
      "1": P1
      "2": P2
      "3": P3
      "4": P4
    work_type:
      "PM01": preventive
      "PM02": corrective
      "PM03": inspection

  destination:
    object_type: WorkOrder
    upsert_key: external_id # 幂等
    on_conflict: merge_remote_wins # source_of_truth=external 时
    set_constants:
      source_system: sap_pm
      source_of_truth: external # 见 §4.4

  write_back: # ★ 双向同步，Foundry 创建/更新时反向写 SAP
    enabled: true
    on_actions: [CreateWorkOrder, ApproveWorkOrder, CompleteWorkOrder]
    endpoint: ${SAP_PM_BASE_URL}/sap/opu/odata/sap/PM_WORKORDER_SRV
    field_mapping_inverse: derive_from_field_mapping

  lineage:
    upstream: [sap_pm_system]
    downstream: [WorkOrder Object]

  observability:
    metrics: [pull_count, push_count, error_count, latency_ms]
    alerts:
      - condition: error_rate > 0.05 over 1h
        notify: ops_team
```

### 4.3 标准 Connector 包（开箱即用）

```
connectors/
├── erp/
│   ├── sap_s4hana/                      # SAP S/4HANA
│   ├── sap_ecc/                         # SAP ECC（旧版）
│   ├── sap_pm/                          # SAP PM 模块（设备维护）
│   ├── oracle_eam/                      # Oracle EAM
│   ├── yonyou_u8/                       # 用友 U8
│   ├── yonyou_nc/                       # 用友 NC
│   └── kingdee_cloud/                   # 金蝶云
│
├── cmms/
│   ├── ibm_maximo/
│   ├── infor_eam/
│   └── mainsaver/
│
├── historian/
│   ├── osisoft_pi/                      # OSIsoft PI Historian
│   ├── inmation/
│   ├── honeywell_phd/
│   └── ge_proficy/
│
├── scada_dcs/
│   ├── opcua_generic/                   # 标准 OPC-UA（asyncua）
│   ├── modbus_tcp/                      # Modbus TCP
│   ├── iec104/                          # IEC-60870-5-104
│   └── honeywell_experion/
│
├── hse/
│   ├── intelex/
│   ├── enablon/
│   └── custom_rest/                     # 自研 HSE 通用模板
│
└── generic/
    ├── rest_api/                        # 通用 REST 拉取/推送
    ├── soap/                            # SOAP/WSDL
    ├── csv_sftp/                        # 定时拉取 CSV/Excel
    ├── webhook_inbound/                 # 接收外部 Webhook
    └── jdbc_query/                      # 直连数据库
```

**每个 Connector 包**：

- 一个 `connector.yaml`（声明式配置）
- 一份 `field_mapping_template.yaml`（字段映射模板，客户调整）
- 一段 `transformer.py`（特殊转换逻辑，可选）
- 一份 `README.md`（部署指南、字段对照表）
- 一份 `tests/`（mock 数据 + 集成测试）

### 4.4 Source-of-Truth 策略（避免数据冲突的关键）

每个 Object Type 必须明确**谁是真理**：

```yaml
# ontology/object_types/work_order.yaml 加字段：
source_of_truth_strategy:
  default: external # 该客户 IMS 是 SAP PM
  options:
    - foundry: ClawTwin 是 SoT，Connector 单向输出
    - external: IMS 是 SoT，Connector 双向（拉为主，推回少量字段）
    - hybrid: 按字段分（基本信息归 IMS，AI 增强字段归 Foundry）

  field_ownership: # hybrid 模式细化
    title: external
    description: external
    state: hybrid_workflow # FSM 在 Foundry，但完成后写回 IMS
    ai_diagnose_summary: foundry # AI 增强字段
    ai_recommended_actions: foundry
    citations: foundry
```

**Action 执行时框架自动检查**：

- `CreateWorkOrder` → 如果 SoT=external，先调 IMS 创建，拿到 external_id 再写 Foundry
- `CompleteWorkOrder` → 同时更新 Foundry + 反向写 SAP（如果 write_back.enabled=true）
- 失败时自动回滚或入死信队列

### 4.5 客户对接 IMS 的标准流程（销售/实施动作）

```
Phase 0：售前 Discovery（1 天）
  · 用 ClawTwin Studio 的 Connector 探针：clawtwin connector probe --target=sap-pm-url
  · 自动识别 SAP 版本、模块、可用实体、记录数
  · 输出客户 IMS 拓扑图

Phase 1：选 Connector + 配置字段映射（2-3 天）
  · 从 connectors/ 仓库挑选匹配 Connector（80% 客户用现成的）
  · Studio 提供"字段映射可视化编辑器"（左 IMS 字段，右 Foundry Object 字段）
  · 自动生成 connector.yaml

Phase 2：试运行 + 数据校验（2-3 天）
  · clawtwin connector run --dry-run（不真写库）
  · 输出"对账报告"（IMS 100 条，成功映射 95 条，缺字段 3 条，类型不匹配 2 条）
  · 人工修正 → 真跑 → 数据进 Foundry

Phase 3：上线 + 双向同步（1 天）
  · 启用 write_back
  · 设置告警：连接断、错误率高、延迟大
  · 完成

20% 客户的"IMS 太奇葩"场景：
  · 用 generic/rest_api + custom transformer.py
  · 实施工程师可以 1 周内为客户写定制 Connector
  · 但写完仍按标准 Connector 包格式纳入仓库（沉淀为新模板）
```

---

## 五、飞书集成的最终架构（兼容多 Agent 平台）

### 5.1 飞书消息流向（决定性图）

```
飞书企业账号
    │
    ├─【对话消息（员工 @AI 在群里问）】
    │       │
    │       ▼
    │   AgentRuntime（OpenClaw / HiAgent / Dify 任一）
    │       │ 通过 MCP 或 OpenAPI 调用
    │       ▼
    │   ClawTwin Foundry（Ontology Action/Function）
    │       │
    │       ▼
    │   返回结构化结果 → AgentRuntime 组装回复 → 飞书消息卡片
    │
    │
    ├─【主动推送（Foundry 发起）】
    │       │
    │       ▼
    │   ClawTwin Apps Layer
    │       │ providers/notifier/feishu.py（lark-oapi）
    │       ▼
    │   飞书机器人发送卡片（告警/晨报/工单待办/审批通知）
    │
    │
    ├─【卡片回调（员工点击卡片按钮）】
    │       │
    │       ▼
    │   ClawTwin Apps Layer /v1/feishu/callback
    │       │ 验签 + 解析 action
    │       ▼
    │   ActionExecutor.execute("AcknowledgeAlarm", ..., transport="feishu_card")
    │
    │
    └─【表单填报（员工在飞书填巡检/生产数据）】
            │
            ▼
        飞书卡片表单 → 同样走 callback → ActionExecutor
```

**关键决策（不变）**：

- ✅ 对话消息**直接进 AgentRuntime**，不绕道 Foundry
- ✅ 卡片回调和主动推送**才进 Foundry**
- ✅ AgentRuntime 通过 Foundry 的 MCP/OpenAPI 拿数据/做操作
- ❌ Foundry 不实现自己的"对话理解"层

### 5.2 飞书 + AgentRuntime 切换示例

| 客户配置          | 飞书 Bot 后端                 | AgentRuntime            | Foundry 暴露  |
| ----------------- | ----------------------------- | ----------------------- | ------------- |
| 央企/技术控       | OpenClaw Feishu Channel       | OpenClaw                | MCP           |
| 字节生态/大型企业 | 飞书企业版 + HiAgent Bot      | HiAgent                 | OpenAPI       |
| 多元化/试验中     | 主用 OpenClaw，HiAgent 高管用 | OpenClaw + HiAgent 并存 | MCP + OpenAPI |
| 小型 PoC          | Dify 飞书插件                 | Dify                    | OpenAPI       |

**Foundry 不需要为每种场景写新代码**，只需要确保 MCP + OpenAPI 都正确暴露 Ontology。

### 5.3 飞书企业身份与 Foundry Marking 打通

```
飞书企业账号
  user.id = "ou_xxx"
  user.department = "运行维护部"
  user.feishu_groups = ["G_S001_op", "G_HSE", ...]
       │
       ▼
ClawTwin Identity Bridge（infra/auth/feishu_bridge.py）
  · 拉取飞书部门 → 映射 organization + station_ids
  · 拉取飞书群 → 映射 channel access
  · 飞书 OAuth → ClawTwin JWT
       │
       ▼
ClawTwin Marking Engine
  · station_marking = ["S001"]（来自部门映射）
  · zone_marking = ["IT"]（默认；OT 区单独申请）
  · sensitivity_marking = ["internal"]
       │
       ▼
ObjectStore.search(...) 自动加 WHERE station_id IN ('S001')
```

---

## 六、部署模型（让客户安心的关键）

### 6.1 三种部署形态

| 形态                     | 适用客户           | ClawTwin 位置               | 数据安全            | 运维成本                    |
| ------------------------ | ------------------ | --------------------------- | ------------------- | --------------------------- |
| **A. 客户内网私有化**    | 央企、能化、军工   | 客户机房（与 IMS 同网络段） | 数据完全不出网      | 客户 IT 支持 + 我们远程协助 |
| **B. 客户专属云（VPC）** | 中型企业、想要弹性 | 阿里云/华为云客户 VPC       | VPC 隔离 + 审计日志 | 我们托管，客户付云费        |
| **C. SaaS 多租户**       | 中小企业、PoC      | 我们的云                    | 行级隔离 + Marking  | 完全托管                    |

> **★ 默认推荐 A**：油气/化工/能源工业客户对 OT/IMS 数据敏感，绝大多数选 A。

### 6.2 客户内网部署的网络拓扑（默认形态）

```
                                        [飞书云]
                                            ▲
                                            │ wss://（出网通道）
                                            │
┌───────────────────────────────────────────┴────────────────────────────┐
│ 客户企业网络                                                            │
│                                                                        │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │ DMZ                                                            │   │
│  │  · 飞书 Bot 出网代理（lark-oapi 长连接）                        │   │
│  │  · OpenClaw Gateway（如选 OpenClaw）                            │   │
│  │  · OPC-UA Bridge（DMZ 侧，单向 OT → Redis Streams）             │   │
│  └─────────────────────────┬──────────────────────────────────────┘   │
│                            │ (所有进出网络流量集中在 DMZ)                │
│  ┌─────────────────────────┴──────────────────────────────────────┐   │
│  │ IT 区（核心区）                                                  │   │
│  │                                                                │   │
│  │  ┌──────────────────────────────────────────────────────┐    │   │
│  │  │ ClawTwin Foundry                                     │    │   │
│  │  │  · platform-api (FastAPI + Apps + AIP)               │    │   │
│  │  │  · workers (Pipeline + Scheduler)                     │    │   │
│  │  │  · postgres (TimescaleDB + pgvector)                 │    │   │
│  │  │  · redis                                             │    │   │
│  │  │  · vllm (LLM 推理，可选 GPU)                         │    │   │
│  │  │  · openclaw（如自托管）                              │    │   │
│  │  └──────────────────────────────────────────────────────┘    │   │
│  │                          │                                    │   │
│  │                          ▼ HTTPS / 数据库直连                  │   │
│  │  ┌──────────────────────────────────────────────────────┐    │   │
│  │  │ 客户 IMS（原有系统）                                   │    │   │
│  │  │  SAP / Oracle / 用友 / Maximo / OSIsoft PI            │    │   │
│  │  └──────────────────────────────────────────────────────┘    │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                            ▲                                          │
│                            │ 单向（OT → IT）                          │
│  ┌─────────────────────────┴──────────────────────────────────────┐   │
│  │ OT 区（工艺控制网）                                             │   │
│  │  SCADA / DCS / PLC / OPC-UA Server                             │   │
│  │  ★ 不允许从 IT 区主动连入                                       │   │
│  └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘

★ 核心安全原则：
  · 飞书是唯一允许出网的服务（且只 wss://，签名验证）
  · OT 区单向输出到 IT（OPC-UA Bridge 在 DMZ）
  · IMS 与 Foundry 同网络段，加密直连
  · 所有服务 GPU/CPU/磁盘都在客户机房
```

### 6.3 SaaS 形态的差异（小客户/PoC）

```
[客户飞书] → [HiAgent 火山云] → [HiAgent 调 ClawTwin SaaS REST API]
                                       │
                                       ▼
                                 [ClawTwin SaaS 多租户]
                                       │
                                       ▼ 通过反向通道
                                 [客户 IMS 拉数据]

适用：
  · 客户 IMS 提供公网 REST 接口
  · 数据敏感度低（不含核心工艺参数）
  · PoC 阶段、3 个月内决定是否私有化

不适用：
  · OT 实时数据（OPC-UA 不能上公网）
  · 高敏感工艺参数（央企禁止）
```

---

## 七、对当前 Foundry 架构的优化点（基于本次审视）

### 7.1 必须新增的能力

| 能力                   | 当前状态                    | 必须补充                                            | 落地位置                                |
| ---------------------- | --------------------------- | --------------------------------------------------- | --------------------------------------- |
| AgentRuntime 抽象      | 只有 OpenClaw 的 MCP        | 加 HiAgent / Dify / Coze 适配器                     | `aip/agent_runtimes/`                   |
| OpenAPI 自动导出       | FastAPI 默认 OpenAPI        | 加 HiAgent / Dify 扩展字段                          | `aip/openapi_exporter.py`               |
| IMS Connector 抽象     | Pipeline 只举了 OPC-UA 例子 | 完整的 Connector 包结构                             | `connectors/` 目录 + Pipeline YAML 扩展 |
| Source-of-Truth 策略   | 没明确                      | Object Type YAML 加 `source_of_truth_strategy` 字段 | Object Type schema 扩展                 |
| 双向同步（write_back） | Pipeline 默认单向           | Connector YAML 加 `write_back` 段                   | Pipeline YAML 扩展                      |
| 飞书企业身份桥         | 已有 Marking 设计           | 加 Feishu OAuth + 部门映射                          | `infra/auth/feishu_bridge.py`           |
| Connector 探针         | 没有                        | 售前用：自动识别客户 IMS                            | `cli/connector.py probe`                |
| 字段映射可视化         | 没有                        | Studio Workshop 应用                                | Studio Custom Page                      |
| 部署形态切换           | 当前默认私有化              | 配置开关：A/B/C 形态                                | `infra/settings.py` + Helm chart        |

### 7.2 可以裁剪的设计

| 设计                     | 现状                   | 调整                                               |
| ------------------------ | ---------------------- | -------------------------------------------------- |
| ClawTwin Mobile 独立 App | 计划 Phase B 做        | 改为"飞书小程序 + 飞书卡片"足够（不开发独立 App）  |
| 自建对话理解层           | 已废弃但需重申         | 再次强调：对话理解归 AgentRuntime，Foundry 不做    |
| 自建用户系统             | 当前有完整 User Object | 与 AD/飞书企业账号 SSO，不维护独立密码             |
| 自建审批流程引擎         | ApprovalQueue 设计     | 简化：审批 = 飞书审批 / IMS 审批的桥接，不重新发明 |

### 7.3 优化后的 Foundry 顶层架构（更新版）

```
┌────────────────────────────────────────────────────────────────────────┐
│ Apps Layer                                                              │
│  · Studio Web（Workshop 风格，浏览器）                                   │
│  · Feishu Apps：消息卡片 / 飞书审批 / 飞书表单 / 飞书小程序（可选）       │
│  · CLI（运维、自动化、Cursor 集成）                                      │
│  · 嵌入式：Grafana Dashboard / IMS 内嵌 Web                             │
└────────────────────────────┬───────────────────────────────────────────┘
                             │
┌────────────────────────────┴───────────────────────────────────────────┐
│ AIP Layer（可对接任意 Agent 平台）                                        │
│  · MCP Server                       ← OpenClaw / Cursor / Claude Code   │
│  · OpenAPI Exporter                 ← HiAgent / Dify / Coze / 自定义    │
│  · gRPC（Phase B+）                                                     │
│  · AgentRuntime Adapters（统一鉴权 + 工具描述 + 流式响应）                │
│  · LLM Trace + Eval                                                    │
│  · Provider 抽象（vLLM / 通义 / 文心 / Claude / DeepSeek）              │
└────────────────────────────┬───────────────────────────────────────────┘
                             │
┌────────────────────────────┴───────────────────────────────────────────┐
│ ★ Industrial Ontology Layer（核心）                                      │
│  · Object Types / Link Types                                           │
│  · Action Types（含 Source-of-Truth + Write-back 策略）                 │
│  · Function Types                                                       │
│  · Markings（含飞书部门 / IMS 角色 / 站场分区）                         │
└────────────────────────────┬───────────────────────────────────────────┘
                             │
┌────────────────────────────┴───────────────────────────────────────────┐
│ Core 实现层                                                              │
│  · ObjectStore / ActionExecutor / FunctionExecutor / PipelineRunner     │
│  · DomainLogic (FSM 等复杂规则)                                         │
└────────────────────────────┬───────────────────────────────────────────┘
                             │
┌────────────────────────────┴───────────────────────────────────────────┐
│ Pipeline Layer + Connector Suite                                        │
│  · IMS Connectors：SAP / Oracle / 用友 / Maximo / OSIsoft PI / ...      │
│  · OT Connectors：OPC-UA / Modbus / IEC-104 / Honeywell                 │
│  · KB Pipelines：PDF / Workorder Flywheel                              │
│  · ML Pipelines：MOIRAI 训练（Phase B+）                                │
│  · 通用：REST / SOAP / JDBC / SFTP / Webhook                           │
└────────────────────────────┬───────────────────────────────────────────┘
                             │
┌────────────────────────────┴───────────────────────────────────────────┐
│ Foundation                                                              │
│  · PostgreSQL（含 TimescaleDB + pgvector）                              │
│  · Redis                                                                │
│  · Object Storage (Phase B+)                                            │
└────────────────────────────────────────────────────────────────────────┘

★ 横切：
  Auth + Feishu Bridge + Marking | Approval | Audit | LLM Trace | Lineage
```

---

## 八、新增铁律

```
【铁律 30】AgentRuntime 必须抽象，不写死任何 Agent 平台
  支持 OpenClaw / HiAgent / Dify / Coze 等任意平台
  Foundry 暴露 MCP + OpenAPI 双协议；Agent 平台适配器各自处理鉴权与流式
  禁止：在 ActionExecutor / FunctionExecutor 里区分 Agent 平台
  禁止：硬编码 OpenClaw / HiAgent 的特殊行为
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §三

【铁律 31】IMS 接入必须用 Connector 抽象（声明式 YAML + 标准包结构）
  禁止：为某客户 IMS 写一次性脚本（必须沉淀为 Connector 包）
  禁止：在 Foundry 业务代码里 import sap_sdk / oracle_sdk
  20% 奇葩 IMS 用 generic/rest_api + 自定义 transformer.py，仍按 Connector 包格式提交
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §四

【铁律 32】每个 Object Type 必须明确 Source-of-Truth 策略
  options: foundry | external | hybrid
  external 时 Action 自动双向同步（先写 IMS 再写 Foundry，失败回滚）
  hybrid 时按 field_ownership 字段级控制
  Action.execute() 框架自动处理，业务 handler 不感知
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §四.4

【铁律 33】飞书是出网通道，不是数据源
  飞书消息直进 AgentRuntime（不进 Foundry）
  飞书卡片回调进 Foundry Apps Layer（处理 Action）
  飞书企业身份通过 SSO + Feishu Bridge → Foundry Marking
  禁止：在 Foundry 维护独立的飞书消息历史（飞书自己已存）
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §五

【铁律 34】客户内网私有化是默认部署形态
  飞书是唯一允许出网的服务（wss + 签名）
  OT 区单向输出到 IT（OPC-UA Bridge 在 DMZ）
  IMS 与 Foundry 同网络段，加密直连
  SaaS 形态仅适用于 PoC 或低敏感数据客户
  参见：USER-ENVIRONMENT-DELIVERY-VALIDATION.md §六
```

---

## 九、业务交付校验（每个客户场景都过一遍）

### 场景 1：央企油气管输公司（OpenClaw + SAP PM + OPC-UA）

```
现场：S001 压缩机 C-001 振动 5.8 mm/s（超过 4.5 报警阈值）

数据流：
  OPC-UA Bridge → Redis Stream
    → opcua_pipeline.yaml 加工为 EquipmentReading Object
    → 阈值规则 → 创建 Alarm Object

  Alarm Object 创建触发 side_effect:
    → providers/notifier/feishu.py 推卡片到飞书 #S001-运维群

飞书群里收到告警卡片：
  [告警] C-001 压缩机振动 5.8 mm/s（阈值 4.5）
  操作员 @张三 在群里：「@OpenClaw 这个告警严重吗？」

对话流：
  飞书 → OpenClaw（已配置 Service Token）
  → MCP 调用 SearchAlarm + GetEquipment + DiagnoseEquipment
  → DiagnoseEquipment 委派回 industrial-assistant Skill
  → Skill 调 SearchKnowledge（查 L1 压缩机手册 + L2 历史工单）
  → LLM 综合给出：「轴承可能开始磨损，建议立即开工单检查，参考 KB-12 第 3.2 节」

张三决策：
  「@OpenClaw 创建工单」
  → OpenClaw MCP 调 CreateWorkOrder Action
  → Foundry 校验：source_of_truth=external (SAP PM)
  → 先调 SAP PM REST 创建工单，拿到 SAP_AUFNR
  → 写入 Foundry WorkOrder Object（external_id=SAP_AUFNR）
  → ApprovalQueue：因为 priority=P1，触发 ApproveWorkOrder Action 待审批
  → 飞书推审批卡片给主管 @李四

主管在飞书点[同意]：
  → 飞书 callback → /v1/feishu/callback
  → ActionExecutor.execute("ApproveWorkOrder", ..., transport="feishu_card")
  → 写 Foundry + 反向写 SAP PM（status=APPROVED）
  → 飞书通知张三：工单已批
  → 张三去现场执行

执行完毕：
  张三在飞书填表 [完成工单]：
  → ActionExecutor.execute("CompleteWorkOrder", evidence_urls=[...])
  → 写 Foundry + 写回 SAP（status=COMPLETED）
  → 触发 knowledge_flywheel Pipeline → 生成 L3 知识 (pending review)
  → 飞书通知 KB Admin 审核新增 L3 知识

★ 校验通过：
  · 飞书全程不出客户域（OpenClaw 私有化在客户内网）
  · SAP PM 是 source_of_truth，工单状态正确同步
  · OT 数据不进飞书消息（只是触发告警）
  · 审批走 Foundry ApprovalQueue + 飞书卡片
  · 知识沉淀为 L3，下次 AI 引用
```

### 场景 2：大型央企化工厂（HiAgent + Maximo + Honeywell PHD）

```
高管在飞书企业版（火山引擎飞书 OEM）问 HiAgent Bot：
  「这个月 8 号管线的输量异常吗？」

对话流：
  飞书企业版 → HiAgent Agent
  → HiAgent 调用 ClawTwin OpenAPI（API Key 鉴权）
  → POST /v1/functions/AnalyzeProductionTrend
  → Foundry FunctionExecutor 调 sql_function 查 ProductionRecord Object
  → 返回结构化结果（异常程度 / 可能原因 / 历史对照）

HiAgent 流式返回到飞书企业版：
  分析显示 11/8 输量比往年同期低 18%，原因可能是 K-2003 压缩机能效下降。
  建议安排专项巡检。[查看详情] [创建工单]

高管点 [创建工单]：
  → HiAgent 调 POST /v1/actions/CreateWorkOrder
  → Foundry source_of_truth=external (Maximo)
  → 先调 Maximo REST 创建 → 写回 Foundry
  → ApprovalQueue → 飞书推卡片给运维主管

★ 校验通过：
  · 同一套 Foundry，不同 Agent 平台（OpenClaw vs HiAgent）
  · 同一个客户的不同部门可用不同 Agent
  · OpenAPI 自动从 Ontology 生成，HiAgent 无需定制开发
```

### 场景 3：中型炼厂（Dify + 用友 NC + 通用 OPC-UA）

```
客户在 Dify 私有化部署 + 用友 ERP + 自建 SCADA。
对接 ClawTwin：
  · ClawTwin Studio 导出 Dify Plugin Manifest
  · Dify 导入 → 自动注册所有 Action / Function 为 Plugin Tool
  · Dify 飞书插件 + Dify 配置 Bot
  · Foundry 配置 connectors/erp/yonyou_nc/ + connectors/scada_dcs/opcua_generic/

业务流同上。

★ 校验通过：
  · Foundry 不区分 Agent 平台
  · Connector 抽象兼容用友 NC（已有标准 Connector）
  · 客户实施 1 周完成 Phase A
```

### 场景 4：小型 PoC 客户（SaaS 形态）

```
客户：500 人化工小厂，OT 不上 ClawTwin，只接 Excel 工单 + 飞书。

部署：
  · ClawTwin SaaS（多租户）
  · 客户 IMS = Excel + 飞书审批
  · Connector：generic/csv_sftp 定时拉 Excel
  · Agent：用我们提供的免费 OpenClaw 试用账号

业务流：
  · 工程师在飞书填飞书审批表 → ClawTwin 通过飞书 OpenAPI 拉表单数据 → 创建 WorkOrder Object
  · 在飞书 @AI 问问题 → 走 OpenClaw → 调 Foundry SaaS API
  · 一切数据在我们 SaaS 里，行级 Marking 隔离

★ 校验通过：
  · Foundry 同一套代码支持 SaaS 多租户
  · Connector 兼容 Excel
  · 客户 0 运维
```

---

## 十、验收标准（Phase A 交付的硬性指标）

```
✅ AgentRuntime 抽象
  - OpenClaw 通过 MCP 全功能可用
  - HiAgent 通过 OpenAPI 全功能可用（至少演示 1 个工具链）
  - 切换 Agent 平台不动 Foundry 代码

✅ Connector 系统
  - 至少 2 种 ERP Connector（SAP PM + 用友 NC 或 Oracle EAM）
  - 至少 1 种 Historian Connector（OSIsoft PI 或 OPC-UA generic）
  - 1 个 generic/rest_api 通用模板
  - 1 个 connector probe CLI 工具

✅ Source-of-Truth + Write-back
  - WorkOrder 完整 external SoT 流程演示
  - Action 失败回滚正常工作
  - 数据冲突有日志和告警

✅ 飞书集成
  - 飞书消息 → AgentRuntime → Foundry MCP/OpenAPI（端到端）
  - 飞书卡片审批回调 → ApprovalQueue → Action 执行
  - 飞书 OAuth + 部门映射 → Marking
  - lark-oapi 主动推送告警/晨报/工单待办

✅ 部署形态
  - 客户内网私有化 docker-compose（默认）
  - SaaS 多租户配置可切换（环境变量）
  - 网络分区文档清晰（OT/IT/DMZ）

✅ 业务校验
  - 4 个真实场景（OpenClaw+SAP / HiAgent+Maximo / Dify+用友 / SaaS+Excel）端到端跑通
  - 每个场景出 demo 录屏 + 数据校验报告
```

---

## 十一、与既有文档的关系

| 文档                                                  | 状态                           | 调整                                                                                 |
| ----------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| **USER-ENVIRONMENT-DELIVERY-VALIDATION.md（本文档）** | **最高权威**，业务交付以此为准 | —                                                                                    |
| INDUSTRIAL-FOUNDRY-ARCHITECTURE.md                    | 仍最高权威（架构层）           | 补充 §六 加 AgentRuntime 抽象 / Pipeline 加 Connector 抽象 / Object Type 加 SoT 字段 |
| ADR-2-PLATFORM-BOUNDARY.md                            | 仍有效（产品边界）             | 已经定义飞书数据流方向，本文档进一步细化                                             |
| DEVELOPMENT-CONTRACT.md                               | 仍有效                         | 补充铁律 30-34                                                                       |
| clawtwin-project/SKILL.md                             | 仍有效                         | 补充铁律 30-34                                                                       |
| CURSOR-MULTITASK-GUIDE.md                             | 需修正                         | 加 [T11c] AgentRuntime 适配器 / [T7.5] IMS Connector 包 / [T17] 飞书桥接细化         |

---

## 十二、决议

> **从今天起，ClawTwin 的业务交付目标是：**
>
> 1. **不替代客户已有任何系统**（飞书 / OpenClaw / HiAgent / IMS / SCADA / OT）
> 2. **作为"工业语义层 + 智能装配能力"的中间层存在**
> 3. **AgentRuntime 抽象让 Agent 平台可换**（不绑死 OpenClaw 或 HiAgent）
> 4. **Connector 抽象让 IMS 接入工程化**（不为每个客户写一次性脚本）
> 5. **飞书是出网通道而非数据源**（消息进 Agent，回调进 Foundry）
> 6. **客户内网私有化是默认形态**（OT/IMS 数据不出客户域）
> 7. **业务沉淀在 Foundry Ontology**（设备本体 / 流程本体 / 知识本体），随时间增值
>
> **以下被废弃：**
>
> - ❌ 写死 OpenClaw 的任何特殊处理
> - ❌ 为每个客户 IMS 写定制代码
> - ❌ Foundry 自建对话理解层
> - ❌ ClawTwin Mobile 独立 App（用飞书小程序替代）
> - ❌ 自建用户密码体系（用 SSO + 飞书企业账号）
>
> **以下保留：**
>
> - ✅ Industrial Ontology Foundry 范式（Object/Action/Function/Pipeline/Marking）
> - ✅ 自动从 Ontology 生成 HTTP/MCP/CLI/Studio UI
> - ✅ 4 服务 Phase A 技术栈（postgres + redis + vllm + openclaw）
> - ✅ LlamaIndex + pgvector 知识库
> - ✅ Provider 抽象（LLM/Embed/Notifier 可换）
> - ✅ ApprovalQueue / Audit / Trace / Lineage 横切关注

---

_这是 ClawTwin 项目的业务交付校验文档。所有产品/销售/实施工作必须以此为基准。_  
_Foundry 不是孤岛——它必须无缝嵌入客户的飞书 + Agent + IMS 现有环境，并让这三者协同起来。_
