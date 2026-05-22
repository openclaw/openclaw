# CLAWTWIN-RESOURCE-ARCHITECTURE — 扩展资源架构总览

**地位**: 🟢 核心 / Architecture / Authoritative  
**版本**: v1.0.0 (2026-05-13)  
**关联**:

- [`INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`](INDUSTRIAL-FOUNDRY-ARCHITECTURE.md) — Foundry 范式定义
- [`CLAWTWIN-EXTENSION-MANIFESTO.md`](CLAWTWIN-EXTENSION-MANIFESTO.md) — 五条内在法则
- [`CLAWTWIN-PHYSICS-FOUNDATIONS.md`](CLAWTWIN-PHYSICS-FOUNDATIONS.md) — 数字孪生数学基础
- [`CLAWTWIN-AI-FIRST-PRINCIPLES.md`](CLAWTWIN-AI-FIRST-PRINCIPLES.md) — AI 工程准则

---

## 一、为什么需要这份文档？

OpenClaw 是一个"按扩展资源组装的产品"，它对外提供 8 类扩展轴：

```
channel  /  agent  /  provider  /  skill  /  mcp  /  plugin  /  acp  /  hook
```

每一类扩展轴都遵循同一三段式契约 — `define_*` + `register_*` + `runtime`。  
这是 OpenClaw 长出 38+ channel/provider 而不爆炸的关键。

ClawTwin 对应着工业领域，**它的扩展轴比 OpenClaw 还多**：除了复用 OpenClaw 的 8 类
（channel/agent/provider/...）外，ClawTwin 自己还要承载 8 类工业本体相关的扩展轴：

```
ObjectType  /  LinkType  /  ActionType  /  FunctionType  /
Connector  /  Pipeline  /  Playbook  /  IndustryPack
```

在 v1.0 之前，这些扩展资源散落在三个不同的发现机制里：

| 资源类别     | 旧的存放方式                           | 缺陷                          |
| ------------ | -------------------------------------- | ----------------------------- |
| ObjectType   | `ontology/object_types/*.yaml`         | 只能通过文件扫描发现          |
| ActionType   | `core/action_executor/handlers/*.py`   | 无 manifest，只能 import 全扫 |
| Connector    | `connectors/<id>/__init__.py`          | 各自独立无统一接口            |
| FunctionType | `core/function_executor/handlers/*.py` | 同 ActionType                 |
| Pipeline     | 仅文档                                 | 未实现                        |
| Playbook     | 仅 ADR                                 | 未实现                        |

**结果**：第三方厂商或 IndustryPack 作者无路可走 — 想加一个 `Compressor` ObjectType
必须改 `ontology/` 源码；想加一个 `wonderware_historian` Connector 必须改 `connectors/`
源码。这违反了"开放-封闭原则"，也违反了 OpenClaw 给我们树立的扩展架构榜样。

v1.0 引入的 **`core/extension_registry/`** 修复了这一点。

---

## 二、ClawTwin 的扩展资源轴（Resource Axes）

```
┌────────────────────────────────────────────────────────────────────┐
│                  OpenClaw 通用 AI 资源（8 类，已存在）              │
├────────────────────────────────────────────────────────────────────┤
│  channel  agent  provider  skill  mcp  plugin  acp  hook           │
│  通过 OpenClaw plugin SDK 直接复用,ClawTwin 不需要重造              │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│           ClawTwin 工业本体资源（8 类，本文档主题）                 │
├──────────────┬─────────────────────────────────────────────────────┤
│ ObjectType   │ 业务实体（Equipment / WorkOrder / Alarm / ...）     │
│ LinkType     │ 实体关系（flows_to / monitors / triggered_by ...）  │
│ ActionType   │ 副作用操作（acknowledge_alarm / create_work_order） │
│ FunctionType │ 纯计算/AI 推理（diagnose_equipment / recommend_*）  │
│ Connector    │ 数据面集成（OPC-UA / Modbus / Webhook / ERP ...）   │
│ Pipeline     │ 数据变换流（workorder→l3_knowledge / readings→fft） │
│ Playbook     │ 业务编排（alarm→workorder / weekly_inspection）     │
│ IndustryPack │ 行业打包（oilgas_pack / power_grid_pack）           │
└──────────────┴─────────────────────────────────────────────────────┘
```

