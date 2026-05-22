# ClawTwin 商业架构设计：决策枢纽 + 生态保护 + 商业模式

**版本**：1.0，2026-05-11  
**核心问题**：

1. 是否应该借鉴 OpenClaw 的商业模式？借鉴什么？不借鉴什么？
2. Nexus 作为"决策枢纽"的架构如何设计？
3. 如何在发展生态的同时保护商业利益？

---

## 一、商业模式比较分析：OpenClaw 模式为何不能直接复制

### 1.1 OpenClaw 的商业逻辑

读完 OpenClaw 的 plugin 架构文档，可以看出其生态设计的精妙：

```
OpenClaw 的目标用户：
  · 个人开发者（安装 CLI，自己折腾）
  · 小型团队（共享 Gateway，自建插件）
  · 开源社区（贡献 Channel / Provider 插件）

OpenClaw 的商业逻辑：
  开源核心 → 用户基数增长 → 插件需求增加 → 商业插件/托管服务

  类似：VS Code（微软开源）→ 插件市场（第三方付费）→ GitHub Copilot（微软商业化）

OpenClaw 的保护机制（技术层面）：
  · manifest.json 描述符 → 可展示但未激活（限制未授权使用）
  · "Activation planning"（控制面决定哪些插件实际激活）
  · 商业插件可以检查 License Token 再激活
```

### 1.2 为什么 ClawTwin 不能直接复制 OpenClaw 模式

```
维度              OpenClaw               ClawTwin Nexus
──────────────────────────────────────────────────────────────────
目标客户          个人/开发者             工业企业（B2B）
采购决策          个人决定（下载即用）     IT 采购委员会（6-18月决策）
使用场景          个人工具               生产安全关键环境
扩展主体          社区/开发者             系统集成商（SI）/ 我们自己
定价敏感度        低（免费/低价插件）     低（企业预算充足，但要合规证明）
核心价值主张      "任何 AI 都能用"        "可信赖的工业 AI 决策"

关键差异：
工业客户不会去"插件市场"找解决方案。
他们需要：认证的供应商 + 经过验证的解决方案 + 长期支持合同。

复制 OpenClaw 的开源插件市场 → 错误方向。
```

### 1.3 正确参考：Grafana 模式（与 ClawTwin 最相似）

```
Grafana 的商业模式演进路径（ClawTwin 的最佳参考）：

Phase 1：开源核心 Grafana OSS（2014-2019）
  · Apache 2.0 许可，任何人可用
  · 获得了全球 50 万+用户基础
  · 建立了监控可视化的事实标准地位

Phase 2：Grafana Cloud（2019-2021）
  · 托管 SaaS，免费额度 + 付费扩展
  · 不需要自己运维 Grafana 实例
  · 对中小企业极具吸引力

Phase 3：Grafana Enterprise（2021-至今）
  · 企业级功能（LDAP/SSO/审计日志/SLA）
  · 数据源插件（企业专有，如 Oracle / ServiceNow 连接器）
  · 年度订阅，按节点/用户定价

Phase 4：Grafana 生态（2022-至今）
  · Plugin 市场（开放 + 商业插件共存）
  · ISV 合作伙伴计划（合作伙伴可发布付费插件）
  · Grafana 抽取收入分成

ClawTwin 的类比：
  Grafana OSS          → Nexus Framework Core（开源）
  Grafana Cloud        → ClawTwin Cloud（托管 SaaS，Phase C）
  Grafana Enterprise   → ClawTwin Enterprise（工业包+支持）
  Grafana Plugins      → Connect 连接器市场 + Sage 技能市场
```

### 1.4 其他有价值的参考

```
HashiCorp Terraform（基础设施即代码）的启示：
  · 开源 Core（terraform CLI）→ 任何人可用
  · Provider 生态（AWS/Azure/GCP 提供者）→ 免费，由云厂商维护
  · Terraform Cloud（托管）→ 收费
  · Terraform Enterprise（私有化）→ 高价年费

  对 ClawTwin 的启示：
  · Connector Registry（类比 Provider Registry）→ 开放，SI 维护
  · ClawTwin Cloud → 托管收费
  · 工业领域知识 → 私有，按行业订阅

Elastic/Kibana（搜索 + 分析）的启示：
  · 使用 SSPL 许可（不允许竞争对手用开源版本做 SaaS）
  · 基本功能开源 + X-Pack（机器学习/安全/告警）商业

  对 ClawTwin 的启示：
  · Nexus Core 开源但禁止竞争对手做 SaaS（BUSL 1.1）
  · Sage Intelligence Pack 完全商业，不开源
```

---

## 二、ClawTwin 的正确商业模式（最终版）

