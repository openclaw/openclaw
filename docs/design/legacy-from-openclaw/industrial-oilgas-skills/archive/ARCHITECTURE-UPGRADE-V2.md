# ClawTwin 架构升级 V2：借鉴业界精华，构建生产级工业 AI 平台

**版本**：1.0，2026-05-11  
**性质**：架构深化文档，从 Phase A MVP 演进到 Phase B/C 生产级  
**核心命题**：充分利用业界已有系统，AI 颠覆的是"组合方式"，不是"重造轮子"

---

## 一、从 OpenClaw 深度学习：五个关键模式

### 1.1 控制面 vs 运行面分离（最重要）

OpenClaw 的 `src/plugins/AGENTS.md` 明确规定：

```
"Keep control-plane and runtime-plane concerns separate:
  · discovery, manifest parsing, config validation, setup/onboarding hints,
    and activation planning belong to the control plane
  · actual plugin execution belongs to runtime resolution"

"Preserve manifest-first behavior: discovery, config validation, and setup
  should work from metadata before plugin runtime executes"
```

**这对 Nexus 意味着什么：**

```
当前 Nexus（控制面/运行面混在一起）：
  main.py 启动 → 加载 ORM 模型（运行时）→ 注册路由（运行时）→ 启动 Scheduler（运行时）
  所有配置直接写在代码中，无法在不重启的情况下变更

目标 Nexus（控制面/运行面分离）：

  控制面（Control Plane）：
    · Schema Registry：从 YAML 文件/DB 加载本体定义（设备类型/FSM/策略）
    · Connector Registry：从 manifest 发现可用连接器
    · Policy Registry：加载行动策略（允许哪些自动化）
    · 验证：Schema 合法性检查、连接器兼容性检查
    · 配置更新：热加载（不重启 Nexus）

  运行面（Runtime Plane）：
    · IngestPipeline：实际执行数据摄入
    · StateMachineExecutor：实际执行 FSM 转换
    · AIDispatcher：实际执行 AI 任务调度
    · SSE Publisher：实际推送实时数据

  边界规则（直接借鉴 OpenClaw）：
    运行面组件不得直接读取控制面的配置文件
    必须通过 ControlPlaneAPI 获取当前有效配置
    控制面变更通过"配置变更事件"通知运行面热重载
```

**实现：**

```python
# core/control_plane/schema_registry.py

class SchemaRegistry:
    """
    控制面：管理所有 Domain Schema 的生命周期。
    Schema 变更不重启 Nexus，运行面组件热加载。
    """

    def __init__(self):
        self._schemas: dict[str, ObjectSchema] = {}
        self._fsm_defs: dict[str, FsmDefinition] = {}
        self._listeners: list[SchemaChangeListener] = []

    async def load_from_yaml(self, yaml_dir: str) -> None:
        """从 YAML 目录加载所有 Schema（启动时 + 热重载时）"""
        for yaml_file in Path(yaml_dir).glob("*.schema.yaml"):
            schema = parse_schema_yaml(yaml_file)
            self._schemas[schema.type_id] = schema

        # 通知运行面热重载
        await self._notify_listeners(SchemaReloaded(schemas=self._schemas))

    async def register_from_admin_api(self, schema_def: dict) -> None:
        """运行时从 Admin API 注册新 Schema（Admin 功能）"""
        schema = validate_and_parse(schema_def)
        self._schemas[schema.type_id] = schema
        await self._notify_listeners(SchemaAdded(schema=schema))

    def get_fsm(self, entity_type: str) -> FsmDefinition:
        """运行面组件调用此方法获取当前 FSM 定义"""
        return self._fsm_defs.get(entity_type)

# 全局单例，运行面通过此接口访问控制面
schema_registry = SchemaRegistry()
```

### 1.2 TaskFlow 模式（AI 任务的持久化工作流）

OpenClaw 的 `src/plugins/runtime/runtime-taskflow.types.ts` 定义了：

```typescript
type ManagedTaskFlowRecord = TaskFlowRecord & {
  syncMode: "managed";
  controllerId: string; // ← 谁在管理这个工作流（我们的 Nexus）
};
```

这告诉我们：**AI 任务应该是受 Nexus 管控的持久工作流**，不只是 Redis 队列里的一条消息。

**当前问题（AI Job 是脆弱的）：**

```
当前：POST /ai/jobs → Redis LPUSH → AIJobWorker BRPOP → 调用 OpenClaw → 等待回调
问题：
  ✗ Server 重启 → Redis 里的任务丢失（BRPOP 的消息已弹出但未处理）
  ✗ 没有超时机制（AI 任务可能永久 pending）
  ✗ 没有重试（OpenClaw 挂了 → 任务静默失败）
  ✗ 没有取消机制（用户无法取消已提交的任务）
```

**升级方案（借鉴 OpenClaw TaskFlow）：**