**对照 OpenClaw**：OpenClaw 的扩展轴关心"AI 怎么和世界对话"；ClawTwin 的扩展轴关心
"工业系统怎么被结构化、被自动化、被改进"。两组扩展轴正交互补，**没有重复**。

---

## 三、统一契约：`ResourceManifest`

每一种扩展资源都实现同一份基底契约（`core/extension_registry/__init__.py`）：

```python
@dataclass(frozen=True)
class ResourceManifest:
    id: str                        # 在 (resource, namespace) 内唯一
    resource: Resource             # 8 类资源轴之一
    version: str                   # SemVer
    provided_by: str               # "core" | "extension:<name>" | "industry_pack:<name>"
    title: str = ""
    description: str = ""
    capability: str | None = None  # 关联的 Capability 枚举值；None=always-on
    dependencies: tuple[str, ...] = ()
    labels: dict[str, str] = field(default_factory=dict)
    schema_ref: str = ""
    experimental: bool = False
```

每一种资源还有自己的"类型特定字段"（继承 `ResourceManifest`）：

| 资源                   | 关键字段（除 base 外）                                             |
| ---------------------- | ------------------------------------------------------------------ |
| `ObjectTypeManifest`   | `primary_key`, `properties`, `sot_strategy`                        |
| `LinkTypeManifest`     | `from_object_type`, `to_object_type`, `cardinality`                |
| `ActionTypeManifest`   | `target_object_type`, `risk_level`, `approval_required`, `handler` |
| `FunctionTypeManifest` | `inputs`, `outputs`, `handler`, `requires_ai`                      |
| `ConnectorManifest`    | `category`, `direction`, `transport`                               |
| `PipelineManifest`     | `triggers`, `steps`                                                |
| `PlaybookManifest`     | `triggers`, `steps_count`                                          |
| `IndustryPackManifest` | `industry`, `bundled_resources`                                    |

---

## 四、Registry 运行时

### 4.1 进程内单例

```python
from core.extension_registry import register, list_resources, Resource

# 启动时注册（main.py 会调用 register_builtin_resources()）
register(ObjectTypeManifest(id="Equipment", resource=Resource.OBJECT_TYPE, ...))

# 任何地方查询
items = list_resources(resource=Resource.OBJECT_TYPE)        # 全部 ObjectType
items = list_resources(respect_capabilities=True)            # 仅当前启用的
```

### 4.2 Capability 联动

`list_resources(respect_capabilities=True)` 会自动剔除"capability 已禁用"的资源。
这意味着：**当 `CLAWTWIN_INGEST=0` 时,`opcua_generic` Connector 会从 `/v1/extensions`
自动消失**——前端工具/IndustryPack 安装器不会看到不能用的资源。

这是 OpenClaw 的相同模式：禁用 `feishu` channel 后,`bot.feishu.*` 工具集自然消失。

### 4.3 幂等注册

同一 `(resource, id)` 的 manifest 被同 version + 同 provided_by 重复注册时，是
no-op；版本/来源不一致时，会发 warning 并以最后一次为准。

### 4.4 线程安全

`_Registry` 使用 `RLock`,启动期 `register()` 与运行期 `list_resources()` 安全
并存（FastAPI 启动 + heartbeat scheduler + worker 进程都共用一个 registry）。

---

## 五、`GET /v1/extensions` HTTP 接口

```
GET /v1/extensions
GET /v1/extensions?resource=object_type
GET /v1/extensions?respect_capabilities=false
```

返回结构：

```json
{
  "items": [
    {
      "id": "Equipment",
      "resource": "object_type",
      "version": "1.0.0",
      "provided_by": "core",
      "title": "设备",
      "description": "物理设备实例（泵/压缩机/罐体等）",
      "capability": null,
      "dependencies": [],
      "labels": {},
      "schema_ref": "ontology/object_types/equipment.yaml",
      "experimental": false
    },
    ...
  ],
  "count": 18,
  "categories": [
    "action_type", "connector", "function_type", "industry_pack",
    "link_type", "object_type", "pipeline", "playbook"
  ],
  "schema_version": 1
}
```