### 2.1 三层授权架构

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Layer 1：Nexus Framework Core                                                │
│  许可：Apache 2.0（商业友好，允许私有使用和修改）                               │
│  内容：通用对象注册、FSM 执行器、事件总线、连接器 SDK、安全框架                  │
│  开源时机：Phase B（先用 Phase A 验证商业价值）                                 │
│  策略：开源建生态，吸引 SI 集成商，形成技术生态                                 │
│  竞争保护：这层没有工业 IP，竞争对手拿到也没用                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│  Layer 2：Industrial Domain Pack + Enterprise Connect                         │
│  许可：BUSL 1.1（Business Source License）                                   │
│  BUSL 规则：4年内不允许用于提供竞争性 SaaS；4年后转 Apache 2.0              │
│  内容：工单 FSM 定义、ISA-18.2 告警策略、设备类型 Schema、OPC-UA 连接器        │
│  定价：¥3-15万/项目（一次性实施）+ ¥2-5万/年（维护）                          │
│  策略：工业专有知识 IP，4年保护窗口足够建立市场地位                             │
├──────────────────────────────────────────────────────────────────────────────┤
│  Layer 3：Sage Intelligence Pack + Prompt Library + Knowledge Packs           │
│  许可：完全商业（Proprietary），不开源                                         │
│  内容：Skill 代码、Prompt 模板、行业知识包、模型微调数据                        │
│  定价：¥5-30万/年（按站场数 + 行业包）                                        │
│  策略：最核心 IP，订阅制，随 AI 进化持续增值                                   │
└──────────────────────────────────────────────────────────────────────────────┘

Nexus Cloud（Phase C）：
  · 托管 SaaS（我们运维 Nexus，客户只需配置）
  · 基础套餐：¥2-5万/月（1-3 站场）
  · 高级套餐：¥8-15万/月（10+ 站场 + Sage + 支持）
```

### 2.2 Partner/ISV 生态计划（向 OpenClaw 学的部分）

```
这才是应该借鉴 OpenClaw 的地方——插件机制的技术设计：

ClawTwin 合作伙伴计划：

  Silver Partner（系统集成商）：
    · 获得 nexus-sdk 访问权（开源 SDK，免费）
    · 可以开发和销售自定义 Connector（需通过认证）
    · 收益：自行定价，无需向我们分成
    · 条件：通过 ClawTwin 技术认证

  Gold Partner（ISV 域包开发商）：
    · 可以在 ClawTwin Marketplace 发布付费域包
    · 我们提供"经 ClawTwin 认证"标志（价值信背书）
    · 收益：我们收 15% 平台费
    · 条件：域包通过技术+安全审核

  Platinum Partner（OEM/白标）：
    · 可以将 ClawTwin 技术嵌入自己的产品
    · 例如：设备厂商（压缩机制造商）在自己产品中嵌入 ClawTwin
    · 收益：按台/年收取 OEM 许可费
    · 条件：签署 OEM 协议，量大

  类比：
    OpenClaw 的 Channel Plugin → ClawTwin 的 Connector Plugin
    OpenClaw 的 Provider Plugin → ClawTwin 的 AI Provider Plugin（Phase C）
    OpenClaw 的插件市场 → ClawTwin Marketplace（工业解决方案市场）
```

---

## 三、决策枢纽架构（Decision Hub Architecture）

这是 Nexus 最核心的架构模式——不是被动地"提供数据"，而是主动地"准备好决策"。

### 3.1 决策包（Decision Package）：预计算的决策上下文

```python
# core/decision/decision_package.py

@dataclass
class DecisionPackage:
    """
    预计算的完整决策上下文。
    由 Pulse Engine 每 30 秒计算一次，缓存在 Redis。
    Studio 请求设备时，毫秒级返回，无需实时计算。

    这是"快速决策"架构的核心——决策发生时，上下文已经准备好了。
    """

    # ── 实体标识 ──────────────────────────────────────
    station_id: str
    equipment_id: str
    computed_at: str

    # ── 状态感知（What is happening）─────────────────
    health_score: float         # 0-100
    health_status: str          # "excellent" | "good" | "warning" | "critical"
    health_trend: str           # "improving" | "stable" | "declining" | "rapid_decline"

    current_readings: dict      # {metric: {value, unit, status, threshold}}

    # ── 风险信号（What needs attention）──────────────
    active_alarms: list         # [{alarm_id, level, metric, message, age_min}]
    anomaly_forecast: dict      # {score, predicted_failure_hours, confidence}

    # ── AI 预备分析（What AI already thinks）─────────
    proactive_insight: dict | None  # AI 已预备的诊断（可能为 None，还未分析）
    insight_age_min: int | None     # AI 分析是多少分钟前的

    # ── 推荐行动（What to do）──────────────────────
    primary_action: dict        # {action_id, label, urgency, estimated_time}
    secondary_actions: list     # [{action_id, label}]（最多 3 个）

    # ── 相关知识（What context is available）─────────
    relevant_kb_ids: list[str]  # 预检索的相关知识文档 ID（懒加载）
    similar_past_incidents: list # 历史相似事件（最多 3 条）

    # ── 决策质量指标（How reliable is this）─────────
    data_quality: str           # "high" | "medium" | "low" | "stale"
    ai_confidence: str | None   # AI 分析的置信度
    last_human_action: dict | None  # 最后一次人工操作（防止 AI 重复建议已处理问题）


