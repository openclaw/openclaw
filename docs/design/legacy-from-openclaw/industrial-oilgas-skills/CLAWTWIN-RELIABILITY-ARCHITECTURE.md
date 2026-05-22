# CLAWTWIN-RELIABILITY-ARCHITECTURE — 工业级可靠性架构

**地位**: 🟢 核心 / Reliability / Authoritative  
**版本**: v2.1.3 (2026-05-13) — §5.1 Feishu 渠道与 webhook fan-out 落库、`fanout_feishu_channel_delivery` 与 `deliver_immediately` 防递归  
**关联**:

- [`INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`](INDUSTRIAL-FOUNDRY-ARCHITECTURE.md) — API 协议权威
- [`CLAWTWIN-EXTENSION-MANIFESTO.md`](CLAWTWIN-EXTENSION-MANIFESTO.md) — 五条内在法则
- [`CLAWTWIN-PHYSICS-FOUNDATIONS.md`](CLAWTWIN-PHYSICS-FOUNDATIONS.md) — 控制论三定理

---

## 一、为什么需要专门的可靠性架构？

OpenClaw 之所以能在生产环境长期稳定运行，是因为它有一套完整的「可靠性五件套」。ClawTwin 面向工业现场，失败代价更高：

| 场景              | 失败代价                                               |
| ----------------- | ------------------------------------------------------ |
| 工单消息丢失      | **安全事故**：工程师未及时执行高风险操作               |
| 飞书告警丢失      | **HSE 事故**：工程师不知道罐区超限                     |
| OutcomeEvent 丢失 | **飞轮断裂**：AI 学不到这次干预的效果                  |
| 重复飞书推送      | **信息污染**：误操作、双重工单                         |
| AI 调用风暴       | **成本爆炸 + 可用性崩溃**：一个告警 → 1000 次 LLM 调用 |
| Worker 静默 hung  | **数据延迟**：站点决策依据失效                         |

ClawTwin 对可靠性的要求只会**更高**，不会更低。

---

## 二、可靠性全景图（v2.4 实现状态）

```
┌─────────────────────────────────────────────────────────────────┐
│                  ClawTwin 可靠性七件套                            │
├──────────┬──────────────────────────────────────────────────────┤
│ ① Doctor │ 自检 + 修复 + IndustryPack 贡献点注册                │
│ ② Health │ 维度化健康分（多维 + version + Capability 感知）     │
│ ③ Outbox │ 事务性持久化投递（at-least-once + 退避 + 恢复）      │
│ ④ Dedupe │ 入站事件去重（飞书/Webhook 重试幂等 TTL-LRU）        │
│ ⑤ Limits │ 双维限流：接入层（IP+station）+ AI 层（IP+actor）   │
│ ⑥ Usage  │ AI Token 用量持久化（观测 + 成本控制）               │
│ ⑦ Reload │ ReloadPlan 外科手术式热重载（last-known-good）       │
└──────────┴──────────────────────────────────────────────────────┘
```

---

## 三、① Doctor — 自检与修复

### 3.1 框架

```python
# infra/doctor/__init__.py
@register_check(id="db_connectivity", severity=Severity.CRITICAL)
def check_db() -> CheckResult:
    ...

# IndustryPack 通过 python_module 注册额外检查：
doctor_checks = [{"name": "opcua_handshake", "fn": check_opcua}]
```

### 3.2 内置 Check（与代码 `infra/doctor/builtin.py` 对齐）