```python
# engines/intelligence/ai_job_runtime.py

class AIJobRuntime:
    """
    持久 AI 任务运行时。
    对齐 OpenClaw 的 ManagedTaskFlow 模式：
    - controllerId = nexus（Nexus 控制任务生命周期）
    - syncMode = managed（Nexus 主动同步状态）
    - 支持：创建/等待/取消/超时/重试
    """

    async def create_job(self, job_type: str, context: dict,
                         requested_by: str, timeout_s: int = 120) -> AIJob:
        """创建持久 AI 任务（幂等，重复提交返回已有任务）"""

        job = AIJob(
            job_id=generate_id(),
            job_type=job_type,
            state="queued",
            controller_id="nexus",      # Nexus 是 controllerId
            context=context,
            requested_by=requested_by,
            timeout_at=utcnow() + timedelta(seconds=timeout_s),
            retry_count=0,
            max_retries=2,
        )
        await self.repo.save(job)

        # 持久化后再入队（避免丢失）
        await redis.lpush("nexus:ai_jobs", job.job_id)

        await event_bus.emit(AIJobQueued(job_id=job.job_id, job_type=job_type))
        return job

    async def heartbeat(self) -> None:
        """后台定期检查：超时任务 → 重试/失败"""
        stale_jobs = await self.repo.find_stale(timeout_threshold=utcnow())
        for job in stale_jobs:
            if job.retry_count < job.max_retries:
                await self.retry(job)
            else:
                await self.fail(job, reason="timeout_exceeded")

    async def cancel(self, job_id: str, by: str) -> bool:
        """用户取消任务（向 OpenClaw 发送取消信号）"""
        job = await self.repo.get(job_id)
        if job.state in ("done", "failed", "cancelled"):
            return False

        # 通知 OpenClaw 停止处理
        await self.openclaw_client.cancel_flow(job.openclaw_flow_id)

        job.state = "cancelled"
        await self.repo.save(job)
        return True
```

### 1.3 Manifest-First 连接器发现（向 OpenClaw 插件系统学习）

```python
# connectors/manifest.py
# 类比 OpenClaw 的 PluginManifest

@dataclass
class ConnectorManifest:
    """
    连接器描述符——先于连接器代码加载。
    系统启动时只加载 manifest（轻量），
    实际连接只在需要时发生（懒加载）。
    """
    connector_id: str
    display_name: str
    version: str
    connector_type: str          # "ot" | "it"
    protocols: list[str]         # ["opcua", "modbus"]

    # 控制面信息（不需要运行连接器就可以知道）
    requires_config: list[str]   # ["host", "port", "username"]
    health_check_interval_s: int

    # 运行面（懒加载）
    _runtime_class: str | None = None  # 模块路径，按需导入


class ConnectorRegistry:
    """
    控制面：发现所有可用连接器（只加载 manifest，不运行连接器）
    """
    def __init__(self):
        self._manifests: dict[str, ConnectorManifest] = {}
        self._instances: dict[str, BaseConnector] = {}  # 懒加载的实例

    def discover(self, connectors_dir: str) -> list[ConnectorManifest]:
        """扫描 connectors/ 目录，加载所有 manifest.yaml（不运行代码）"""
        for dir in Path(connectors_dir).iterdir():
            manifest_file = dir / "manifest.yaml"
            if manifest_file.exists():
                manifest = parse_connector_manifest(manifest_file)
                self._manifests[manifest.connector_id] = manifest
        return list(self._manifests.values())

    def get_or_load(self, connector_id: str) -> BaseConnector:
        """懒加载：第一次使用时才导入并实例化连接器"""
        if connector_id not in self._instances:
            manifest = self._manifests[connector_id]
            cls = import_module_class(manifest._runtime_class)
            self._instances[connector_id] = cls()
        return self._instances[connector_id]
```

### 1.4 不可变的请求域上下文（取代可变全局注册表）

OpenClaw `AGENTS.md`：  
`"Treat mutable global runtime registry state as compatibility scaffolding. Prefer immutable or request-scoped handles when adding new runtime flows."`

```python
# 当前（危险）：全局可变状态
EQUIPMENT_TYPE_REGISTRY = {}  # 全局字典，任何代码都能修改

# 改进后：请求级不可变上下文
@dataclass(frozen=True)
class RequestContext:
    """每个 HTTP 请求创建一次，不可修改"""
    user_id: str
    station_ids: frozenset[str]
    role: str
    trace_id: str
    schema_version: str           # 当前加载的 Schema 版本
    effective_policies: tuple     # 当前有效的行动策略（不可变）

# FastAPI Dependency
async def get_request_context(
    user: User = Depends(get_current_user),
    schema_reg: SchemaRegistry = Depends(get_schema_registry),
) -> RequestContext:
    return RequestContext(
        user_id=user.user_id,
        station_ids=frozenset(user.station_ids),
        role=user.role,
        trace_id=request.headers.get("X-Trace-Id", generate_trace_id()),
        schema_version=schema_reg.current_version,
        effective_policies=tuple(schema_reg.get_policies_for(user.role)),
    )
```

### 1.5 轻路径 vs 重路径分离（启动性能）

```
OpenClaw 原则：
"Keep public SDK entrypoints cheap at module load.
 Heavy modules only on *.runtime subpaths"

Nexus 应用：

启动热路径（轻量，< 500ms）：
  · config/settings.py       ← 只加载配置，不连接 DB
  · core/control_plane/      ← 只加载 Schema 定义
  · connectors/manifests/    ← 只发现连接器，不建立连接
  · routers/*.py             ← 只注册路由，不执行任何查询

懒加载路径（重量，按需）：
  · engines/*.runtime.py     ← 实际业务逻辑（FSM 执行/AI 调度）
  · connectors/*.connector.py← 实际连接器实例（建立连接）
  · services/milvus.py       ← Milvus 连接（第一次 KB 查询时才连）
  · services/moirai.py       ← MOIRAI 连接（第一次预测时才连）

启动时间目标：Nexus 健康检查可用 < 2 秒（不等外部服务就绪）
```