class DecisionPackageCache:
    """Redis 缓存层，提供 O(1) 决策包查询"""

    CACHE_KEY = "decision:{station_id}:{equipment_id}"
    CACHE_TTL_S = 45  # 30s 刷新 + 15s 缓冲

    async def get(self, station_id: str, equipment_id: str) -> DecisionPackage | None:
        key = self.CACHE_KEY.format(station_id=station_id, equipment_id=equipment_id)
        data = await redis.hgetall(key)
        return DecisionPackage(**json.loads(data)) if data else None

    async def set(self, pkg: DecisionPackage) -> None:
        key = self.CACHE_KEY.format(
            station_id=pkg.station_id, equipment_id=pkg.equipment_id)
        await redis.setex(key, self.CACHE_TTL_S, json.dumps(asdict(pkg)))
```

### 3.2 决策枢纽数据流（完整架构）

```
物理世界
  │
  │ OPC-UA (实时)
  ▼
╔═══════════════════════════════════════════════════════════════════════════════╗
║  ClawTwin Bridge（OT 网络）                                                    ║
╚═══════════════════════════════════════════════════════════════════════════════╝
  │
  │ Kafka: ot.readings.{station_id}
  ▼
╔═══════════════════════════════════════════════════════════════════════════════╗
║  Nexus 决策枢纽（DECISION HUB）                                               ║
║                                                                               ║
║  ┌─────────────┐   ┌──────────────┐   ┌─────────────────────────────────┐   ║
║  │ IngestPipe  │   │ TimescaleDB  │   │      Redis 决策缓存              │   ║
║  │ （流水线）   │──►│ （历史数据）  │   │ ┌─────────────────────────┐    │   ║
║  └─────────────┘   └──────────────┘   │ │ decision:{sid}:{eid}    │    │   ║
║        │                              │ │ health_score: 73         │    │   ║
║        │                              │ │ primary_action: {...}    │    │   ║
║        ▼                              │ │ proactive_insight: {...}  │    │   ║
║  ┌─────────────┐                      │ └─────────────────────────┘    │   ║
║  │ Pulse Engine│──────────────────────►│ [30s 自动刷新]                │   ║
║  │（30s 心跳） │◄─── MOIRAI 预测 ─────│                               │   ║
║  └─────────────┘                      └─────────────────────────────────┘   ║
║        │                                             │                       ║
║        ▼                                             │ SSE/WS                ║
║  ┌──────────────────────────────────────┐            ▼                       ║
║  │ AI Proactive Engine                  │  ┌────────────────────────────┐   ║
║  │ （主动智能）                          │  │     Studio（用户界面）      │   ║
║  │  · 异常分数 > 0.7 → 触发 Sage 预分析 │  │ · 打开设备页: 决策包已就绪 │   ║
║  │  · 分析结果缓存到 DecisionPackage     │  │   响应 < 50ms              │   ║
║  └──────────────────────────────────────┘  │ · 告警弹出: 立即可见       │   ║
║                                             │ · 1-Click: 工单已预填好   │   ║
║  ┌─────────────────────────────────────┐   └────────────────────────────┘   ║
║  │ OpenClaw + Sage（AI 推理层）         │                                     ║
║  │  · Skill 被 AI Proactive 触发        │   ┌────────────────────────────┐   ║
║  │  · 或被用户 AI Job 请求触发          │   │       飞书 Mobile           │   ║
║  │  · 推理结果写回 DecisionPackage       │──►│ · 决策包推送为消息卡片     │   ║
║  └─────────────────────────────────────┘   │ · 1-Click 飞书内审批       │   ║
║                                             └────────────────────────────┘   ║
╚═══════════════════════════════════════════════════════════════════════════════╝
  │                              │                              │
  ▼                              ▼                              ▼
CMMS（工单推送）             ERP（事件记录）              Grafana（分析趋势）
```

### 3.3 Studio 的快速决策 API 契约

```
Studio 打开设备页面的完整请求流程：

  1. GET /v1/equipment/{id}/decision-package
     → Redis 查询（< 10ms）
     → 返回完整决策包（健康分/告警/AI 洞察/推荐行动）
     → Studio 立即渲染，无需等待

  2. GET /v1/equipment/{id}/readings/stream （SSE）
     → 建立持久连接
     → 读数每 5 秒推送增量更新
     → 健康分变化时推送事件

  3. GET /v1/equipment/{id}/history （懒加载）
     → 用户滚动到趋势图时才请求
     → TimescaleDB Continuous Aggregate（< 100ms）

  4. GET /v1/kb/contextual?equipment_id={id}
     → 使用 DecisionPackage 中预存的 relevant_kb_ids
     → 直接按 ID 查文档（< 50ms），不需要重新向量化检索
     → 页面加载后异步获取，不阻塞主视图

