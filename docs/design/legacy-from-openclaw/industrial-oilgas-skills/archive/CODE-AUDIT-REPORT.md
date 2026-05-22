# ClawTwin Platform 代码审计报告

> **审计对象**：`/Users/power/Projects/clawtwin-platform/`  
> **审计时间**：2026-05-09  
> **严重性标记**：🔴 阻断级（会造成安全漏洞或联调失败）/ 🟠 重要（功能不完整）/ 🟡 优化（代码质量）

---

## 一、严重问题（🔴 必须在 M1 结束前修复）

### [A-001] JWT 认证完全失效——所有路由未受保护

**位置**：`routers/auth.py`、`routers/equipment.py`、`routers/workorder.py`

```python
# ❌ 现有代码：get_current_user 完全不验证 token，返回硬编码管理员
@router.get("/me")
async def get_current_user(db: AsyncSession = Depends(get_db)):
    return {"id": 1, "username": "admin", "role": "admin"}  # ← 永远是管理员！

# ❌ 所有路由都没有 Depends(get_current_user)：
@router.get("/")
async def list_equipment(station_id: Optional[int] = None, ...):  # ← 无鉴权
```

**影响**：任何人无需登录即可访问所有 API，包括读取所有场站数据、修改工单状态。

**修复**（参考 MODULE-DESIGN-PLATFORM.md §十二）：

```python
# ✅ auth/depends.py
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/v1/auth/login")

async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id: str = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=401, detail="Token 无效或已过期")
    user = await db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="用户不存在或已禁用")
    return user

def require_station(station_id: str, user: User):
    """铁律 2：station_id 必须在用户权限范围内"""
    if station_id not in user.station_ids:
        raise HTTPException(status_code=403, detail="无权访问该场站")
```

---

### [A-002] station_id 从用户输入获取——违反铁律 2

**位置**：`routers/workorder.py`

```python
# ❌ 现有代码：station_id 来自请求体
class CreateWorkOrderRequest(BaseModel):
    station_id: int  # ← 攻击者可以传任意 station_id！

order = WorkOrder(station_id=req.station_id, ...)  # ← 直接用！
```

**影响**：任何用户可以在任意场站创建工单，完全绕过场站权限控制。

**修复**：

```python
# ✅ station_id 从 equipment 查询，再验证用户权限
@router.post("/", dependencies=[Depends(get_current_user)])
async def create_workorder(req: WorkOrderCreateReq, current_user=Depends(get_current_user), db=Depends(get_db)):
    eq = await db.get(Equipment, req.equipment_id)
    if not eq:
        raise HTTPException(404, "设备不存在")
    require_station(eq.station_id, current_user)  # ← 从设备推导，再验证权限
    wo = WorkOrder(station_id=eq.station_id, ...)  # ← 服务端推导
```

---

### [A-003] 数据模型主键使用整数 ID——与设计不符

**位置**：`db/models/base.py`、所有模型

```python
# ❌ 现有代码：Integer 自增主键
class IDMixin:
    id = Column(Integer, primary_key=True, autoincrement=True)

# 所有外键也是 Integer：
equipment_id: Mapped[int] = mapped_column(Integer, ForeignKey("equipment.id"))
```

**影响**：

- 设计定义：Equipment ID = `"C-001"`、Station = `"S001"`、WorkOrder = `"W-XXXXXXXX"`
- 前端 Studio 引用 `equipment_id: string`，与整数 ID 不兼容
- 导入 IMS 数据时字符串 ID 无法映射到整数 ID

**修复**（权威见 §19.1-19.3）：

```python
# ✅ 使用字符串 ID
class Equipment(Base):
    __tablename__ = "equipment"
    id: Mapped[str] = mapped_column(String(50), primary_key=True)
    # 示例值："C-001"（压缩机）、"V-001"（阀门）

class WorkOrder(Base):
    __tablename__ = "work_orders"
    wo_id: Mapped[str] = mapped_column(
        String(40), primary_key=True,
        default=lambda: f"W-{uuid.uuid4().hex[:8].upper()}"
    )
```

---

### [A-004] WorkOrder 字段名错误——`status`/`state` 混乱

**位置**：`db/models/work_order.py`、`routers/workorder.py`

```python
# ❌ 现有代码
class WorkOrderStatus(str, enum.Enum):
    DRAFT = "draft"
    PENDING = "pending"          # ← 应为 "pending_approval"
    COMPLETED = "completed"      # ← 应为 "done"
    # 缺少 "rejected"

class WorkOrder(Base):
    status: Mapped[str] = ...    # ← 字段名应为 state（见 §19.3）

# router 里：
return {"id": order.id, "status": "draft", ...}  # ← id 应为 wo_id，status 应为 state
```

**影响**：前端 Studio 用 `wo.state === "pending_approval"` 做判断，后端返回 `status: "pending"` 导致逻辑全部失效。