| Check id                  | 严重度   | 说明                                                                                                                                                                     |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db.connectivity`         | CRITICAL | DB 可达，`SELECT 1` 延迟                                                                                                                                                 |
| `clock.skew`              | CRITICAL | 系统时钟在合理区间                                                                                                                                                       |
| `scheduler.alive`         | WARN     | **进程内** scheduler 最后 `beat` 年龄                                                                                                                                    |
| `outbox_dispatcher.alive` | WARN     | **进程内** outbox dispatcher 最后 `beat` 年龄                                                                                                                            |
| `worker_heartbeats.fresh` | WARN     | **可选**：`CLAWTWIN_WORKER_HEARTBEAT_DB=1` 时表 `worker_heartbeats` 中 **scheduler / outbox_dispatcher**（及 **`CLAWTWIN_OPCUA_ENABLED` 时的 opcua_collector**）最新时间 |
| `outbox.backlog`          | WARN     | pending 过久 / 积压                                                                                                                                                      |
| `capabilities.consistent` | INFO     | 能力依赖一致                                                                                                                                                             |

### 3.3 HTTP 接口

| 端点                           | 描述                                              |
| ------------------------------ | ------------------------------------------------- |
| `GET /v1/doctor/checks`        | 列出所有 check 与默认严重度                       |
| `POST /v1/doctor/run`          | 一键全跑（5-10s）；每项 ok/warn/fail + fix_hint   |
| `POST /v1/doctor/run?fix=true` | 自动修复可修项                                    |
| `GET /v1/doctor/settings`      | 非敏感配置摘要（AI provider / 能力开关 / 端口等） |
| `GET /v1/doctor/hooks`         | 列出所有注册的 Platform Hook                      |

### 3.4 CLI

```bash
clawtwin doctor          # 一键自检（需 HTTP API；或部分子命令离线）
clawtwin doctor --fix
clawtwin start           # 启动 uvicorn + main.py 内嵌 worker 线程（与直接 uvicorn 等价）
clawtwin start --reload  # 开发热重载
clawtwin config show     # 配置摘要（优先连 /v1/doctor/settings；离线则读本地 settings）
clawtwin config reload   # 热重载（POST /v1/admin/reload-config）
clawtwin hooks           # 列出 Hook
```

---

## 四、② Health — 维度化健康分

### 4.1 数据结构

```python
HealthSummary {
    overall: "ok" | "degraded" | "down",
    version: int,      # 版本号；Studio 增量推送检测
    dimensions: {
        "db":        HealthDimension(ok=True,  metadata={"pool_used": 3, "pool_max": 20}),
        "outbox":    HealthDimension(ok=True,  metadata={"pending": 12, "oldest_age_s": 4}),
        "scheduler": HealthDimension(ok=True,  metadata={"last_tick_age_s": 3}),
        "ingest":    HealthDimension(ok=True,  metadata={"readings_per_min": 87}),
        "ai":        HealthDimension(ok=False, metadata={"reason": "no provider"}, disabled=False),
    }
}
```

### 4.2 Capability 感知

禁用的 Capability 对应维度以 `disabled=True` 标记，**不计入 `overall`**——否则 Headless 部署永远 degraded。

### 4.3 HTTP 接口

| 端点                        | 描述                                      |
| --------------------------- | ----------------------------------------- |
| `GET /v1/health`            | 简单 200/503（探针兼容）                  |
| `GET /v1/health/dimensions` | 维度化健康（给 Studio 仪表盘 + SSE 订阅） |

### 4.4 双层 Worker 心跳（进程内 + 可选 DB）

| 层                  | 机制                                                                                                                                     | 用途                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **L1 进程内**       | `infra/heartbeat.py`：`beat("scheduler")` / `beat("outbox_dispatcher")` / `beat("opcua_collector")`（后者在采集器线程每轮循环末尾）      | 同一进程内 Doctor/Health 立即判断 worker 线程是否还在跑                                   |
| **L2 持久化（M2）** | 环境变量 `CLAWTWIN_WORKER_HEARTBEAT_DB=1` 时，每次 `beat()` 额外 UPSERT 表 **`worker_heartbeats`**（复合主键 `worker_id` + `component`） | API 进程与 worker 进程**分离部署**时，Doctor 仍可通过 DB 判断「任意 worker 最后上报时间」 |

- **Worker 身份**：默认 `hostname:pid`；生产建议设置 **`CLAWTWIN_WORKER_ID`**（稳定 Pod 名或 supervisor 槽位）。
- **Health 维度**：`worker_heartbeats_db`（仅在为 `1` 时查询表；禁用时维度为 `enabled: false`）。
- **OPC-UA**：`max_beat_age_by_component` / Doctor **`worker_heartbeats.fresh`** 仅在 **`CLAWTWIN_OPCUA_ENABLED`** 开启时要求 **`opcua_collector`** 行存在且新鲜；未启用 OPC-UA 的部署不会因缺少第三组件而告警。

---

## 五、③ Outbox — 事务性持久化投递

### 5.1 架构

```
PlatformEvent.dispatch()
  → EventDispatcher.fan_out()
    → _WebhookOutboxSink   → enqueue_webhook_events() + commit → outbox_events（webhook）
    → _FeishuSink          → enqueue_feishu_channel_event() + commit → outbox_events（channel；失败则直连 notifier）
    → _SSESink             → 直接推（SSE 本身无持久化需求）
    → PlaybookTriggerSink  → 直接同步触发

workers/outbox_dispatcher.py (后台线程)
  → claim_batch(50) → FOR UPDATE SKIP LOCKED
  → _deliver_webhook / _deliver_channel / _deliver_agent
  → … 其中 channel 投递：fanout_feishu_channel_delivery() → _FeishuSink.deliver_immediately()（不再次入队）
  → ack() | fail(retry++ + backoff) | fail(permanent=True)
  每 ~10 tick 一次 reclaim_stuck(> 5 min delivering 行重置)