---

## 二、借鉴 Kubernetes Controller 模式：Reconciliation Loop

Kubernetes 最核心的理念不是容器，而是**期望状态 vs 实际状态的持续协调**。这对 Nexus 的自动化功能至关重要。

### 2.1 为什么工业 AI 需要 Reconciliation Loop

```
传统工业思维（命令式）：
  操作员发现故障 → 操作员执行操作 → 记录结果

Kubernetes 思维（声明式）：
  定义"期望状态" → Controller 持续检查"实际状态" → 自动协调差异

ClawTwin 的工业 Controller 模式：
  期望状态：所有 P1 告警应在 30 分钟内被确认
  实际状态：P1 告警 #4521 已存在 45 分钟未确认
  Controller 行动：自动升级通知级别，推送给站长
```

### 2.2 Nexus Controller 体系

```python
# core/controllers/base_controller.py

class NexusController(ABC):
    """
    Nexus 控制器基类。
    每个控制器负责一个"期望状态 vs 实际状态"的协调。
    所有控制器独立运行，不互相干预。
    """

    @property
    @abstractmethod
    def controller_id(self) -> str:
        """唯一控制器 ID"""

    @property
    @abstractmethod
    def reconcile_interval_s(self) -> int:
        """协调周期"""

    @abstractmethod
    async def observe(self) -> ControllerState:
        """观察当前实际状态"""

    @abstractmethod
    async def desired(self) -> ControllerState:
        """获取期望状态（从配置/策略/规则）"""

    @abstractmethod
    async def reconcile(self, actual: ControllerState,
                         desired: ControllerState) -> list[DomainEvent]:
        """协调差异，返回需要执行的事件"""

    async def run_once(self):
        """一次协调循环（Scheduler 定期调用）"""
        actual = await self.observe()
        desired_state = await self.desired()
        events = await self.reconcile(actual, desired_state)
        for event in events:
            await event_bus.emit(event)


# 内置控制器列表
class AlarmEscalationController(NexusController):
    """
    期望状态：P1 告警在 30 分钟内确认，P2 在 2 小时内确认
    实际状态：读取当前活跃告警列表
    协调：超时未确认 → 升级通知
    """
    controller_id = "alarm_escalation"
    reconcile_interval_s = 60  # 每分钟检查一次

class AIJobHealthController(NexusController):
    """
    期望状态：所有 queued AI jobs 在 5 分钟内开始处理
    实际状态：读取 ai_jobs 表
    协调：积压 → 告警运维团队；超时 → 重试或失败
    """
    controller_id = "ai_job_health"
    reconcile_interval_s = 30

class KnowledgeQualityController(NexusController):
    """
    期望状态：所有 KBDocument 都应该有向量索引
    实际状态：读取 kb_documents 表，检查 Milvus 是否有对应向量
    协调：有文档但无向量 → 重新触发摄入
    """
    controller_id = "knowledge_quality"
    reconcile_interval_s = 300  # 5分钟检查一次

class DataFreshnessController(NexusController):
    """
    期望状态：所有活跃设备的读数不超过 5 分钟
    实际状态：读取 Redis 中最新读数的时间戳
    协调：数据过旧 → 告警（OT 链路可能断了）
    """
    controller_id = "data_freshness"
    reconcile_interval_s = 60
```

---

## 三、Kafka 作为统一事件总线（不只是 OT 数据管道）

### 3.1 当前问题：两套不兼容的事件机制

```
当前状态：
  OT 数据：OPC-UA Bridge → Kafka → Nexus（已有）
  业务事件：Python 内存 EventBus（仅在单进程内有效）

问题：
  ✗ 业务事件无法持久化（重启丢失）
  ✗ 业务事件无法被外部系统消费（CMMS/ERP 需要实时订阅）
  ✗ 无法回放（调试困难，审计困难）
  ✗ 无法扩展（第二个 Nexus 实例无法共享业务事件）
```

### 3.2 统一事件拓扑（Kafka Topics 设计）

```
Kafka Topic 体系：

  ot.readings.{station_id}          OT 实时数据（已有）
    · Partitioned by equipment_id
    · Retention: 7 days
    · Consumers: IngestPipeline, PulseEngine, AnomalyDetector

  domain.alarms.{station_id}        告警事件
    · All alarm lifecycle events (created/ack/shelved/resolved)
    · Retention: 90 days
    · Consumers: SSE Publisher, Feishu Notifier, CMMS Connector

  domain.workorders.{station_id}    工单事件
    · All work order lifecycle events
    · Retention: 365 days
    · Consumers: SSE Publisher, CMMS Connector, KB L3 Writer

  domain.ai.jobs                     AI 任务事件
    · Queued/Running/Done/Failed events
    · Retention: 30 days
    · Consumers: AI Job Worker, SSE Publisher

  domain.knowledge                   知识库事件
    · Document ingested, search performed events
    · Retention: 90 days
    · Consumers: Analytics, Quality Monitor

  system.health                      系统健康事件
    · Controller reconciliation results
    · Retention: 7 days
    · Consumers: Grafana (external), Alerting

  nexus.commands.{service}           命令总线（CQRS）
    · 跨服务命令（Phase B 微服务化时使用）
```