整个"打开设备页面"体验：
  < 50ms  → 决策包（健康/告警/推荐行动）
  < 100ms → 趋势数据（Continuous Aggregate）
  < 300ms → 知识上下文（按 ID 查 KB 文档）
  0-2min  → AI 完整诊断（如果 AI Proactive 已预备，立即有；否则等待）
```

### 3.4 CQRS 模式：命令 vs 查询严格分离

```
查询路径（高频，毫秒级，优化为只读）：
  GET /v1/equipment/{id}/decision-package  → Redis（O(1)）
  GET /v1/equipment/{id}/readings/latest   → Redis Hash
  GET /v1/analytics/kpi                   → TimescaleDB Continuous Aggregate
  GET /v1/kb/search                        → Milvus ANN Search
  GET /v1/alarms?active=true              → Redis Sorted Set（按时间）

  读路径特点：
  · 不经过写锁
  · 允许读到稍旧的数据（30s 内）
  · 可以多读副本水平扩展

命令路径（低频，事务保证，写后立即一致）：
  POST /v1/workorders/{id}/approve        → PostgreSQL（强一致）→ Kafka
  POST /v1/alarms/{id}/acknowledge        → PostgreSQL（强一致）→ Kafka
  POST /v1/ai/jobs                        → PostgreSQL（持久）→ Redis Queue

  写路径特点：
  · 强一致性（ACID 事务）
  · 写成功后同步更新 Redis 缓存
  · 通过 Kafka 广播给所有订阅者

数据一致性保证：
  · 写操作：DB → Redis（同步） → Kafka（异步，最终一致）
  · 读操作：优先读 Redis，Redis miss 则读 DB（自动 warm-up 缓存）
  · 决策包：Pulse Engine 每 30s 主动刷新，不依赖请求触发
```

---

## 四、商业模式与架构的绑定关系

### 4.1 架构如何物理支持商业边界

OpenClaw 的聪明之处在于：**manifest（控制面）先于 runtime（运行面）加载**。
这意味着：可以展示插件列表（元数据），但只有激活的插件才运行代码。

ClawTwin 用同样的原则保护商业利益：

```python
# core/license/license_enforcer.py

class LicenseEnforcer:
    """
    许可证执行器：控制面层面的访问控制。
    在组件加载前检查许可，而不是在执行时检查（性能 + 安全）。
    """

    def __init__(self, license_key: str | None):
        self.license = validate_license(license_key)  # 启动时验证一次

    def check_feature(self, feature_id: str) -> FeatureAccess:
        """
        检查功能是否已授权。
        返回 FeatureAccess 而不是 bool，提供丰富的响应信息。
        """
        if feature_id in self.license.included_features:
            return FeatureAccess(allowed=True)

        if feature_id in COMMUNITY_FEATURES:
            return FeatureAccess(allowed=True, tier="community")

        return FeatureAccess(
            allowed=False,
            upgrade_url="https://clawtwin.com/pricing",
            feature_name=FEATURE_NAMES[feature_id],
            available_in_tier=FEATURE_TIERS[feature_id],
        )

    def enforce(self, feature_id: str) -> None:
        """在路由层快速检查，未授权返回 402"""
        access = self.check_feature(feature_id)
        if not access.allowed:
            raise LicenseError(feature_id, access)


# 功能授权矩阵
FEATURE_TIERS = {
    # Community（免费，无需许可证）
    "basic_iot_ingest":         "community",
    "basic_alarms":             "community",
    "basic_workorder":          "community",
    "studio_basic_view":        "community",

    # Standard（基础商业，¥3-5万/年）
    "sage_skills":              "standard",
    "kb_rag_search":            "standard",
    "feishu_integration":       "standard",
    "multi_station":            "standard",
    "opcua_connector":          "standard",

    # Enterprise（完整商业，¥10-30万/年）
    "fleet_intelligence":       "enterprise",
    "action_policy_engine":     "enterprise",
    "cmms_connector":           "enterprise",
    "erp_connector":            "enterprise",
    "ai_accuracy_report":       "enterprise",
    "custom_domain_schema":     "enterprise",

    # OEM（按协议）
    "white_label":              "oem",
    "multi_tenant":             "oem",
    "custom_branding":          "oem",
}