**修复**（权威见 §19.3-19.5）：

```python
# ✅ 与设计完全对齐
class WorkOrderState(str, enum.Enum):
    DRAFT            = "draft"
    PENDING_APPROVAL = "pending_approval"
    APPROVED         = "approved"
    IN_PROGRESS      = "in_progress"
    DONE             = "done"
    REJECTED         = "rejected"

class WorkOrder(Base):
    wo_id: Mapped[str] = mapped_column(String(40), primary_key=True, ...)
    state: Mapped[str] = mapped_column(String(30), default="draft")  # ← state 非 status
    priority: Mapped[str] = mapped_column(String(4), default="P2")   # ← P1/P2/P3 非 low/medium/high
```

---

### [A-005] API 路由前缀缺失 `/v1/`

**位置**：`main.py`、所有 router

```python
# ❌ 现有代码
router = APIRouter(prefix="/workorders", ...)  # → /workorders/
router = APIRouter(prefix="/equipment", ...)   # → /equipment/

# 应为：
router = APIRouter(prefix="/v1/workorders", ...)  # → /v1/workorders/
router = APIRouter(prefix="/v1/equipment", ...)   # → /v1/equipment/
```

**影响**：Studio 所有 API 调用都是 `/v1/...`，现有后端无法对接。

---

### [A-006] 工单路由结构与设计不匹配

**位置**：`routers/workorder.py`

```
❌ 现有路由                 ✅ 设计要求（§18.6 权威表）
POST /workorders/draft     POST /v1/workorders/ai-draft（预填，不建工单）
POST /workorders/create    POST /v1/workorders/（建工单）
POST /{id}/approve         POST /v1/hitl/workorders/{id}/pending（提交审批）
                           POST /v1/hitl/workorders/{id}/approve（主管批准）
                           POST /v1/hitl/workorders/{id}/reject（主管驳回）
                           POST /v1/hitl/workorders/{id}/start（开始执行）
                           POST /v1/hitl/workorders/{id}/done（完成）
```

---

## 二、重要问题（🟠 必须在 M2 结束前修复）

### [A-007] Equipment 模型缺少关键字段

**位置**：`db/models/equipment.py`

```python
# ❌ 缺少
thresholds   # JSONB，告警阈值（warn/alarm/unit）→ AI 异常检测的核心依据
area         # VARCHAR，区域分组（压缩机区/计量区）→ StationHeatmap 必需
p_and_id_ref # VARCHAR，P&ID 图纸引用号 → P&ID 视图必需

# ❌ 多余/命名错误
equipment_type = "compressor|pump|valve|motor"  # 应为: compressor|separator|meter|valve|pump
code           # 非标准，设计用 id（字符串）作为唯一标识

# ❌ status 值错误
status = "online|offline|maintenance|fault"
# 应为：normal|warn|alarm|offline
```

---

### [A-008] EquipmentReading 使用固定列——不支持多指标扩展

**位置**：`db/models/reading.py`（推断存在）

```python
# ❌ 现有：固定列
class EquipmentReading:
    temperature: float
    vibration: float
    pressure: float
    current: float
    rpm: float
    # 添加新指标？要改表结构！
```

**设计要求**：

```python
# ✅ metric/value 灵活对模式（权威见 §19.1）
class EquipmentReading(Base):
    __tablename__ = "equipment_readings"
    id:           int     # BigSerial
    equipment_id: str     # FK → equipment.id
    metric:       str     # "outlet_pressure" / "shaft_vibration" / ...
    value:        float
    quality:      str = "GOOD"   # GOOD|BAD|UNCERTAIN
    time:         datetime        # TimescaleDB hypertable 分区键
```

---

### [A-009] User 模型缺少 `station_ids` 字段

**位置**：`db/models/user.py`

```python
# ❌ 现有
class User:
    department: str  # 只有部门，没有场站权限

# ✅ 设计要求（ABAC 核心）
class User:
    station_ids: list[str]  # ["S001", "S002"]，用于 require_station() 检查
    role: str               # operator|supervisor|engineer|kb_admin|sys_admin
    # 注意：没有 "admin" 角色，最高是 "sys_admin"
```

---

### [A-010] 审计日志未接入任何路由

所有路由（创建工单、审批、设备读取）均无审计日志写入，违反铁律 6。

**修复**：在关键路由末尾添加：

```python
from services.audit import audit_log
await audit_log(db, current_user.user_id, "workorder.create", f"wo:{wo.wo_id}")
```

---

### [A-011] SQLite 作为默认数据库——无法用于生产

```python
# ❌ settings.py
DATABASE_URL: str = "sqlite+aiosqlite:///./data/clawtwin.db"
```