### 3.3 Kafka Consumer Groups 设计

```python
# 每个消费者组独立消费，互不影响

CONSUMER_GROUPS = {
    "nexus-ingest":        "ot.readings.*",          # 写入 TimescaleDB
    "nexus-pulse":         "ot.readings.*",          # 计算健康分（独立消费）
    "nexus-sse":           "domain.alarms.*, domain.workorders.*, domain.ai.jobs",
    "nexus-feishu":        "domain.alarms.*, domain.workorders.*",
    "nexus-cmms":          "domain.workorders.*",    # CMMS 同步
    "nexus-kb-l3":         "domain.workorders.*",    # 知识回流
    "grafana-connector":   "system.health",          # 外部 Grafana 消费
}

# Phase B：外部系统直接作为 Kafka Consumer
# ERP 系统可以直接订阅 domain.workorders.station_001
# 不需要 Nexus 主动推送（解耦！）
```

---

## 四、TimescaleDB 替代批处理 KPI 任务

### 4.1 当前的低效设计

```python
# 当前（低效）：Scheduler 每15分钟跑一次批处理
@scheduler.scheduled_job("interval", minutes=15)
async def compute_kpi_job():
    for station in await get_active_stations():
        readings = await get_readings_last_24h(station.id)  # 拉取全量数据
        kpi = compute_kpi(readings)                          # CPU 密集计算
        await save_kpi(station.id, kpi)                     # 写回 DB
# 问题：延迟15分钟，计算时 CPU 峰值，无法实时查询
```

### 4.2 TimescaleDB Continuous Aggregates（实时 KPI）

```sql
-- 在 TimescaleDB 中定义连续聚合（Continuous Aggregates）
-- 这些聚合会随着新数据到达自动计算，查询时直接读结果

-- 5分钟级别聚合（实时监控）
CREATE MATERIALIZED VIEW readings_5min
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('5 minutes', timestamp) AS bucket,
    station_id,
    equipment_id,
    metric_name,
    AVG(value) as avg_value,
    MAX(value) as max_value,
    MIN(value) as min_value,
    STDDEV(value) as stddev_value,
    COUNT(*) as sample_count
FROM equipment_readings
GROUP BY 1, 2, 3, 4
WITH NO DATA;

-- 1小时级别聚合（KPI 报表）
CREATE MATERIALIZED VIEW readings_1h
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', timestamp) AS bucket,
    station_id,
    equipment_id,
    metric_name,
    AVG(value) as avg_value,
    MAX(value) as max_value,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY value) as p95_value
FROM equipment_readings
GROUP BY 1, 2, 3, 4
WITH NO DATA;

-- 自动刷新策略
SELECT add_continuous_aggregate_policy('readings_5min',
    start_offset => INTERVAL '1 hour',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');

-- 数据保留策略（自动清理）
SELECT add_retention_policy('equipment_readings', INTERVAL '90 days');
SELECT add_retention_policy('readings_5min', INTERVAL '1 year');
SELECT add_retention_policy('readings_1h', INTERVAL '5 years');
```

```python
# Nexus API：KPI 查询直接读连续聚合（毫秒级响应）

@router.get("/v1/analytics/kpi")
async def get_station_kpi(
    station_id: str,
    period: str = "1d",
    ctx: RequestContext = Depends(get_request_context),
    db: AsyncSession = Depends(get_db),
):
    """
    直接查询 TimescaleDB Continuous Aggregate，无需批处理。
    响应时间 < 100ms，实时准确。
    """
    period_map = {"1h": "readings_1h", "1d": "readings_1h", "7d": "readings_1h"}
    view = period_map.get(period, "readings_1h")

    result = await db.execute(
        f"""
        SELECT equipment_id, metric_name, AVG(avg_value), MAX(max_value)
        FROM {view}
        WHERE station_id = :station_id
          AND bucket >= NOW() - INTERVAL '1 {period[1:]}'
        GROUP BY equipment_id, metric_name
        """,
        {"station_id": station_id}
    )
    return ok(result.mappings().all())
```

---

## 五、Studio 架构升级：从"工业 SCADA"到"工业 AI 工作台"

### 5.1 借鉴 Grafana 的数据源抽象

Grafana 最聪明的设计：**Dashboard 不知道数据从哪来，只知道怎么显示**。

```typescript
// Studio 数据源抽象（类比 Grafana Data Source）
// studio/src/datasources/types.ts

export interface DataSource {
  id: string;
  name: string;

  // 查询接口（统一，不管数据来自哪里）
  query(query: DataQuery): Promise<DataFrame[]>;

  // 实时订阅接口
  subscribe(query: DataQuery, callback: (data: DataFrame) => void): Unsubscribe;

  // 健康检查
  testConnection(): Promise<{ ok: boolean; message: string }>;
}

// 实现 1：Nexus HTTP API
class NexusDataSource implements DataSource {
  id = "nexus";
  async query(q: DataQuery): Promise<DataFrame[]> {
    const response = await nexusClient.get(q.endpoint, q.params);
    return transformToDataFrames(response.data);
  }
  subscribe(q: DataQuery, callback) {
    const sse = new EventSource(`${NEXUS_URL}/v1/sse/${q.entity}`);
    sse.onmessage = (e) => callback(JSON.parse(e.data));
    return () => sse.close();
  }
}

// 实现 2：TimescaleDB 直连（Phase B，只读副本）
class TimeseriesDataSource implements DataSource {
  id = "timeseries";
  async query(q: DataQuery): Promise<DataFrame[]> {
    // 直接查 TimescaleDB，绕过 Nexus API（只读场景）
  }
}

// 实现 3：Mock（开发测试用）
class MockDataSource implements DataSource {
  id = "mock";
  async query(q: DataQuery): Promise<DataFrame[]> {
    return generateMockData(q);
  }
}
```

