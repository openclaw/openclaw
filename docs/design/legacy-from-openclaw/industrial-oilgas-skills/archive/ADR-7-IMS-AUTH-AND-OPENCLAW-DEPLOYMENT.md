# ADR-7：IMS 权限管理 & OpenClaw 部署粒度

## 架构决策记录

**日期**：2026-05-08  
**状态**：决策已定  
**核心问题**：

1. 安全隔离是否要求每人一个 OpenClaw Gateway？
2. IMS 账号权限应该由谁管理？
3. 什么才是正确的权限管理结构？

---

## 一、用户观点的核心是对的，但结论走错了

用户的判断：

```
✓ 正确：需要基于用户身份的权限隔离
✓ 正确：IMS 系统有自己的账号权限体系
✓ 正确：Platform 应该管理权限和 IMS 对接
✗ 错误：安全隔离 ≠ 每人一个 OpenClaw Gateway
```

问题的根源在于把「会话隔离」和「数据权限隔离」混为一谈。
它们是两个独立的问题，解决方式不同。

---

## 二、OpenClaw Gateway 已经做了会话隔离

```
误解：共享 OpenClaw → 用户 A 的对话被用户 B 看到

事实：OpenClaw Gateway 天然做了会话隔离
  · 每个用户的对话是一个独立的 Session（按 feishu_open_id 区分）
  · 用户 A 无法看到用户 B 的聊天历史（Session 级别隔离）
  · 内存中的上下文按 Session 分开存储

类比：
  公司的 Slack 所有员工用同一个 Slack 服务器
  但每个人只看得到自己的频道和私信
  不是每个员工有自己的 Slack 服务器

如果每人一个 OpenClaw：
  100 人 → 100 个 Node.js 进程
  100 个 PostgreSQL 连接池
  100 个 Skill 配置要维护
  Skills 更新 → 要 rolling update 100 个进程
  这不是企业软件，这是运维噩梦
```

---

## 三、数据权限隔离的正确位置：Platform，不是 OpenClaw

```
安全边界应该在哪里？

错误模型：
  用户 A 的 OpenClaw ──直接──▶ IMS 系统（用 A 的账号）
  用户 B 的 OpenClaw ──直接──▶ IMS 系统（用 B 的账号）

问题：
  · 100 个 OpenClaw 实例各自持有 IMS 凭证 → 100 个攻击面
  · OpenClaw 版本升级 → 100 次部署
  · Skills 只知道"查设备数据"，不知道 IMS 内部权限结构
  · IMS 凭证散落在 100 个实例的配置文件里 → 极难审计

正确模型：
  ┌──────────────────────────────────────────────────────┐
  │  OpenClaw Gateway（1个，会话隔离，不持有 IMS 凭证）  │
  │  知道当前是哪个用户（feishu_open_id）                │
  │  调用 Platform Tool API 时携带用户身份               │
  └─────────────────────┬────────────────────────────────┘
                        │ 携带用户身份
                        ▼
  ┌──────────────────────────────────────────────────────┐
  │  ClawTwin Platform（权限管理中心）                   │
  │                                                      │
  │  1. 验证用户身份（feishu_open_id → user_id）        │
  │  2. 加载用户权限（role + station_ids）               │
  │  3. 用用户的 IMS 凭证（加密存储）调用 IMS           │
  │  4. 过滤返回数据（只返回用户有权看的部分）           │
  │  5. 写审计日志                                       │
  └─────────────────────┬────────────────────────────────┘
                        │ 用用户凭证查询（或服务账号+ABAC）
                        ▼
  ┌──────────────────────────────────────────────────────┐
  │  IMS 系统（客户现场已有系统）                        │
  │  OPC-UA / SCADA / SAP PM / Maximo / 自研系统        │
  └──────────────────────────────────────────────────────┘
```

---

## 四、IMS 账号权限的两种管理模式

根据客户 IMS 的成熟度，有两种方案，Platform 支持两种：

### 模式 A：Platform 服务账号（推荐，适合大多数工业客户）