```

### 5.2 退避表（对标 OpenClaw delivery-queue）

| retry_count | 下次尝试延迟       |
| ----------- | ------------------ |
| 0           | +5 秒              |
| 1           | +25 秒             |
| 2           | +2 分钟            |
| 3           | +10 分钟           |
| 4           | +1 小时            |
| ≥5          | `failed_permanent` |

### 5.3 重启恢复

进程启动时，所有 `state=delivering` 且 `updated_at < now-5min` 的行由 `reclaim_stuck()` 重置为 `pending`，保证消息不因重启丢失。

### 5.4 运维接口

| 端点                                | 描述                                                |
| ----------------------------------- | --------------------------------------------------- |
| `GET /v1/outbox/stats`              | pending/delivering/failed 统计 + oldest pending age |
| `POST /v1/outbox/{event_id}/replay` | 手动重投失败消息                                    |

---

## 六、④ Dedupe — 入站事件去重

### 6.1 问题

飞书（Lark）、CMMS webhook、OT 系统 HTTP 推送，均可能在网络重试时发送重复事件。没有去重，每次重试都会触发一次新工单/告警/审计行，导致信息污染。

### 6.2 实现（`infra/inbound_dedupe.py`）

```python
# 进程内 TTL-LRU（单进程部署足够；多实例可换 Redis）
_cache = _SeenEventCache(max_entries=50_000, ttl_s=86400)

def is_duplicate_inbound_event(*, source: str, event_id: str) -> bool:
    key = f"{source}:{event_id}"
    return _cache.check_and_insert(key)  # True = duplicate
```

### 6.3 已集成位置

| 位置                                   | 去重 key                      |
| -------------------------------------- | ----------------------------- |
| `POST /v1/feishu/events`               | `feishu:{header.event_id}`    |
| _(可扩展)_ `POST /v1/webhooks/inbound` | `webhook:{X-Idempotency-Key}` |

### 6.4 多实例扩展路径

当 ClawTwin 需要水平扩展时，将 `_SeenEventCache` 替换为 Redis `SET NX EX` 实现，无需改业务代码（接口不变）。

---

## 七、⑤ Rate Limits — 双维限流

### 7.1 接入层（数据接入保护）

```
CLAWTWIN_RATE_INGEST_PER_IP_RPS     = 500  × burst_factor(3) = 1500 burst
CLAWTWIN_RATE_INGEST_PER_STATION_RPS= 200  × burst_factor(3) = 600  burst
```

防止 OPC-UA / SCADA 客户端配置错误（如 1000+ msg/s）耗尽 DB 连接池。

### 7.2 AI 函数调用层

```
CLAWTWIN_RATE_AI_PER_IP_RPS    = 30 × burst_factor(2) = 60  burst
CLAWTWIN_RATE_AI_PER_ACTOR_RPS = 15 × burst_factor(2) = 30  burst
```

防止大量告警同时触发 AI 诊断，导致：

- AI provider 费用激增
- token 耗尽引发服务降级

### 7.3 实现

```python
# infra/rate_limit.py — 进程内滑动窗口（_SlidingWindow）
from infra.rate_limit import get_ai_invoke_rate_limiter, get_ingest_rate_limiter

# functions_invoke.py
decision = get_ai_invoke_rate_limiter().check(source_ip=ip, actor_id=user.id)
if not decision.allow:
    raise HTTPException(429, detail=decision.to_error_detail())