### 5.2 Studio Panel 插件系统（类比 Grafana Panels）

```typescript
// Studio 组件注册表——让 Studio 可以接受第三方组件
// studio/src/panels/registry.ts

export interface StudioPanel {
  panelId: string;
  displayName: string;

  // 组件本体
  component: React.ComponentType<PanelProps>;

  // 面板配置 Schema（控制面：在渲染前就能知道需要什么配置）
  configSchema: JSONSchema;

  // 支持的数据类型
  acceptsDataTypes: DataType[];

  // 最小尺寸（用于布局引擎）
  minWidth: number;
  minHeight: number;
}

// 内置面板
const BUILTIN_PANELS: StudioPanel[] = [
  // 时序图
  { panelId: "timeseries-chart", component: TimeseriesChart, ... },
  // 设备健康卡片
  { panelId: "equipment-health", component: EquipmentHealthCard, ... },
  // 3D 数字孪生
  { panelId: "digital-twin-3d", component: TwinSurface, ... },
  // P&ID 流程图
  { panelId: "pid-diagram", component: PIDDiagram, ... },
  // 告警列表
  { panelId: "alarm-list", component: AlarmList, ... },
  // 工单面板
  { panelId: "workorder-panel", component: WorkOrderPanel, ... },
  // AI 洞察卡片
  { panelId: "ai-insight", component: AIInsightCard, ... },
  // KPI 仪表盘
  { panelId: "kpi-gauge", component: KPIGauge, ... },
  // 舰队地图
  { panelId: "fleet-map", component: FleetMap, ... },
];

// 面板注册表（Phase B：支持第三方注册）
class PanelRegistry {
  private panels = new Map<string, StudioPanel>();

  register(panel: StudioPanel): void {
    if (this.panels.has(panel.panelId)) {
      throw new Error(`Panel ${panel.panelId} already registered`);
    }
    this.panels.set(panel.panelId, panel);
  }

  get(panelId: string): StudioPanel {
    const panel = this.panels.get(panelId);
    if (!panel) throw new Error(`Unknown panel: ${panelId}`);
    return panel;
  }
}
```

### 5.3 Studio 布局引擎（Saved Views + 角色定制）

```typescript
// 布局定义（存储在 DB，每个用户/角色可定制）
// studio/src/layouts/types.ts

export interface DashboardLayout {
  layoutId: string;
  name: string;
  role: "operator" | "engineer" | "manager" | "admin";

  panels: PanelPlacement[];

  // 默认实体上下文
  defaultStation?: string;
  defaultEquipment?: string;
}

export interface PanelPlacement {
  panelId: string;           // 对应 StudioPanel.panelId
  dataQuery: DataQuery;      // 这个面板查询什么数据
  config: Record<string, unknown>; // 面板特定配置

  // 布局（CSS Grid 坐标）
  col: number;   // 0-11（12列网格）
  row: number;
  colSpan: number;
  rowSpan: number;
}

// 预设布局（随系统发布）
const PRESET_LAYOUTS: DashboardLayout[] = [
  {
    layoutId: "operator-default",
    name: "操作员工作台",
    role: "operator",
    panels: [
      { panelId: "equipment-health", col: 0, row: 0, colSpan: 3, rowSpan: 2, ... },
      { panelId: "alarm-list", col: 3, row: 0, colSpan: 4, rowSpan: 4, ... },
      { panelId: "digital-twin-3d", col: 7, row: 0, colSpan: 5, rowSpan: 4, ... },
      { panelId: "ai-insight", col: 0, row: 2, colSpan: 3, rowSpan: 2, ... },
    ],
  },
  {
    layoutId: "manager-fleet",
    name: "管理层舰队视图",
    role: "manager",
    panels: [
      { panelId: "fleet-map", col: 0, row: 0, colSpan: 8, rowSpan: 4, ... },
      { panelId: "kpi-gauge", col: 8, row: 0, colSpan: 4, rowSpan: 2, ... },
      { panelId: "alarm-list", col: 8, row: 2, colSpan: 4, rowSpan: 2, ... },
    ],
  },
];
```

### 5.4 Studio 实时数据架构（Phase A → Phase B 演进）