```
场景：
  客户的 IMS（OPC-UA / SCADA）权限模型简单
  或者客户不希望把 IMS 个人账号给 ClawTwin

做法：
  · Platform 用一个专属「服务账号」访问 IMS
    （类似 IT 系统的"系统集成账号"，只读权限）
  · IMS 侧：为 ClawTwin-Platform 创建一个只读服务账号
    用户：clawtwin-readonly
    权限：可读所有实时数据、告警历史、设备台账
    不可：写操作、删除、修改配置

  · Platform 侧实现 ABAC：
    IMS 把全量数据返给 Platform
    Platform 根据 user_id + station_ids 过滤
    只返回该用户有权访问的场站/设备数据

优点：
  · IMS 侧管理简单（1个服务账号，不用管理100个用户账号）
  · Platform 是唯一的权限管理中心（一处配置，全局生效）
  · 方便审计（所有查询都经过 Platform，有完整日志）

缺点：
  · 如果 IMS 有非常细粒度的权限（如某人只能看某台设备），
    Platform 侧需要重新实现这些权限逻辑
```

### 模式 B：Platform 代理用户凭证（适合 IMS 权限体系成熟的客户）

```
场景：
  客户已有成熟的 IMS（如 SAP PM、Maximo）
  每个用户在 IMS 里已有精细权限配置
  客户不想在 Platform 重复实现权限逻辑

做法：
  · 每个用户在 Platform 绑定时，也绑定 IMS 账号密码（加密存储）
  · Platform 不自己实现权限，而是「冒充用户」去查 IMS
  · IMS 返回该用户权限范围内的数据 → Platform 直接传给 OpenClaw

  Platform 存储：
  user_ims_credentials:
    user_id       TEXT
    ims_type      TEXT     ('opcua' | 'sappm' | 'maximo' | 'rest')
    ims_username  TEXT     (加密存储)
    ims_password  TEXT     (AES-256-GCM 加密，密钥在 HSM 或 KMS 中)
    ims_endpoint  TEXT
    created_at    TIMESTAMP
    last_used_at  TIMESTAMP

  Platform 调用 IMS 时：
    1. 解密用户的 IMS 凭证
    2. 用该凭证建立 IMS 连接（或获取 IMS token）
    3. 查询数据（IMS 自动按该用户权限过滤）
    4. 返回结果
    5. 凭证不出 Platform 服务器（在内存中使用，不传给 OpenClaw）

优点：
  · 利用 IMS 已有权限体系，不重复造轮子
  · IMS 的细粒度权限自动生效
  · 减少 Platform 的权限实现工作量

缺点：
  · Platform 持有用户 IMS 密码（需要 KMS 保护）
  · IMS 密码变更需要用户重新绑定
  · 依赖 IMS 的账号管理（用户离职需同步处理）
```

### 两种模式对比

```
维度              模式 A（服务账号）          模式 B（代理用户凭证）
───────────────────────────────────────────────────────────────────
IMS 账号管理       1个服务账号，简单            N个用户账号，复杂
Platform 权限实现  需要实现 ABAC               直接用 IMS 权限
客户 IMS 成熟度   低-中都适用                   IMS 本身要有 RBAC
安全风险          平台侧 ABAC 逻辑漏洞          用户凭证加密保护
推荐场景          相对简单的 OPC-UA/SCADA       SAP PM、Maximo 等成熟系统
Phase A 建议      ✓ 先做模式 A                  Phase B 按需支持模式 B

结论：Platform 默认用模式 A（服务账号）
      如果客户有成熟 IMS 权限体系，支持模式 B（可配置）
```

---

## 五、正确的完整架构（含安全边界）