# 在路由层执行许可证检查（参考 OpenClaw 的 "activation planning"）
@router.post("/v1/ai/jobs")
async def create_ai_job(
    body: AIJobRequest,
    ctx: RequestContext = Depends(get_request_context),
    license: LicenseEnforcer = Depends(get_license),
):
    license.enforce("sage_skills")  # 未授权返回 402 + 升级链接
    # ... 正常处理
```

### 4.2 元数据可见但运行时受控（类比 OpenClaw 插件激活）

```
OpenClaw 的模式：
  · 未激活插件 → manifest 可见（用户看到有这个插件）
  · 激活插件 → runtime 加载（用户可以用）
  · 商业插件 → 检查 License Token → 激活

ClawTwin 的类比：
  · Studio 展示所有可用功能（包括未授权的）
  · 未授权功能 → 显示但 "灰色 + 升级" 标签
  · 授权功能 → 完全可用

  具体实现：
  GET /v1/license/features → 返回当前授权的功能列表

  Studio 启动时请求此 API，渲染功能可见性：
  {
    "features": {
      "sage_skills": { "allowed": true, "tier": "standard" },
      "fleet_intelligence": { "allowed": false, "tier": "enterprise",
                              "upgrade_url": "..." }
    }
  }

  Studio 用此信息：
  · 已授权：完整功能，正常显示
  · 未授权：显示锁定图标 + "升级到 Enterprise 解锁" 按钮
  · 这就是"功能展示即营销"——用户看到价值，进而升级购买
```

### 4.3 Connector/Plugin 注册机制（生态保护）

```python
# connectors/marketplace_registry.py

class ConnectorMarketplace:
    """
    连接器市场注册表——既支持生态，又保护商业利益。
    参考 Terraform Registry / Grafana Plugin Catalog 的设计。
    """

    def validate_connector_manifest(self, manifest: ConnectorManifest) -> ValidationResult:
        """
        连接器上架前必须通过验证：
        1. 技术验证：接口兼容性、安全性扫描
        2. 商业验证：是否侵犯我们的独占连接器
        3. 质量验证：是否有文档、测试、版本策略
        """
        results = []

        # 技术检查
        results.append(self._check_interface_compatibility(manifest))
        results.append(self._check_security(manifest))

        # 商业独占检查（防止 SI 发布"山寨版"我们的核心连接器）
        if manifest.connector_id in EXCLUSIVE_CONNECTORS:
            results.append(ValidationResult(
                passed=False,
                reason=f"连接器 {manifest.connector_id} 是 ClawTwin 官方独占连接器"
            ))

        return ValidationResult.aggregate(results)

    # 我们的独占连接器（不允许第三方发布竞争版本）
    EXCLUSIVE_CONNECTORS = {
        "clawtwin-opcua",     # OPC-UA 官方连接器（我们的核心）
        "clawtwin-feishu-oa", # 飞书 OA 连接器（我们的核心）
        "clawtwin-cmms",      # CMMS 通用连接器（我们的核心）
    }

    # 开放给合作伙伴的连接器类型（可以发布竞争版本，但需要认证）
    OPEN_CATEGORIES = {
        "erp",          # ERP 连接器（SAP/用友/金蝶）
        "gis",          # GIS 地图连接器
        "historian",    # 历史数据库连接器（PI System 等）
        "cmms-specific",# 特定 CMMS 连接器（如专有国产 CMMS）
    }
```

---

## 五、Studio 作为决策终端：架构精化

### 5.1 Studio 的三个核心界面模式（向 Palantir AIP 学习）

```
Palantir AIP 的三个核心体验模式：
  1. Object Browser（对象浏览）：展示"世界里有什么"
  2. Object Action（对象行动）：在对象上"做什么"
  3. Object Timeline（对象历史）："发生了什么"

ClawTwin Studio 的对应：
  1. Station/Equipment View（对象浏览）
     → Nexus /v1/equipment, /v1/stations
     → 实时状态 + DecisionPackage
     → 支持按"需要关注度"排序，最差的排最前

  2. Action Panel（行动面板）
     → 基于 DecisionPackage.primary_action 渲染
     → 1-Click 执行（工单/确认/请求 AI）
     → 行动结果实时反馈

  3. Investigation Mode（调查模式）
     → 选择时间范围
     → 时序图 + 告警时间线 + 工单历史 + KB 相关文档
     → AI 协助根因分析
     → 对应 Nexus /v1/equipment/{id}/timeline
```

### 5.2 Studio 的数据获取优先级（避免过度 API 调用）

```typescript
// Studio 的"智能数据获取"策略

class SmartDataFetcher {
  /**
   * 按优先级获取数据，而不是一次性全部请求。
   * 参考 Grafana 的 Query Priority 机制。
   */

  // 优先级 1（立即获取，阻塞渲染）：决策包 < 50ms
  async getDecisionPackage(equipmentId: string) {
    return nexus.get(`/v1/equipment/${equipmentId}/decision-package`);
  }