```
Phase A（SSE，已有）：
  Studio → 长连接 SSE → Nexus SSE Endpoint → Redis → 推送
  问题：N 个 Studio 用户 = N 个 SSE 连接 = N * Redis 轮询

Phase B（WebSocket + Room 模式，Socket.IO 范式）：
  Studio → WebSocket → Nexus WS Gateway
                           ↓
                        Room: "station:station_001"
                           ↓
                       Kafka Consumer（每个 Room 一个 Consumer Group）
                           ↓
                       广播给同一 Room 的所有连接

  优点：N 个用户看同一站场 = 1 个 Kafka Consumer = N 次广播
  对比 SSE：N 个用户 = N 个 Redis 轮询（线性增长 vs 常数）

Phase B 实现（FastAPI WebSocket + Kafka）：

  class StationRoom:
      def __init__(self, station_id: str):
          self.station_id = station_id
          self.connections: set[WebSocket] = set()
          self.kafka_consumer: KafkaConsumer = None

      async def start(self):
          """启动 Kafka 消费者，广播给 Room 内所有 WebSocket"""
          self.kafka_consumer = create_consumer(
              topics=[f"domain.alarms.{self.station_id}",
                      f"domain.workorders.{self.station_id}",
                      f"ot.readings.{self.station_id}"],
              group_id=f"studio-room-{self.station_id}"
          )
          async for message in self.kafka_consumer:
              await self.broadcast(message)

      async def broadcast(self, message: dict):
          dead_connections = []
          for ws in self.connections:
              try:
                  await ws.send_json(message)
              except WebSocketDisconnect:
                  dead_connections.append(ws)
          for ws in dead_connections:
              self.connections.discard(ws)
```

---

## 六、不重复开发：与成熟系统的最佳集成

### 6.1 Grafana 作为分析层（不自建分析 Dashboard）

```
错误做法：在 Studio 里自建 KPI 图表组件（Chart.js / ECharts）
正确做法：Grafana 处理分析，Studio 处理操作

职责划分：
  Studio 负责：                      Grafana 负责：
  · 设备实时状态（Twin View）        · KPI 历史趋势（时序图）
  · 工单管理（HITL）                 · 告警频率统计（柱状图）
  · 告警确认（操作）                  · 设备稼动率分析（饼图/面积图）
  · AI 诊断结果（操作）              · 系统健康监控（Prometheus）
  · P&ID 操作界面                    · 对比分析（多站场/多设备）

Studio 嵌入 Grafana Panel（iframe，统一导航）：
  <GrafanaPanel
    dashboardId="station-kpi"
    panelId={42}
    variables={{ station_id: selectedStation }}
  />
```

### 6.2 TimescaleDB 数据保留 + 压缩策略

```sql
-- 利用 TimescaleDB 的分层存储，不自建数据归档

-- 热数据：最近 7 天，无压缩，快速查询
-- 温数据：7天-90天，压缩（节省 10x 存储）
-- 冷数据：90天-5年，归档到 S3/本地对象存储（MinIO）

-- 压缩策略
ALTER TABLE equipment_readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'station_id, equipment_id, metric_name',
  timescaledb.compress_orderby = 'timestamp DESC'
);

SELECT add_compression_policy('equipment_readings', INTERVAL '7 days');

-- 分层存储（Phase B）：将旧数据移到 MinIO（S3 兼容）
SELECT add_tiering_policy('equipment_readings', INTERVAL '90 days');
```

### 6.3 Prometheus + AlertManager 用于技术运维告警（与 ISA 工业告警分离）

```yaml
# prometheus/alerts.yml
# 技术运维告警（和工业 ISA 告警是两个独立系统）

groups:
  - name: nexus_health
    rules:
      - alert: NexusAPILatencyHigh
        expr: http_request_duration_seconds{quantile="0.95"} > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Nexus API P95 延迟 > 500ms"

      - alert: KafkaConsumerLag
        expr: kafka_consumer_group_lag > 10000
        for: 5m
        annotations:
          summary: "Kafka 消费者积压，可能有 OT 数据延迟"

      - alert: IngestDropRateHigh
        expr: nexus_ingest_drop_rate > 0.01
        for: 10m
        annotations:
          summary: "IngestPipeline 丢弃率 > 1%，读数可能丢失"

      - alert: AIJobQueueDepth
        expr: nexus_ai_job_queue_depth > 100
        for: 5m
        annotations:
          summary: "AI 任务积压，GPU 服务器可能过载"

# AlertManager 通知：只给 IT 运维团队
# 工业告警（P1/P2/P3）由 Nexus 通过飞书通知操作员
# 两套告警系统互不干扰
```

---

## 七、完整模块边界重定义（权威版 V2）

### 7.1 Nexus 目录结构（最终版）