```
┌────────────────────────────────────────────────────────────────────┐
│ 用户层（员工）                                                       │
│   飞书 App（手机/PC）← 用户只有飞书账号，不直接接触 IMS 账号         │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ 飞书消息（通过飞书服务器）
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│ OpenClaw Gateway（1个实例，会话隔离）                                │
│                                                                    │
│ · 不持有任何 IMS 凭证                                               │
│ · 不做任何权限判断                                                   │
│ · 只负责：AI 推理 + 调用 Platform Tool API + 传递 feishu_open_id    │
│                                                                    │
│ Session 隔离：                                                      │
│   open_id:ou_A → Session A → 对话历史 A                            │
│   open_id:ou_B → Session B → 对话历史 B                            │
│   open_id:ou_C → Session C → 对话历史 C                            │
│   → A/B/C 互相看不到，天然隔离                                       │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ Tool API 调用
                               │ Header: X-Feishu-OpenId: ou_xxx
                               │ Header: X-OpenClaw-Token: <service_token>
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│ ClawTwin Platform（权限管理中心 + IMS 集成中心）                     │
│                                                                    │
│ 每个请求进来：                                                       │
│   Step 1: 验证 X-OpenClaw-Token（防止非 OpenClaw 调用）             │
│   Step 2: feishu_open_id → user_id（查绑定表）                     │
│   Step 3: user_id → role + station_ids（查权限表）                 │
│   Step 4: 执行 ABAC（请求的资源 vs 用户的 station_ids）             │
│   Step 5: 调用对应 IMS Adapter（用服务账号或用户凭证）              │
│   Step 6: 过滤/处理结果（只返回有权限的数据）                        │
│   Step 7: 写审计日志                                                │
│   Step 8: 返回结果（已经按权限过滤）                                 │
│                                                                    │
│ 存储（Platform 数据库）：                                            │
│   · users + roles + station_ids（Platform 自己的权限体系）          │
│   · user_feishu_bindings（open_id → user_id 映射）                 │
│   · user_ims_credentials（可选，模式 B 时使用，AES-256 加密）       │
│   · audit_logs（只追加，不可删除）                                   │
│                                                                    │
│ IMS Adapter（Platform 内部，对外不暴露）：                          │
│   · opcua_adapter.py   → OPC-UA 服务器                             │
│   · scada_adapter.py   → SCADA REST API                            │
│   · sappm_adapter.py   → SAP PM（模式 B）                          │
│   · csv_adapter.py     → CSV 导入（历史数据初始化）                 │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ 服务账号（模式A）或用户凭证（模式B）
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│ IMS 系统（客户现场，已有系统）                                        │
│   OPC-UA / SCADA / SAP PM / Maximo / 自研站管系统                  │
│   → 模式 A：Platform 用服务账号连接，全量读，Platform 侧过滤         │
│   → 模式 B：Platform 用各用户凭证连接，IMS 侧过滤                   │
└────────────────────────────────────────────────────────────────────┘
```

---

## 六、为什么 Platform 是权限管理中心是正确的

这个设计和 Palantir Foundry / AIP 完全一致：

```
Palantir 的做法（我们可以对标）：
  · Foundry 有一套独立的权限模型（Dataset Permissions、Workspace RBAC）
  · 对接各种数据源（数据库、OPC-UA、REST API）时，
    Foundry 用「Source Connection」（相当于我们的 IMS Adapter）
  · 每个 Source Connection 有自己的服务账号凭证（存在 Foundry 密钥管理）
  · Foundry 本身的 ABAC 控制谁能看到什么数据集
  · AIP（AI 层）以用户权限运行，调 Foundry API，Foundry 强制 ABAC

我们的 Platform 就是 Foundry 的角色：
  · Platform 管理数据连接（IMS Adapter）
  · Platform 管理用户权限（ABAC）
  · OpenClaw 就是 AIP 的角色（AI 推理层）
  · OpenClaw 以用户身份调 Platform，Platform 强制权限
```

---

## 七、用户担心的安全问题，Platform 如何解决

```
担心 1：用户 A 能看到用户 B 的数据
解决：Platform ABAC 强制过滤，OpenClaw 的 Session 隔离也保证对话不泄漏
     → 即使 OpenClaw 共享，数据也是严格按用户权限返回的

担心 2：依赖 IMS 账号密码，如何管理
解决：
  模式 A：IMS 只需1个服务账号，Platform 保管，不涉及用户个人密码
  模式 B：用户密码存在 Platform 数据库中（AES-256 加密），
          密钥存在独立 KMS（或 HSM），不在 Platform 代码中

担心 3：OpenClaw 被攻击，导致权限提升
解决：
  · OpenClaw 本身没有任何 IMS 凭证（没什么可偷的）
  · Platform 的 X-OpenClaw-Token 验证确保只有合法 OpenClaw 能调 Tool API
  · 即使 OpenClaw 被 Prompt 注入，Platform 的 ABAC 是最后防线
  · 攻击者通过 Prompt 注入无法获得超出该用户权限的数据

担心 4：一个 OpenClaw 出问题，影响所有用户
解决：
  · 这是可用性问题，不是安全问题
  · 解决方式：OpenClaw 高可用部署（多副本 + 负载均衡），不是每人一个实例
  · 2个 OpenClaw 副本 >> 100个单点 OpenClaw
```

---

## 八、Platform 的 IMS Adapter 实现框架