### 5.1 Studio 用途

- **资源浏览器**: 一个全局"系统能力清单"页面 — 列出所有 ObjectType / Action /
  Connector,告诉运维"这个站点有哪些可用工具"
- **IndustryPack 安装预览**: 安装一个 pack 前,先 diff 远端 manifest 与本地
  registry,看会带来哪些新资源、覆盖哪些既有资源
- **依赖可视化**: 用 `dependencies` 字段画一张资源依赖图（Equipment ← WorkOrder
  ← OutcomeEvent）

### 5.2 第三方/自动化用途

- **前端 Studio 决策包页面**根据 `capability` 字段决定哪些 UI 卡片要渲染
- **CI 校验**: PR 引入新 ObjectType 时,自动生成 manifest diff,贴到 PR review

---

## 六、Headless 最小核（实验证明）

ClawTwin 的所有扩展资源都可以全部禁用,系统仍能完成最小工业闭环：

```bash
$ CLAWTWIN_AUTH_DEV=1 \
  CLAWTWIN_CAPABILITIES="-ai,-ingest,-export,-outcome_tracking,-recommendations,-health_vector,-causal_graph,-kb,-playbook" \
  python -c "from core.extension_registry import list_resources
             from core.extension_registry.builtin import register_builtin_resources
             register_builtin_resources()
             [print(m.resource.value, m.id) for m in list_resources()]"

action_type    acknowledge_alarm
action_type    create_work_order
link_type      flows_to
link_type      monitors
link_type      triggered_by
object_type    Alarm
object_type    Equipment
object_type    EquipmentReading
object_type    OperatingContext
object_type    WorkOrder
```

**10 个资源构成的最小核**就是工业控制场景的"原子集合"：

- 设备 + 读数 + 工况上下文（数据维度）
- 告警（异常感知）
- 工单（人工干预闭环）
- 物料流向 + 监测关系 + 工单源告警（关系网络）
- 确认告警 + 派发工单（可执行操作）

这些资源 `capability=None`,**永远可用**。它们是 ClawTwin 的"原子论":整个系统就
像物质世界一样可由有限种基本粒子组装出无限种行为。

---

## 七、扩展资源 vs Capability vs Plugin 三者关系

许多人会把这三个概念搞混,这里用一张矩阵讲清楚：

| 维度         | 资源（Resource）             | 能力（Capability）                 | 插件（Plugin / Pack）              |
| ------------ | ---------------------------- | ---------------------------------- | ---------------------------------- |
| **是什么**   | 一个 manifest 描述的扩展点   | 一组功能特性的开关                 | 资源 + 代码 + 数据的打包           |
| **粒度**     | 单一概念（一个 ObjectType）  | 一组功能（INGEST 含 4 个 API）     | 多个资源（IndustryPack 带 ~50 个） |
| **生命周期** | 启动期注册                   | 进程启动期通过 env 决定            | 安装/卸载（运行期可热插拔）        |
| **示例**     | `Equipment`, `opcua_generic` | `ai`, `ingest`, `outcome_tracking` | `oil_gas_pack`, `power_grid_pack`  |

**关系**：

- 一个 **Plugin/Pack** 可以注册多个 **Resource**
- 一个 **Resource** 可以声明依赖一个 **Capability**(`capability=` 字段)
- 一个 **Capability** 可以"门控"多个 **Resource**(关闭 `ingest` 同时隐藏所有
  Connector + Ingest API + Studio 上传按钮)

---

## 八、IndustryPack 作者快速指南

要发布一个 `oil_gas_pack`,作者需要：