SQLite 不支持 TimescaleDB（时序数据）、pgvector（向量搜索）。应在启动时检测并强制要求 PostgreSQL。

---

## 三、代码质量问题（🟡 在对应里程碑内处理）

### [A-012] CORS 配置过于宽泛

```python
# ❌ allow_origins=["*"]  → 生产环境必须限制到 Studio 域名
allow_origins=[settings.ALLOWED_ORIGINS]  # 从环境变量读取
```

### [A-013] 密码 bcrypt 上下文全局单例

```python
# ❌ pwd_context 定义在 router 文件里，应移到 services/auth/password.py
```

### [A-014] 工单 `creator_id=1` 硬编码

所有工单创建时 `creator_id=1`，应从 `current_user.user_id` 获取。

### [A-015] 缺少 OpenClaw Tool API 端点

以下端点完全未实现（OpenClaw Skills 无法调用）：

- `POST /v1/tools/diagnose_equipment`
- `POST /v1/tools/query_kb`
- `POST /v1/tools/analyze_pid`
- `GET  /v1/equipment/{id}/health-score`
- `GET  /v1/equipment/{id}/spectrum`

### [A-016] 缺少飞书 Webhook 处理器

`POST /v1/feishu/events` 未实现，飞书 Bot 无法触发任何 Platform 行为。

### [A-017] 缺少 Scheduler

APScheduler 晨报生成、MOIRAI 轮询、KPI 计算均未实现。

---

## 四、修复优先级矩阵

| 问题                       | 里程碑    | 负责模块  | 风险 |
| :------------------------- | :-------- | :-------- | :--- |
| A-001（JWT 失效）          | M1 Week 1 | 后端核心  | 🔴   |
| A-002（station_id 越权）   | M1 Week 1 | 后端核心  | 🔴   |
| A-003（整数 ID）           | M1 Week 1 | 后端核心  | 🔴   |
| A-004（状态字段错误）      | M1 Week 1 | 后端核心  | 🔴   |
| A-005（路由前缀）          | M1 Week 1 | 后端核心  | 🔴   |
| A-006（路由结构）          | M1 Week 2 | 后端 HITL | 🔴   |
| A-007（Equipment 字段）    | M1 Week 2 | 后端核心  | 🟠   |
| A-008（Reading 结构）      | M2 Week 3 | 数据层    | 🟠   |
| A-009（User.station_ids）  | M1 Week 1 | 后端核心  | 🔴   |
| A-010（审计日志）          | M1 Week 2 | 后端核心  | 🟠   |
| A-011（SQLite 默认值）     | M1 Week 1 | DevOps    | 🟠   |
| A-012（CORS）              | M1 Week 2 | DevOps    | 🟡   |
| A-013（pwd_context）       | M1 Week 1 | 后端核心  | 🟡   |
| A-014（hardcoded creator） | M1 Week 1 | 后端核心  | 🔴   |
| A-015（Tool API）          | M3 Week 5 | AI集成    | 🟠   |
| A-016（飞书 Webhook）      | M4 Week 7 | 集成      | 🟠   |
| A-017（Scheduler）         | M5 Week 9 | 后端      | 🟠   |

---

## 五、立即可用的部分（无需修改）

以下内容结构合理，保留并扩展：

- ✅ `docker-compose.yml` 基础结构（补充 Redis、Milvus 服务即可）
- ✅ `pydantic_settings` 配置模式（补充缺失字段）
- ✅ `AsyncSession` + `asynccontextmanager` 数据库模式
- ✅ `bcrypt` 密码哈希（移到正确位置）
- ✅ `jose.jwt` JWT 生成逻辑（补充 decode 验证）
- ✅ `TimestampMixin` 时间戳混入

---

## 六、M1 Week 1 最小重构清单（两天完成）

按此顺序重构，不影响现有运行能力：

```
Day 1：
  □ 修复 IDMixin → 字符串 ID（设备/场站/用户/工单各自的格式）
  □ 修复 User 模型：加 station_ids, 角色改 sys_admin 最高
  □ 实现真实 get_current_user（JWT decode + 用户查询）
  □ 实现 require_station()（station_id 权限验证）
  □ 所有 router 加 /v1/ 前缀

Day 2：
  □ 修复 WorkOrder 模型：status → state，值改为 pending_approval 等
  □ 修复 workorder router：路由结构对齐 §18.6
  □ Equipment 模型加 thresholds、area、p_and_id_ref
  □ 添加 audit_log() 到关键路由
  □ DATABASE_URL 默认值改为强制 PostgreSQL（无 SQLite fallback）
  □ CORS 限制到环境变量配置的域名
```

---

_本报告生成于 2026-05-09 代码审计，基于 MODULE-DESIGN-PLATFORM.md §十九权威数据模型。_  
_下次审计触发条件：M1 Week 2 完成后，或合并超过 20 个 PR 后。_