```python
# platform-api/ims/adapter_base.py

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime

@dataclass
class EquipmentReading:
    equipment_id: str
    metric: str
    value: float
    unit: str
    timestamp: datetime
    quality: str  # "GOOD" | "BAD" | "UNCERTAIN"

@dataclass
class IMSCredential:
    """Platform 从数据库加载（解密后在内存中使用，不持久化明文）"""
    ims_type: str
    endpoint: str
    username: str
    password: str  # 已解密，仅在内存中短暂存在

class IMSAdapter(ABC):
    """所有 IMS 实现的统一接口"""

    @abstractmethod
    async def connect(self, credential: IMSCredential) -> None:
        """建立连接（用服务账号或用户凭证）"""
        ...

    @abstractmethod
    async def get_equipment_reading(
        self, equipment_id: str
    ) -> list[EquipmentReading]:
        """获取设备实时数据"""
        ...

    @abstractmethod
    async def get_alarm_history(
        self, station_id: str, since: datetime
    ) -> list[dict]:
        """获取告警历史"""
        ...

    @abstractmethod
    async def get_work_orders(
        self, station_id: str, since: datetime
    ) -> list[dict]:
        """获取工单历史（用于初始化 L3 知识）"""
        ...

    @abstractmethod
    async def health_check(self) -> bool:
        """连接健康检查"""
        ...

# platform-api/ims/adapter_registry.py

class IMSAdapterRegistry:
    """
    Platform 的 IMS Adapter 管理中心

    每个场站配置一个 Adapter（可以指向同一个 IMS 或不同 IMS）
    Station S001 → OpcUaAdapter（连接 S001 OPC-UA）
    Station S002 → OpcUaAdapter（连接 S002 OPC-UA）
    Station S003 → ScadaRestAdapter（连接 S003 SCADA REST）
    """

    _adapters: dict[str, IMSAdapter] = {}

    @classmethod
    async def get(cls, station_id: str) -> IMSAdapter:
        """获取场站的 IMS Adapter（懒加载，连接复用）"""
        if station_id not in cls._adapters:
            config = await load_station_ims_config(station_id)
            adapter = create_adapter(config.ims_type)
            cred = await load_service_credential(station_id)  # 从 Platform DB 加载
            await adapter.connect(cred)
            cls._adapters[station_id] = adapter
        return cls._adapters[station_id]

# platform-api/ims/opcua_adapter.py（模式 A 示例）

import asyncua

class OpcUaAdapter(IMSAdapter):

    def __init__(self):
        self._client: asyncua.Client | None = None

    async def connect(self, cred: IMSCredential) -> None:
        self._client = asyncua.Client(url=cred.endpoint)
        self._client.set_user(cred.username)
        self._client.set_password(cred.password)
        await self._client.connect()

    async def get_equipment_reading(self, equipment_id: str) -> list[EquipmentReading]:
        # equipment_id → OPC-UA NodeId（通过配置映射）
        node_ids = await get_node_mapping(equipment_id)
        readings = []
        for metric, node_id in node_ids.items():
            node = self._client.get_node(node_id)
            val  = await node.read_value()
            readings.append(EquipmentReading(
                equipment_id=equipment_id,
                metric=metric,
                value=float(val.Value),
                unit=val.StatusCode.name,
                timestamp=val.SourceTimestamp,
                quality="GOOD" if val.StatusCode.is_good() else "BAD"
            ))
        return readings
```

---

## 九、最终结论：三句话

```
1. OpenClaw 是「会话隔离」不是「数据权限隔离」：
   会话隔离（谁的对话谁看）→ OpenClaw Gateway 天然支持，共享实例无问题
   数据权限隔离（谁能看哪些设备数据）→ Platform 的 ABAC 负责，和 OpenClaw 无关

2. Platform 是权限管理中心和 IMS 集成中心（用户的判断完全正确）：
   用户身份绑定 → Platform 管
   IMS 凭证管理 → Platform 管（服务账号模式，或加密代理用户凭证模式）
   ABAC 权限执行 → Platform 每个 API 强制执行
   审计日志 → Platform 负责

3. 每人一个 OpenClaw 是错误的解法：
   正确解法是 Platform 做权限管控（一处管理，安全可审计）
   OpenClaw 高可用部署解决可用性问题（N副本负载均衡，不是N个实例）
   把「会话隔离」和「数据权限隔离」混淆会导致架构过度复杂
```