```
platform-api/
├── core/                          ← 框架核心（无工业逻辑）
│   ├── control_plane/
│   │   ├── schema_registry.py    Schema 注册/热重载
│   │   ├── connector_registry.py 连接器发现/懒加载
│   │   └── policy_registry.py   行动策略管理
│   ├── runtime/
│   │   ├── fsm_executor.py      通用 FSM 执行（读 YAML 定义）
│   │   ├── object_store.py      通用对象存储
│   │   └── timeseries_store.py  通用时序存储
│   ├── event/
│   │   ├── event_bus.py         内存事件总线（Phase A）
│   │   ├── kafka_bus.py         Kafka 事件总线（Phase B）
│   │   └── events.py            事件类型定义
│   └── security/
│       ├── abac.py              属性访问控制
│       ├── jwt_utils.py         JWT 签发/验证
│       └── audit.py            审计日志
│
├── domains/                       ← 工业领域包（商业 IP）
│   ├── equipment/
│   │   ├── schema.yaml          设备类型定义（控制面）
│   │   ├── models.py            ORM 模型（运行面）
│   │   ├── repository.py        数据访问
│   │   ├── service.py           业务逻辑
│   │   └── router.py            API 路由
│   ├── workorder/
│   │   ├── fsm.yaml             工单状态机定义（控制面，可热更新）
│   │   ├── models.py
│   │   ├── service.py
│   │   └── router.py
│   ├── alarm/
│   │   ├── policy.yaml          ISA-18.2 告警策略（控制面）
│   │   ├── models.py
│   │   ├── service.py
│   │   └── router.py
│   ├── knowledge/
│   │   ├── models.py
│   │   ├── service.py           RAG 检索 + 摄入
│   │   └── router.py
│   └── station/
│       ├── models.py
│       └── router.py
│
├── engines/                       ← 智能引擎层
│   ├── pulse/
│   │   ├── pulse_engine.py      Pulse Engine 主逻辑
│   │   └── health_strategies/   可插拔的健康评分策略
│   │       ├── base.py
│   │       └── isa18_2.py       ISA-18.2 实现
│   ├── intelligence/
│   │   ├── ai_job_runtime.py    AI 任务持久运行时（TaskFlow 模式）
│   │   └── ai_job_worker.py    后台 Worker
│   ├── ingest/
│   │   ├── ingest_pipeline.py  数据摄入管道
│   │   └── stream_processor.py 流处理（窗口/聚合）
│   └── controllers/             Reconciliation Loop 控制器
│       ├── alarm_escalation.py
│       ├── ai_job_health.py
│       ├── knowledge_quality.py
│       └── data_freshness.py
│
├── connectors/                    ← 连接器（nexus-sdk 实现）
│   ├── opcua/
│   │   ├── manifest.yaml        连接器描述符
│   │   └── opcua_connector.py   实现
│   ├── feishu_oa/
│   │   ├── manifest.yaml
│   │   └── feishu_oa_connector.py
│   ├── cmms_generic/
│   │   ├── manifest.yaml
│   │   └── cmms_connector.py
│   └── mock/
│       ├── manifest.yaml
│       └── mock_connector.py
│
├── contracts/                     ← API 契约（Sage-Nexus 接口）
│   ├── sage-nexus-tool-api-v1.yaml  Tool API 契约定义
│   ├── tests/
│   │   ├── test_tool_api_contract.py  契约测试
│   │   └── test_event_contract.py
│   └── CHANGELOG.md               契约变更日志
│
└── routers/                       ← FastAPI 路由（简洁，委托给 domains/engines）
    ├── auth.py
    ├── sse.py                    SSE 实时推送
    ├── ws.py                     WebSocket（Phase B）
    └── health.py                 健康检查 + 指标
```

### 7.2 Studio 目录结构（最终版）

```
clawtwin-studio/
├── src/
│   ├── datasources/               ← 数据源抽象层
│   │   ├── types.ts              DataSource 接口定义
│   │   ├── nexus.datasource.ts   Nexus HTTP API 数据源
│   │   ├── timeseries.datasource.ts TimescaleDB 直连（Phase B）
│   │   └── mock.datasource.ts    Mock 数据源（开发用）
│   │
│   ├── panels/                    ← 面板插件系统
│   │   ├── registry.ts           Panel 注册表
│   │   ├── types.ts              StudioPanel 接口
│   │   ├── timeseries-chart/     时序图面板
│   │   ├── equipment-health/     设备健康卡片
│   │   ├── digital-twin-3d/      3D 孪生面板
│   │   ├── pid-diagram/          P&ID 面板
│   │   ├── alarm-list/           告警列表面板
│   │   ├── workorder-panel/      工单面板
│   │   ├── ai-insight/           AI 洞察面板
│   │   ├── kpi-gauge/            KPI 仪表面板
│   │   └── fleet-map/            舰队地图面板
│   │
│   ├── layouts/                   ← 布局引擎
│   │   ├── engine.tsx            布局引擎（CSS Grid）
│   │   ├── preset-layouts.ts     预设布局（操作员/工程师/管理层）
│   │   └── layout-editor.tsx     布局编辑器（Phase B，拖拽）
│   │
│   ├── realtime/                  ← 实时数据管理
│   │   ├── sse-client.ts         SSE 客户端（Phase A）
│   │   ├── ws-client.ts          WebSocket 客户端（Phase B）
│   │   └── store/
│   │       ├── realtime.store.ts 实时数据 Zustand Store
│   │       └── sync-engine.ts    数据同步引擎
│   │
│   ├── pages/                     ← 页面（使用 Panel + Layout）
│   │   ├── Station/              站场操作页
│   │   ├── Equipment/            设备详情页
│   │   ├── Fleet/                舰队视图页（管理层）
│   │   ├── Command/              全屏指挥视图
│   │   ├── Knowledge/            知识库页
│   │   ├── Admin/                管理员后台
│   │   └── Settings/             用户设置
│   │
│   └── hooks/                     ← 通用 Hooks
│       ├── useEquipment.ts
│       ├── useAlarms.ts
│       ├── useWorkOrders.ts
│       └── useAIJob.ts            AI 任务状态管理（轮询+SSE）
```

---

## 八、接口完整定义（V2，对齐架构升级）

### 8.1 控制面 API（Schema / Policy / Connector 管理）