```python
# my_pack/__init__.py
from core.extension_registry import (
    ObjectTypeManifest, ActionTypeManifest, ConnectorManifest,
    IndustryPackManifest, Resource, register,
)

def install():
    register(ObjectTypeManifest(
        id="Compressor",
        resource=Resource.OBJECT_TYPE,
        version="1.0.0",
        provided_by="industry_pack:oil_gas_pack",
        title="压缩机",
        properties=("id", "rated_power_kw", "stage_count"),
        labels={"industry": "oil_gas"},
    ))
    register(ConnectorManifest(
        id="emerson_ams_machinery",
        resource=Resource.CONNECTOR,
        version="1.0.0",
        provided_by="industry_pack:oil_gas_pack",
        category="historian",
        transport="rest",
        capability="ingest",
    ))
    # ... 注册自己的 ActionType / FunctionType / Pipeline
    register(IndustryPackManifest(
        id="oil_gas_pack",
        resource=Resource.INDUSTRY_PACK,
        version="1.0.0",
        provided_by="industry_pack:oil_gas_pack",
        industry="oil_gas",
        bundled_resources=("Compressor", "emerson_ams_machinery", ...),
    ))
```

`install()` 在系统启动时调用即可;manifest 立刻出现在 `GET /v1/extensions`,
Studio 即可发现并展示。**不需要改 ClawTwin 核心代码**。

---

## 九、自洽性检验（与五条法则的关系）

| 法则                         | 资源架构如何遵守                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| **L1 Ontology Conservation** | 所有 ObjectType/LinkType 必须在 registry 中可见;新建一个 ObjectType 必须先注册 manifest                   |
| **L2 Event Causality**       | ActionType.handler 执行的副作用必须经 EventDispatcher,registry 不允许声明"无副作用且无审计的 ActionType"  |
| **L3 Data Conservation**     | EquipmentReading manifest 标注 `sot_strategy="upstream_master"`,提示 SoT 不在平台,删除/修改要走数据所有者 |
| **L4 Read-Write Symmetry**   | manifest 自身就是"读"接口（GET /v1/extensions）和"写"接口（register()）的对称镜像                         |
| **L5 Minimum Energy**        | 资源 `capability=` 字段直接驱动 `respect_capabilities=True` 的过滤;不启用就不展示                         |

**结论**：扩展资源架构既是 ClawTwin 的"开放扩展面",也是五条法则的"具象表达"。

---

## 十、当前状态

| 任务                                         | 状态                                              |
| -------------------------------------------- | ------------------------------------------------- |
| `ResourceManifest` 基底 + 8 种子类型         | ✅ 已实现 (`core/extension_registry/__init__.py`) |
| Registry 运行时 (register/list/get/线程安全) | ✅ 已实现                                         |
| 内置资源 manifest 注册 (20 个)               | ✅ 已实现 (`core/extension_registry/builtin.py`)  |
| `GET /v1/extensions` API + capability 门控   | ✅ 已实现 (`apps/http/main.py`)                   |
| Smoke 测试 — 完整 dev / 完全 headless        | ✅ 已通过（10/20 完全 headless 仍闭环）           |
| 把现有 YAML ObjectType 映射到 manifest       | 🟡 已手动映射 7 个核心 ObjectType,自动扫描留 v1.1 |
| Studio 资源浏览器页面                        | ⚪ 未做（v1.2 候选）                              |
| IndustryPack 热插拔运行时                    | ⚪ 未做（Phase B）                                |

---

## 十一、未来演进（不在 v1.0 范围）

- **v1.1**: 自动从 `ontology/object_types/*.yaml` 反射生成 `ObjectTypeManifest`,
  消除手工同步成本
- **v1.2**: Studio 资源浏览器 — 提供"看得见的 OpenClaw 风格扩展面"
- **v1.3**: `pack diff` CLI — 给 IndustryPack 安装前看资源变更预览
- **Phase B**: 运行期 install/uninstall 一个 IndustryPack(冷启动 → 热加载)
- **Phase C**: 跨 station 联邦 registry — 同一 IndustryPack 在多站点间同步版本

---

**承诺**：v1.0 不引入对现有代码任何破坏性改动。所有现存 ObjectType/Action 路径保持不变；
新增的只是一份"看得见的扩展资源清单",像 OpenClaw 那样把 ClawTwin 的扩展面公开化。