  // 优先级 2（后台获取，非阻塞）：历史趋势 < 200ms
  async prefetchTrend(equipmentId: string) {
    requestIdleCallback(() => {
      nexus.get(`/v1/equipment/${equipmentId}/history?period=24h`);
    });
  }

  // 优先级 3（用户交互触发）：知识库
  async getKBOnDemand(kbIds: string[]) {
    // 用户点击"查看相关知识"才触发
    return nexus.get(`/v1/kb/batch?ids=${kbIds.join(",")}`);
  }

  // 优先级 4（后台静默）：AI 主动分析结果
  // 通过 SSE 接收，不需要主动轮询
  subscribeToAIInsights(equipmentId: string, callback: (insight: AIInsight) => void) {
    const sse = new EventSource(`/v1/sse/equipment/${equipmentId}`);
    sse.addEventListener("ai_insight", (e) => callback(JSON.parse(e.data)));
  }
}
```

### 5.3 Studio 状态机（用户交互的有限状态）

```
设备页面的用户交互状态机：

  LOADING（50ms）：显示骨架屏，获取 DecisionPackage
         │
         ▼
  READY（主状态）：显示决策包，渲染主行动按钮
    │
    ├─ 用户点击"请求 AI 诊断"
    │    ▼
    │  AI_PENDING：显示加载状态（进度条 + 估计时间）
    │    │
    │    └─ SSE: ai_job_done
    │         ▼
    │       AI_READY：显示 AI 诊断结果 + 工单草稿
    │         │
    │         ├─ 用户点击"采纳建议"
    │         │    ▼
    │         │  WORKORDER_CREATED：显示工单卡片
    │         │
    │         └─ 用户点击"修改后采纳"
    │              ▼
    │            WORKORDER_EDIT：可编辑工单草稿
    │
    ├─ 用户点击告警"确认"
    │    ▼
    │  ALARM_ACK_CONFIRM：确认弹窗（防误操作）
    │    │
    │    └─ 确认 → ALARM_ACKED → 更新告警列表
    │
    └─ 用户切换到"调查模式"
         ▼
       INVESTIGATION：时序图 + 多维分析（重量级，懒加载）
```

---

## 六、数据飞轮的商业架构实现

### 6.1 从单客户数据到行业智慧的路径

```
这是商业模式中最重要的护城河，需要架构层面的支持：

Level 0（每个客户独立）：
  客户 A 的 L3 知识 → 只用于客户 A
  客户 B 的 L3 知识 → 只用于客户 B

Level 1（匿名聚合，Phase B）：
  客户 A 同意分享 → 脱敏处理 → ClawTwin 知识库
  客户 B 同意分享 → 脱敏处理 → ClawTwin 知识库
  新客户 C → 获得 Level 1 聚合知识（设备型号 X 常见故障模式）

Level 2（行业智慧，Phase C）：
  跨 50 个站场的故障模式 → 行业统计
  → Sage 提示词模板基于真实案例改进
  → 新 Sage 订阅客户获得行业平均水平的 AI 质量

  这就是"AI 越用越聪明"的商业护城河
```

### 6.2 隐私保护与数据飞轮的技术平衡

```python
# engines/knowledge/data_flywheel.py

class DataFlywheel:
    """
    数据飞轮：在保护客户隐私的前提下积累行业知识。
    架构上的关键：客户数据永远不离开本地，只有"学习结果"上传。
    """

    async def extract_anonymized_pattern(self, workorder: WorkOrder) -> KnowledgePattern | None:
        """
        从完成的工单中提取可分享的知识模式（如果客户授权）。

        可以分享的：
          · 设备类型（通用）+ 故障类型（通用）+ 解决方法（通用）

        绝对不分享的：
          · 客户名称 / 站场地点 / 具体设备编号
          · 生产数据 / 操作记录 / 内部流程
          · 任何可以反推客户身份的信息
        """
        if not workorder.customer_consent_to_share:
            return None

        return KnowledgePattern(
            pattern_id=hash(workorder.actual_cause + workorder.equipment_type),
            equipment_type=workorder.equipment_type,    # "centrifugal_compressor"
            symptom_category=categorize(workorder.diagnosis),  # "bearing_wear"
            solution_category=categorize(workorder.repair),    # "bearing_replacement"
            effectiveness_score=workorder.ai_was_correct,      # True/False

            # 所有可识别信息被移除
            customer_id=None,
            station_id=None,
            equipment_id=None,
        )

    async def upload_pattern(self, pattern: KnowledgePattern) -> None:
        """上传脱敏模式到 ClawTwin 中央知识库（仅当客户授权时）"""
        await central_kb_api.post("/v1/patterns", asdict(pattern))