```
GET    /v1/schema/object-types              列出所有已注册对象类型
GET    /v1/schema/object-types/{type_id}   获取对象类型定义
POST   /v1/schema/object-types             注册新对象类型（Admin）
PUT    /v1/schema/object-types/{type_id}   更新对象类型定义（热重载）

GET    /v1/schema/fsm/{entity_type}        获取 FSM 定义（工单/告警）

GET    /v1/connectors                      列出已安装连接器（manifest 信息）
GET    /v1/connectors/{id}/status          连接器当前连接状态
POST   /v1/connectors/{id}/test            测试连接器连接
PUT    /v1/admin/connectors/{id}/config    配置连接器参数（Admin）

GET    /v1/policies/actions                列出所有行动策略
POST   /v1/admin/policies                  创建新行动策略（需 manager 审批）
```

### 8.2 Sage → Nexus Tool API（契约版 V1）

```
# 数据读取类（Service Token 认证）
GET    /v1/tools/equipment/{id}/context       设备上下文快照
GET    /v1/tools/station/{id}/overview        站场全局概览
GET    /v1/tools/readings/{id}/timeseries     设备历史时序数据
GET    /v1/tools/alarms?equipment_id=&active= 告警查询

# 知识类
POST   /v1/tools/kb/search                    RAG 检索（L0-L3）
POST   /v1/tools/kb/relate                    知识关联查询（设备型号→相关文档）

# 写入类（AI 执行结果持久化）
POST   /v1/tools/workorders/ai-draft          创建 AI 工单草稿
POST   /v1/tools/alarms/{id}/ai-note          AI 为告警添加分析备注
POST   /v1/tools/kb/l3-fragment               写入 L3 经验知识片段

# AI 任务生命周期（对齐 OpenClaw TaskFlow）
PUT    /v1/tools/ai-jobs/{job_id}/progress    更新 AI 任务进度
PUT    /v1/tools/ai-jobs/{job_id}/result      提交 AI 任务结果
PUT    /v1/tools/ai-jobs/{job_id}/fail        标记 AI 任务失败
```

### 8.3 Studio → Nexus（User JWT 认证）

```
# 实时数据
GET    /v1/sse/station/{id}                  Station SSE 流（Phase A）
WS     /v1/ws/station/{id}                   Station WebSocket（Phase B）
GET    /v1/equipment/{id}/readings/latest    最新读数（Redis 直出）

# 操作类（触发业务）
POST   /v1/ai/jobs                           提交 AI 任务（返回 job_id）
GET    /v1/ai/jobs/{job_id}                  查询 AI 任务状态
DELETE /v1/ai/jobs/{job_id}                  取消 AI 任务

POST   /v1/workorders/{id}/submit            提交审批
POST   /v1/workorders/{id}/approve           审批（manager）
POST   /v1/workorders/{id}/reject            驳回（manager）
POST   /v1/workorders/{id}/start             开始执行（operator）
POST   /v1/workorders/{id}/complete          完成工单（含 ai_was_correct 字段）

POST   /v1/alarms/{id}/acknowledge           确认告警
POST   /v1/alarms/{id}/shelve                屏蔽告警
POST   /v1/alarms/{id}/resolve               解除告警

# 分析（读 TimescaleDB Continuous Aggregates，极快）
GET    /v1/analytics/kpi                     站场 KPI（< 100ms）
GET    /v1/analytics/alarm-stats             告警统计
GET    /v1/analytics/ai-accuracy             AI 准确率报告
GET    /v1/analytics/fleet                   舰队对比（管理层）
```

---

## 九、批判性总结：设计的真正挑战

```
不要做的事（避免重复造轮子）：
  ✗ 自建时序 KPI 批处理 → 用 TimescaleDB Continuous Aggregates
  ✗ 自建技术运维监控 → 用 Prometheus + Grafana + AlertManager
  ✗ 自建消息队列 → 用 Kafka（已有，扩展用途）
  ✗ 自建数据归档 → 用 TimescaleDB 分层存储 + MinIO
  ✗ 自建工作流引擎 → 用 OpenClaw TaskFlow 模式（借鉴）
  ✗ 自建分析仪表盘 → 嵌入 Grafana Panels

必须做的事（真正的核心 IP）：
  ✓ 工业语义本体（Ontology Engine）← 竞争壁垒
  ✓ 工业 HITL 工单 FSM（人机协作流程）← 竞争壁垒
  ✓ Sage Prompt 工程（行业专家知识的结构化）← 竞争壁垒
  ✓ 控制面/运行面分离（Nexus 框架化）← 长期价值
  ✓ 数据飞轮机制（跨站场匿名知识积累）← 最终护城河
  ✓ Studio 体验层（工业操作员的 JARVIS 界面）← 用户黏性

架构先进性的判断标准：
  1. 新加一个设备类型需要多少代码？← 目标：只改 YAML
  2. 新加一个连接器需要改多少核心代码？← 目标：0 行
  3. 新客户上线需要多少定制开发？← 目标：< 5 天
  4. AI 模型升级需要改多少业务代码？← 目标：0 行（换 Prompt 模板）
  5. 10个站场 vs 1个站场，性能差多少？← 目标：线性可扩展
```

---

_本文档创建于 2026-05-11，是 ClawTwin 架构从 Phase A MVP 演进到 Phase B 生产级的完整路线图。_  
_Phase A 团队：重点关注 §一（控制面分离）和 §三（Kafka 统一事件总线）打好基础。_  
_Phase B 团队：实施 §二（Controller 模式）、§四（Continuous Aggregates）、§五（Studio 数据源抽象）。_