```

---

## 八、⑥ Usage — AI Token 用量持久化

### 8.1 目的

- **成本可见**：每次 LLM 调用的 input/output tokens 持久到 `ai_usage_records` 表
- **容量规划**：按 function_api_name / actor_id / provider 聚合 → 发现 token 热点
- **审计合规**：工业场景需要能回答「这个月 AI 调用了多少？由谁触发？」

### 8.2 数据模型

```sql
CREATE TABLE ai_usage_records (
    id              TEXT PRIMARY KEY,
    created_at      TIMESTAMPTZ,
    actor_id        TEXT,          -- 操作人
    source          TEXT,          -- function_invoke | function_ai_model | handler
    function_api_name TEXT,
    provider        TEXT,          -- openai | anthropic | ollama | stub
    model           TEXT,
    input_tokens    INT,
    output_tokens   INT,
    total_tokens    INT,
    finish_reason   TEXT,
    latency_ms      FLOAT          -- 端到端延迟
);
INDEX (created_at);
```

### 8.3 集成点

| 调用位置                     | usage_meta                                                     |
| ---------------------------- | -------------------------------------------------------------- |
| `ai_runner.run_completion()` | 通过 `usage_meta` 参数传入 actor_id / source / function        |
| `execute_ai_function()`      | `source=function_ai_model`                                     |
| `diagnose_equipment` handler | `source=handler_diagnose_equipment, actor_id=context.actor_id` |

**写入完全后台 + 失败静默**（`threading.Thread(daemon=True)`），绝不影响主链路响应时间。

---

## 九、⑦ ReloadPlan — 外科手术式热重载

### 9.1 动机（对标 OpenClaw GatewayReloadPlan）

OpenClaw 的 `config-reload-plan.ts` 对配置 diff 后计算一个手术式 reload plan，只重启受影响的子系统，而非全进程重启。

ClawTwin 实现了相同设计：`infra/settings.ReloadPlan`。

### 9.2 ReloadPlan 字段映射

| ClawTwin 字段        | 触发条件                         | 实际动作                                   |
| -------------------- | -------------------------------- | ------------------------------------------ |
| `reload_log_level`   | `CLAWTWIN_LOG_LEVEL` 变更        | 立即 `logging.getLogger().setLevel(new)`   |
| `reinit_ai_provider` | AI key / provider / model 变更   | `reset_provider()` + `get_provider()` 重建 |
| `reinit_feishu`      | Feishu 凭据变更                  | `reinit_feishu_client()`（清缓存）         |
| `reload_packs`       | `packs_dir` / `extra_packs` 变更 | `reload_packs()` 重装所有 Pack             |
| `restart_outbox`     | outbox 参数变更                  | `dispatcher.stop() + dispatcher.start()`   |
| `restart_server`     | host/port 变更                   | 打 WARN 日志（需重启进程）                 |

### 9.3 last-known-good 保护

```python
try:
    new_settings = _parse_settings(_read_env())
except ValueError as exc:
    # 保留旧配置，返回 failure 给调用方
    return False, f"rejected: {exc}", None
```

配置无效时，进程继续用上一次有效配置运行，**不崩溃**。

---

## 十、与控制论三定理的对应

| 定理                         | 可靠性体现                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| **可观测性** (Observability) | Health 维度 + Doctor checks + AI 用量表 = 每个子系统状态可从外部读出                   |
| **可控性** (Controllability) | Doctor --fix + ReloadPlan + replay outbox = 从外部命令能将系统从 degraded 拉回 healthy |
| **稳定性** (Stability)       | Outbox 退避重试 + 限流 + last-known-good = 扰动后幅度收敛，不发散                      |

---

## 十一、与 OpenClaw 可靠性对标评分

| 能力维度        | OpenClaw             | ClawTwin v2.4                | 差距             |
| --------------- | -------------------- | ---------------------------- | ---------------- |
| Doctor 框架     | 30+ check            | 7 内置 + Pack 扩展           | 数量少；机制完整 |
| Health 维度化   | ✅ 多维 + version    | ✅ 多维 + version            | 对齐             |
| 可靠投递 Outbox | ✅ 文件+DB           | ✅ Postgres + dispatcher     | 对齐             |
| 入站去重        | N/A（外部幂等）      | ✅ TTL-LRU                   | ClawTwin 增量    |
| AI 限流         | Gateway 级           | ✅ 双维限流                  | 对齐             |
| AI 用量         | 内部统计             | ✅ DB 持久化                 | ClawTwin 更完整  |
| 配置热重载      | ✅ GatewayReloadPlan | ✅ ReloadPlan                | 对齐             |
| 优雅关闭        | ✅ SIGTERM           | ✅ SIGTERM/SIGINT            | 对齐             |
| 心跳保活        | ✅ HeartbeatRunner   | ⚠️ 框架有/未全部 Worker 接入 | 待补全           |
| 多副本并发安全  | N/A（单进程）        | ✅ SKIP LOCKED               | ClawTwin 增量    |

---

## 十二、运维操作速查

```bash
# 系统自检
clawtwin doctor

# 查看健康维度
curl /v1/health/dimensions

# 配置热重载（不重启进程）
clawtwin config reload
# 或：curl -X POST /v1/admin/reload-config

# 查看 AI 用量（直接 SQL）
SELECT function_api_name, SUM(total_tokens), COUNT(*)
FROM ai_usage_records
WHERE created_at > now() - interval '1 day'
GROUP BY 1 ORDER BY 2 DESC;

# Outbox 积压排查
curl /v1/outbox/stats

# 手动重投失败消息
curl -X POST /v1/outbox/{event_id}/replay

# 查看已注册 Hook
clawtwin hooks list

# 查看 Pack 贡献点
clawtwin packs list
```

---

_本文档与 `DESIGN-FINAL-MASTER-INDEX.md` 中的「可靠性机制一览」表保持双向一致。_