```

---

## 七、商业模式路线图与架构里程碑

```
Phase A（2026，工业应用验证）：
  商业目标：签订 1-3 个付费项目，验证产品市场契合度（PMF）
  定价：¥30-80万/项目（含实施）
  架构重点：
    · DecisionPackage 基础版（Pulse Engine + Redis 缓存）
    · LicenseEnforcer 雏形（软许可证，主要用于内部控制）
    · Sage Skills 第一个高质量 Skill（equipment-twin）

  Phase A 结束时的核心验证：
    · AI 准确率 > 80%
    · 用户愿意主动找 AI 咨询（不是我们推着用）
    · 至少 1 个客户愿意贡献脱敏数据

Phase B（2027，框架化 + 生态启动）：
  商业目标：年收入 ¥500-2000 万，3-10 个付费客户
  定价：项目费 + 年度订阅 ¥5-30万/年
  架构重点：
    · 开源 Nexus Framework Core（Apache 2.0）
    · 发布 nexus-sdk pip 包
    · LicenseEnforcer 正式版（在线许可证验证）
    · ConnectorMarketplace 第一版（合作伙伴可发布连接器）
    · DecisionPackage 完整版（含 AI Proactive）
    · Kafka 统一事件总线

Phase C（2028，平台化）：
  商业目标：年收入 ¥2000-8000 万，20+ 客户，3+ 合作伙伴
  定价：SaaS 月费 ¥2-15万 + 合作伙伴收入分成
  架构重点：
    · ClawTwin Cloud（托管 SaaS，多租户）
    · Sage Marketplace（行业技能包市场）
    · Data Flywheel（跨站场知识积累）
    · Fleet Intelligence（多站场管理）
```

---

## 八、关键商业风险与架构应对

```
风险 1：客户自行修改开源 Nexus Core，绕过商业功能
  应对：
    · LicenseEnforcer 作为运行时检查（客户无法轻易绕过）
    · 商业功能在 BUSL 域包中（不是在开源 Core 里）
    · 核心 IP（Sage Prompt 模板/知识包）不在 Git 仓库

风险 2：竞争对手 fork Nexus Core，做竞争产品
  应对：
    · Apache 2.0 允许 fork，这无法阻止
    · 但 Domain Pack 是 BUSL（4年内不能做竞争 SaaS）
    · Sage 完全闭源（竞争对手无法复制提示词工程）
    · 数据飞轮（竞争对手拿不到我们积累的行业数据）

风险 3：大厂（Siemens/Honeywell）看到我们做法后复制
  应对：
    · 先发优势 + 数据飞轮（大厂没有我们积累的案例数据）
    · 大厂动作慢（2-3年才能有类似产品），我们已深入客户
    · 专注垂直场景（油气站场）而非通用平台——大厂做不深

风险 4：OpenClaw 改变 Plugin API，导致 Sage 失效
  应对：
    · 正式化 Sage-OpenClaw 接口契约（contracts/ 目录）
    · 钉住 OpenClaw 版本（package.json peerDependencies）
    · 参与 OpenClaw 的 API 稳定性讨论
    · 备选：Phase B 考虑自建轻量 Skill 运行时（减少 OpenClaw 依赖）
```

---

## 九、一句话总结

```
不要复制 OpenClaw 的商业模式（目标客户不同，个人工具 vs 企业 B2B）。

应该借鉴 OpenClaw 的架构模式：
  · Manifest-first → DecisionPackage（决策包预计算）
  · Activation planning → LicenseEnforcer（商业边界执行）
  · Plugin SDK → nexus-sdk（生态发展）
  · 控制面/运行面分离 → 热重载、生产稳定

ClawTwin 的正确商业路径是 Grafana 模式：
  · 开源框架（吸引技术生态）
  · 工业域包（商业 IP，BUSL 保护）
  · Sage 订阅（核心 AI 价值，完全闭源）
  · 合作伙伴计划（SI 生态，非个人开发者）

最终护城河：
  不是代码，不是模型，是"跨 N 个站场积累的工业运营知识"
  + 业界首个"设备健康 → AI 诊断 → 工单 HITL → 知识回流"的完整工业 AI 飞轮
```

---

## 十、开源风险的关键修正（2026-05-11 补充）

### 10.1 用户提出的关键质疑：开源后谁来找我？

**用户的判断完全正确**。原方案（开源 Nexus Core + 商业域包）存在致命漏洞：

```
风险场景还原：

1. 我们开源 Nexus Framework Core（Apache 2.0）
2. 某 SI 集成商（乙方工程公司）fork 我们的代码
3. SI 用开源代码部署给他们的客户（某油气公司）
4. 域包：SI 自己雇工程师照着我们的设计写（工作量 3-6 个月）
5. 客户直接和 SI 签合同，完全不需要找我们
6. 行业知识飞轮：SI 的每个项目积累经验 → 他们越做越强

结果：我们免费培养了竞争对手。
```

OpenClaw 的开源策略有效，是因为：

- 用户直接到 OpenClaw 官网/GitHub 下载（个人直接触达）
- 插件市场里用户直接买付费插件（OpenClaw 在中间）
- SI 不是 OpenClaw 的渠道，用户才是

ClawTwin 的客户是工业企业，SI 才是渠道——**开源等于武装竞争对手**。

### 10.2 修正后的许可证策略

```
修正版本：从来不完全开源核心

错误策略（原方案）：
  Nexus Core → Apache 2.0（开源）
  Domain Pack → BUSL 1.1（4年保护）
  Sage → 商业闭源

正确策略：
  Nexus Core → BUSL 1.1（"源代码可见，但不可商用竞争"）
  Domain Pack → 商业专有（完全闭源）
  Sage → 商业专有（完全闭源）

  对客户：可以审计源代码（企业安全合规需要）
  对 SI：部署客户项目需要签 Partner License（我们收费）
  对竞争对手：不能用我们的代码做竞争 SaaS（BUSL 保护）
```

**BUSL 1.1（Business Source License）规则：**

- 源代码公开可读（满足企业审计需求）
- 允许内部使用和评估
- **禁止**：不经授权向第三方提供托管服务
- **允许**：客户自己部署用于自己的业务
- 时间限制：4年后自动转为 Apache 2.0
- 使用者：HashiCorp（Terraform）、CockroachDB、MariaDB、Sentry

### 10.3 行业包的正确积累策略

```
用户的第二个判断也正确：行业包很难在早期积累

根本原因：
  行业知识需要真实项目才能积累
  真实项目在 Phase A 只有 1-3 个
  1-3 个项目的知识质量有限

正确做法（分阶段）：

Phase A（自研+投入）：
  · 聘请 2-3 名退休/资深石油天然气工程师作为领域专家
  · 他们帮助构建 L0/L1 知识（行业标准 + 最佳实践）
  · 不依赖项目积累，主动建设基础知识库
  · 目标：拥有中国最系统的天然气管输 AI 知识库

Phase B（合规+共建）：
  · 与客户签"知识共建协议"（客户贡献脱敏运营数据 → 获得知识库访问权）
  · 选择 1-2 个愿意深度合作的标杆客户作为"创始客户"
  · 创始客户获得终身折扣 + 优先影响产品路线图

Phase C（飞轮启动）：
  · 累计 5+ 站场真实数据后，AI 质量显著超越初始状态
  · 竞争对手想追 → 需要同等时间和项目经验
  · 这才是真正的护城河
```

### 10.4 为了支撑生态，产品还需要什么？

```
现在能支撑生态的：
  ✅ 清晰的 API 契约（Connector SDK 接口定义）
  ✅ 完整的数据模型（本体层设计）
  ✅ 安全模型（SI 可以信赖）

还不能支撑生态的（必须先建好）：
  ❌ Partner Portal（SI 去哪里注册、获得 SDK、跟踪项目？）
  ❌ 连接器测试框架（SI 开发的连接器如何验证质量？）
  ❌ 标准化交付物（SI 交付给客户的是什么格式的包？）
  ❌ 云端 Sage 管理（SI 如何给客户推送 Skill 更新？）
  ❌ 多租户管理后台（我们如何管理 N 个 SI 的 N 个客户？）

Phase A 不需要这些（只有我们自己做项目）
Phase B 需要至少一个 SI 愿意一起做，才能验证生态可行性
Phase C 才是真正的平台+生态

结论：不要在 Phase A 为生态过度设计，先做好 1-3 个精品项目，
      让产品有自己的生命力，生态会自然增长。
```

### 10.5 最终商业模式定版

```
ClawTwin 商业模式（修正后）：

阶段 A（2026）：项目制 + 完全闭源
  主要收入：¥50-200万/项目（含定制开发+实施+首年维护）
  目标：验证技术可行性 + AI 价值 + 客户付费意愿

阶段 B（2027）：SaaS 化 + BUSL 开源（只开核心框架）
  主要收入：¥3-15万/月/站场（含 Sage 订阅+运维）
  目标：转为可复制的 SaaS 模式，降低实施成本
  Partner：签约 1-2 个 SI，测试 SI License 模式

阶段 C（2028+）：平台 + 生态
  主要收入：SaaS + SI License 费用 + Marketplace 分成
  目标：不依赖自己直接销售，SI 生态驱动增长
  护城河：跨 20+ 站场的行业知识 + ClawTwin 认证 SI 品牌
```

---

_本文档创建于 2026-05-11，是 ClawTwin 商业架构的权威设计文档。_  
_§十 于 2026-05-11 补充，修正了原方案中开源策略的致命漏洞。_  
_每个架构决策都绑定到商业目标：保护核心 IP、支持生态发展、实现数据飞轮护城河。_
