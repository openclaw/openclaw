# ClawTwin 测试指南

> **版本**：v1.0.2 · 2026-05-12（§二.0 ↔ `DEV-QUICKSTART.md` §〇）
> **原则**：测什么 = 能回归的行为；怎么测 = 最快速的路径；不测什么 = 不写框架代码的测试

---

## 一、测试分层策略

```
┌────────────────────────────────────────────────────────────┐
│  E2E 测试（少量，CI 跑）                                    │
│  完整用户旅程：登录→告警→AI诊断→工单→审批→完成              │
│  工具：Playwright + real Docker Compose                     │
├────────────────────────────────────────────────────────────┤
│  集成测试（中量，每个模块的边界）                            │
│  API 端点测试：实际 DB + 实际 Redis + Mock LLM/OpenClaw    │
│  工具：pytest + httpx + TestClient                         │
├────────────────────────────────────────────────────────────┤
│  单元测试（大量，纯逻辑）                                    │
│  业务规则、状态机、计算逻辑、数据转换                        │
│  工具：pytest（后端）/ Vitest（前端）                       │
└────────────────────────────────────────────────────────────┘

覆盖率目标：
  P0 路径（工单状态机/告警评估/权限检查）：≥ 90%
  业务逻辑（计算/转换/规则）：≥ 80%
  API 端点（集成）：关键端点 100%，全部 ≥ 70%
  前端组件：关键交互 ≥ 60%
```

---

## 二、后端测试（Python + pytest）

### 2.0 工作目录（ClawTwin Nexus / platform-api）

- **pytest / Alembic /（计划中的）E2E**：在独立仓 **`clawtwin-platform/platform-api/`** 下执行（`.venv`、`alembic.ini`、`tests/` 均以该目录为 **cwd**）。**不要**在 **`openclaw`** monorepo 根目录裸跑 `pytest` 或 Alembic，否则 `alembic.ini` 相对路径等会失败（与 **`clawtwin-project/PHASE-A-PROGRESS-AUDIT.md`** §1、§8 一致）。环境与启动命令摘要见 **`DEV-QUICKSTART.md` §〇、§三**。
- **Demo 种子脚本与 compose**：以 **`platform-api`** 或 **`clawtwin-platform/`** 仓根为准，见 **`CURSOR-MULTITASK-GUIDE.md` §五 [T18]**。
- **Studio**：生产构建与未来 Vitest 在 **`clawtwin-studio/refine-clawtwin/`**。见 **`DEV-QUICKSTART.md` §〇、§四**。
- §二.1 中 **`platform/tests/`** 为历史**逻辑**树示意；实现以磁盘 **`clawtwin-platform/platform-api/tests/`** 为准。

### 2.1 目录结构

```
platform/
├── tests/
│   ├── conftest.py           # 全局 fixtures（DB、client、用户）
│   ├── unit/
│   │   ├── test_work_order_fsm.py      # 工单状态机纯逻辑
│   │   ├── test_alarm_rules.py         # 告警规则评估
│   │   ├── test_decision_package.py    # 决策包构建逻辑
│   │   ├── test_auth.py               # JWT 生成/验证
│   │   └── test_kb_chunking.py        # 文档切片逻辑
│   ├── integration/
│   │   ├── test_api_equipment.py       # 设备 API 端到端
│   │   ├── test_api_workorder.py       # 工单 HITL 流程
│   │   ├── test_api_auth.py           # 认证流程
│   │   ├── test_api_ai_jobs.py        # AI 任务流程（Mock OpenClaw）
│   │   ├── test_api_alarms.py         # 告警流程
│   │   ├── test_feishu_webhook.py     # 飞书卡片回调
│   │   └── test_mcp_server.py         # MCP 工具测试
│   └── fixtures/
│       ├── station_fixtures.py
│       ├── equipment_fixtures.py
│       └── knowledge_fixtures.py
└── pytest.ini
```

### 2.2 conftest.py（核心 fixtures）

```python
# platform/tests/conftest.py
import asyncio
import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from main import app
from db.base import Base
from db.session import get_db
from auth.jwt import create_access_token

# 测试数据库（内存 SQLite，快速）
TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()

@pytest_asyncio.fixture(scope="session")
async def test_db_engine():
    engine = create_async_engine(TEST_DATABASE_URL, echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()

@pytest_asyncio.fixture
async def db_session(test_db_engine):
    TestSession = sessionmaker(test_db_engine, class_=AsyncSession, expire_on_commit=False)
    async with TestSession() as session:
        yield session
        await session.rollback()  # 每个测试后回滚，保证隔离

@pytest_asyncio.fixture
async def client(db_session):
    """带真实 DB 的 API 测试客户端"""
    async def override_get_db():
        yield db_session
    app.dependency_overrides[get_db] = override_get_db
    async with AsyncClient(app=app, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()

# ─── 用户 fixtures ─────────────────────────────────────────────
@pytest_asyncio.fixture
async def station_1(db_session):
    from models.station import Station
    station = Station(id=1, name="泵站一", code="PS-001")
    db_session.add(station)
    await db_session.commit()
    return station

@pytest_asyncio.fixture
async def operator_user(db_session, station_1):
    from models.user import User
    from auth.password import hash_password
    user = User(
        id=1, username="test_operator",
        email="op@test.com",
        hashed_password=hash_password("test123"),
        role="operator",
        station_ids=[1]
    )
    db_session.add(user)
    await db_session.commit()
    return user

@pytest_asyncio.fixture
async def supervisor_user(db_session, station_1):
    from models.user import User
    from auth.password import hash_password
    user = User(
        id=2, username="test_supervisor",
        email="sup@test.com",
        hashed_password=hash_password("test123"),
        role="supervisor",
        station_ids=[1]
    )
    db_session.add(user)
    await db_session.commit()
    return user

@pytest.fixture
def operator_token(operator_user):
    return create_access_token({"sub": str(operator_user.id), "role": "operator", "station_ids": [1]})

@pytest.fixture
def supervisor_token(supervisor_user):
    return create_access_token({"sub": str(supervisor_user.id), "role": "supervisor", "station_ids": [1]})

# ─── Mock fixtures ─────────────────────────────────────────────
@pytest.fixture
def mock_openclaw(monkeypatch):
    """Mock OpenClaw AgentConnector - AI 立即返回成功结果"""
    async def fake_trigger(job_id, context):
        return {"job_id": job_id, "status": "accepted"}
    from services import agent_connector
    monkeypatch.setattr(agent_connector, "trigger_session", fake_trigger)

@pytest.fixture
def mock_kb_search(monkeypatch):
    """Mock 知识库语义检索（LlamaIndex + pgvector）- 返回固定搜索结果"""
    # 正确 mock 路径：kb/ingest_pipeline.py 的 search_knowledge 函数
    from kb import ingest_pipeline as kb_pipeline
    async def fake_search(query, layer=None, equipment_type=None, station_id=None, top_k=5):
        return [
            {
                "content": "测试知识片段：压缩机轴承振动超标处理程序",
                "score": 0.9,
                "doc_id": "DOC-TEST-001",
                "layer": layer or "L1",
                "title": "压缩机运维手册",
                "source": "测试手册",
            }
        ]
    monkeypatch.setattr(kb_pipeline, "search_knowledge", fake_search)

@pytest.fixture
def mock_redis(monkeypatch):
    """Mock Redis - 用内存字典替代"""
    from unittest.mock import AsyncMock, MagicMock
    mock = MagicMock()
    mock.get = AsyncMock(return_value=None)
    mock.set = AsyncMock(return_value=True)
    mock.delete = AsyncMock(return_value=1)
    from services import cache
    monkeypatch.setattr(cache, "redis_client", mock)
    return mock
```

### 2.3 工单状态机单元测试（高价值，完全可测）

```python
# platform/tests/unit/test_work_order_fsm.py
import pytest
from models.work_order import WorkOrderState, VALID_TRANSITIONS

class TestWorkOrderFSM:
    """测试工单状态机 - 纯逻辑，无 DB"""

    def test_valid_transitions(self):
        """所有合法状态转换"""
        assert "pending_approval" in VALID_TRANSITIONS["draft"]
        assert "approved" in VALID_TRANSITIONS["pending_approval"]
        assert "draft" in VALID_TRANSITIONS["pending_approval"]  # 驳回
        assert "in_progress" in VALID_TRANSITIONS["approved"]
        assert "done" in VALID_TRANSITIONS["in_progress"]

    def test_cannot_skip_review(self):
        """不能从 draft 直接跳到 approved"""
        assert "approved" not in VALID_TRANSITIONS["draft"]

    def test_cannot_reopen_done(self):
        """已完成的工单不能重新打开"""
        assert len(VALID_TRANSITIONS.get("done", [])) == 0

    def test_initial_state(self):
        """创建时初始状态必须是 draft"""
        from services.work_order import WorkOrderService
        wo = WorkOrderService.create_draft(
            equipment_id="C-101",
            title="测试工单",
            created_by_id=1
        )
        assert wo.state == WorkOrderState.DRAFT

    def test_state_field_name(self):
        """字段名必须是 state 不是 status"""
        from models.work_order import WorkOrder
        wo = WorkOrder()
        assert hasattr(wo, "state")
        assert not hasattr(wo, "status")
```

### 2.4 告警评估单元测试

```python
# platform/tests/unit/test_alarm_rules.py
import pytest
from services.alarm_evaluator import AlarmEvaluator

class TestAlarmEvaluator:
    def setup_method(self):
        self.evaluator = AlarmEvaluator()

    def test_vibration_below_warn(self):
        result = self.evaluator.evaluate("C-101", "vibration", 3.0, warn=4.5, alarm=7.1)
        assert result is None  # 无告警

    def test_vibration_warn_level(self):
        result = self.evaluator.evaluate("C-101", "vibration", 5.0, warn=4.5, alarm=7.1)
        assert result.priority == "P3"

    def test_vibration_alarm_level(self):
        result = self.evaluator.evaluate("C-101", "vibration", 8.7, warn=4.5, alarm=7.1)
        assert result.priority == "P2"

    def test_deduplicate_active_alarm(self):
        """同一设备同一指标的告警不重复创建"""
        r1 = self.evaluator.evaluate("C-101", "vibration", 8.7, warn=4.5, alarm=7.1)
        r2 = self.evaluator.evaluate("C-101", "vibration", 8.9, warn=4.5, alarm=7.1)
        assert r2 is None  # 已有活跃告警，不重复
```

### 2.5 API 集成测试

```python
# platform/tests/integration/test_api_workorder.py
import pytest

pytestmark = pytest.mark.asyncio

class TestWorkOrderAPI:
    """测试工单 HITL 完整流程"""

    async def test_create_work_order(self, client, operator_token, equipment_c101):
        """创建工单 - state 必须是 draft"""
        resp = await client.post(
            "/v1/workorders/",
            json={
                "equipment_id": "C-101",
                "title": "测试工单",
                "work_type": "inspection",
                "priority": "normal",
                "description": "测试"
            },
            headers={"Authorization": f"Bearer {operator_token}"}
        )
        assert resp.status_code == 201
        data = resp.json()["data"]
        assert data["state"] == "draft"
        assert "status" not in data  # 字段名是 state 不是 status
        return data["id"]

    async def test_submit_for_approval(self, client, operator_token, draft_work_order):
        """提交审批 - draft → pending_approval"""
        resp = await client.post(
            f"/v1/hitl/workorders/{draft_work_order['id']}/pending",
            headers={"Authorization": f"Bearer {operator_token}"}
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["state"] == "pending_approval"

    async def test_only_supervisor_can_approve(self, client, operator_token, pending_work_order):
        """普通操作员不能审批"""
        resp = await client.post(
            f"/v1/hitl/workorders/{pending_work_order['id']}/approve",
            headers={"Authorization": f"Bearer {operator_token}"}
        )
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "FORBIDDEN"

    async def test_supervisor_approves(self, client, supervisor_token, pending_work_order):
        """主管可以审批"""
        resp = await client.post(
            f"/v1/hitl/workorders/{pending_work_order['id']}/approve",
            headers={"Authorization": f"Bearer {supervisor_token}"}
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["state"] == "approved"

    async def test_invalid_state_transition(self, client, operator_token, draft_work_order):
        """非法状态转换返回 409"""
        resp = await client.post(
            f"/v1/hitl/workorders/{draft_work_order['id']}/approve",
            headers={"Authorization": f"Bearer {operator_token}"}
        )
        assert resp.status_code == 409
        error = resp.json()["error"]
        assert error["code"] == "WORK_ORDER_INVALID_STATE"
        assert "allowed_actions" in error["detail"]

    async def test_station_access_control(self, client, operator_token, other_station_work_order):
        """操作员不能访问其他场站的工单"""
        resp = await client.get(
            f"/v1/workorders/{other_station_work_order['id']}",
            headers={"Authorization": f"Bearer {operator_token}"}
        )
        assert resp.status_code == 403

    async def test_full_hitl_flow(
        self, client, operator_token, supervisor_token, equipment_c101
    ):
        """完整 HITL 流程：创建→提交→审批→开始→完成"""
        # 1. 创建
        r1 = await client.post("/v1/workorders/", json={
            "equipment_id": "C-101", "title": "完整流程测试", "work_type": "inspection"
        }, headers={"Authorization": f"Bearer {operator_token}"})
        wo_id = r1.json()["data"]["id"]

        # 2. 提交
        r2 = await client.post(f"/v1/hitl/workorders/{wo_id}/pending",
            headers={"Authorization": f"Bearer {operator_token}"})
        assert r2.json()["data"]["state"] == "pending_approval"

        # 3. 审批
        r3 = await client.post(f"/v1/hitl/workorders/{wo_id}/approve",
            headers={"Authorization": f"Bearer {supervisor_token}"})
        assert r3.json()["data"]["state"] == "approved"

        # 4. 开始执行
        r4 = await client.post(f"/v1/hitl/workorders/{wo_id}/start",
            headers={"Authorization": f"Bearer {operator_token}"})
        assert r4.json()["data"]["state"] == "in_progress"

        # 5. 完成
        r5 = await client.post(f"/v1/hitl/workorders/{wo_id}/done",
            headers={"Authorization": f"Bearer {operator_token}"})
        assert r5.json()["data"]["state"] == "done"
```

### 2.6 认证安全测试

```python
# platform/tests/integration/test_api_auth.py
class TestAuthSecurity:
    async def test_no_token_returns_401(self, client):
        resp = await client.get("/v1/equipment")
        assert resp.status_code == 401

    async def test_expired_token_returns_401(self, client):
        from auth.jwt import create_access_token
        from datetime import timedelta
        expired = create_access_token({"sub": "1"}, expires_delta=timedelta(seconds=-1))
        resp = await client.get("/v1/equipment",
            headers={"Authorization": f"Bearer {expired}"})
        assert resp.status_code == 401
        assert resp.json()["error"]["code"] == "TOKEN_EXPIRED"

    async def test_station_injection_blocked(self, client, operator_token):
        """station_id 不能从 body 注入，必须从 JWT 验证"""
        # 操作员只有 station_id=1 权限，尝试访问 station_id=99
        resp = await client.get("/v1/equipment?station_id=99",
            headers={"Authorization": f"Bearer {operator_token}"})
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "STATION_ACCESS_DENIED"

    async def test_feishu_webhook_without_signature(self, client):
        """飞书 Webhook 没有签名时拒绝"""
        resp = await client.post("/v1/feishu/events",
            json={"header": {"event_type": "card.action.trigger"}, "event": {}})
        assert resp.status_code == 401
```

### 2.7 飞书 Webhook 测试

```python
# platform/tests/integration/test_feishu_webhook.py
class TestFeishuWebhook:
    async def test_url_verification(self, client):
        """URL 验证挑战"""
        resp = await client.post("/v1/feishu/events", json={
            "header": {"event_type": "url_verification"},
            "event": {"challenge": "test_challenge_xxx"}
        }, headers={"X-Lark-Signature": self._compute_sig(...)})
        assert resp.status_code == 200
        assert resp.json()["challenge"] == "test_challenge_xxx"

    async def test_im_message_not_handled(self, client, valid_feishu_headers):
        """im.message.receive_v1 不应该被 Nexus 处理"""
        resp = await client.post("/v1/feishu/events",
            json={
                "header": {"event_type": "im.message.receive_v1"},
                "event": {"message": {"content": "你好"}}
            },
            headers=valid_feishu_headers)
        # 必须返回 200（不报错），但不处理（Nexus 只是忽略）
        assert resp.status_code == 200
        assert resp.json() == {"code": 0}

    async def test_card_approve_action(self, client, valid_feishu_headers, pending_work_order):
        """卡片审批按钮点击"""
        resp = await client.post("/v1/feishu/events",
            json={
                "header": {"event_type": "card.action.trigger"},
                "event": {
                    "operator": {"open_id": "ou_supervisor"},
                    "action": {"value": {
                        "action": "approve",
                        "work_order_id": str(pending_work_order["id"])
                    }}
                }
            },
            headers=valid_feishu_headers)
        assert resp.status_code == 200
        assert resp.json()["toast"]["type"] == "success"
```

### 2.8 MCP Server 测试

```python
# platform/tests/integration/test_mcp_server.py
class TestMCPServer:
    async def test_list_tools(self, client, service_token):
        """MCP 工具列表"""
        resp = await client.post("/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            headers={"Authorization": f"Bearer {service_token}"})
        assert resp.status_code == 200
        tools = {t["name"] for t in resp.json()["result"]["tools"]}
        # 必须包含所有核心工具
        assert "get_equipment_context" in tools
        assert "search_knowledge_base" in tools
        assert "create_work_order" in tools
        assert "get_active_alarms" in tools

    async def test_get_equipment_context(self, client, service_token, equipment_c101):
        """MCP 工具调用 - 返回完整上下文"""
        resp = await client.post("/mcp",
            json={
                "jsonrpc": "2.0", "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "get_equipment_context",
                    "arguments": {"equipment_id": "C-101"}
                }
            },
            headers={"Authorization": f"Bearer {service_token}"})
        assert resp.status_code == 200
        content = resp.json()["result"]["content"][0]["text"]
        import json
        ctx = json.loads(content)
        assert ctx["equipment_id"] == "C-101"
        assert "readings" in ctx

    async def test_mcp_requires_service_token(self, client, operator_token):
        """MCP 不允许普通用户 JWT 访问"""
        resp = await client.post("/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            headers={"Authorization": f"Bearer {operator_token}"})
        assert resp.status_code == 401
```

### 2.9 运行测试命令

```bash
cd platform

# 全部测试（带覆盖率）
pytest tests/ --cov=. --cov-report=html --cov-report=term -v

# 仅单元测试（快，1-5s）
pytest tests/unit/ -v

# 仅集成测试（中，10-30s）
pytest tests/integration/ -v

# 特定模块
pytest tests/integration/test_api_workorder.py -v -k "test_full_hitl"

# 失败后停止
pytest tests/ -x

# 并发跑（谨慎，有 DB 竞争）
pytest tests/unit/ -n 4  # 只对单元测试开并发
```

---

## 三、前端测试（Vitest + Testing Library）

### 3.1 目录结构

```
studio/
├── src/
│   ├── components/
│   │   ├── alerts/
│   │   │   ├── AlarmQueuePanel.tsx
│   │   │   └── AlarmQueuePanel.test.tsx  ← 同级 test 文件
│   │   └── workorder/
│   │       ├── WorkOrderDraftInline.tsx
│   │       └── WorkOrderDraftInline.test.tsx
│   ├── hooks/
│   │   ├── useAlarms.ts
│   │   └── useAlarms.test.ts
│   └── stores/
│       ├── twin.store.ts
│       └── twin.store.test.ts
├── src/mocks/
│   ├── handlers/            ← MSW handlers（开发 + 测试共用）
│   │   ├── equipment.ts
│   │   ├── workorders.ts
│   │   └── alarms.ts
│   └── server.ts            ← MSW Node 服务器（测试用）
└── vitest.config.ts
```

### 3.2 vitest.config.ts

```typescript
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/mocks/**", "src/**/*.test.*", "src/test-setup.ts"],
    },
  },
});
```

### 3.3 src/test-setup.ts

```typescript
import "@testing-library/jest-dom";
import { beforeAll, afterEach, afterAll } from "vitest";
import { server } from "./mocks/server";

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

### 3.4 MSW handlers（测试与开发共用）

```typescript
// src/mocks/handlers/workorders.ts
import { http, HttpResponse } from "msw";

export const workorderHandlers = [
  http.get("/v1/workorders", ({ request }) => {
    const url = new URL(request.url);
    const stationId = url.searchParams.get("station_id");
    return HttpResponse.json({
      data: [
        {
          id: 42,
          state: "draft",
          equipment_id: "C-101",
          title: "测试工单",
          priority: "urgent",
          created_at: new Date().toISOString(),
        },
      ],
      meta: { page: 1, size: 20, total: 1 },
    });
  }),

  http.post("/v1/workorders/", async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json(
      {
        data: {
          id: 42,
          state: "draft", // ← 永远是 draft，不管请求传什么
          ...body,
          created_at: new Date().toISOString(),
        },
      },
      { status: 201 },
    );
  }),

  http.post("/v1/hitl/workorders/:id/approve", ({ params }) => {
    return HttpResponse.json({
      data: { id: Number(params.id), state: "approved" },
    });
  }),

  // 错误场景
  http.post("/v1/hitl/workorders/999/approve", () => {
    return HttpResponse.json(
      {
        error: {
          code: "WORK_ORDER_INVALID_STATE",
          message: "工单状态不允许此操作",
          detail: { current_state: "draft", allowed_actions: ["pending"] },
        },
      },
      { status: 409 },
    );
  }),
];
```

### 3.5 Zustand store 测试

```typescript
// src/stores/twin.store.test.ts
import { act, renderHook } from "@testing-library/react";
import { useTwinStore } from "./twin.store";

describe("TwinStore", () => {
  beforeEach(() => {
    useTwinStore.setState({
      currentStationId: 1,
      selectedEquipmentId: null,
      equipmentList: [],
    });
  });

  test("切换站场时清除已选设备", () => {
    const { result } = renderHook(() => useTwinStore());
    act(() => result.current.setSelectedEquipmentId("C-101"));
    expect(result.current.selectedEquipmentId).toBe("C-101");

    act(() => result.current.setCurrentStation(2));
    expect(result.current.currentStationId).toBe(2);
    expect(result.current.selectedEquipmentId).toBeNull(); // 已清除
  });

  test("currentStationId 变化触发 SSE 重连（通过副作用）", () => {
    // 测试 SSE hook 响应 stationId 变化
    const closeCount = { n: 0 };
    vi.spyOn(global, "EventSource").mockImplementation(
      () =>
        ({
          close: () => closeCount.n++,
          addEventListener: vi.fn(),
        }) as unknown as EventSource,
    );

    const { result } = renderHook(() => useTwinStore());
    act(() => result.current.setCurrentStation(2));
    // 旧 SSE 关闭，新 SSE 建立 → 通过 useSSE hook 的 effect 测试
  });
});
```

### 3.6 关键组件测试

```typescript
// src/components/workorder/WorkOrderDraftInline.test.tsx
import { render, screen, userEvent, waitFor } from "@testing-library/react";
import { WorkOrderDraftInline } from "./WorkOrderDraftInline";

const setup = () => render(
  <WorkOrderDraftInline
    equipmentId="C-101"
    triggeredFrom="alarm"
    onCreated={vi.fn()}
    onCancel={vi.fn()}
  />
);

test("显示 AI 预填草稿", async () => {
  setup();
  // 触发 AI 预填
  await userEvent.click(screen.getByRole("button", { name: /AI 生成草稿/ }));
  await waitFor(() => {
    expect(screen.getByText(/振动超限处理/)).toBeInTheDocument();
  });
});

test("创建工单后 state 为 draft", async () => {
  const onCreated = vi.fn();
  render(<WorkOrderDraftInline ... onCreated={onCreated} />);
  await userEvent.click(screen.getByRole("button", { name: /确认创建/ }));
  await waitFor(() => {
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ state: "draft" })
    );
  });
});

test("P1 告警触发全屏调查模式", async () => {
  render(
    <DeviceIntelPanel
      equipment={mockEquipmentWithP1Alarm}
      alarms={[{ priority: "P1", message: "...", id: 1 }]}
    />
  );
  // P1 告警必须显示 InvestigationBanner，不能只用 toast
  expect(screen.getByTestId("investigation-banner")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // 无 toast
});
```

### 3.7 运行测试

```bash
cd studio

# 全部测试
pnpm test

# 带覆盖率
pnpm test --coverage

# 监听模式（开发时）
pnpm test --watch

# 特定文件
pnpm test src/components/workorder/WorkOrderDraftInline.test.tsx

# UI 模式（可视化）
pnpm test --ui
```

---

## 四、CI/CD 集成

### 4.1 GitHub Actions 工作流

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, dev]
  pull_request:
    branches: [main]

jobs:
  # ── 后端测试 ──────────────────────────────
  backend-test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: timescale/timescaledb-ha:pg16-latest
        env:
          POSTGRES_DB: clawtwin_test
          POSTGRES_USER: clawtwin
          POSTGRES_PASSWORD: test123
        ports: ["5432:5432"]
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }

      - name: Install deps
        run: cd platform && pip install -r requirements.txt -r requirements-test.txt

      - name: Run tests
        env:
          DATABASE_URL: postgresql+asyncpg://clawtwin:test123@localhost:5432/clawtwin_test
          REDIS_URL: redis://localhost:6379/0
          AI_MOCK_ENABLED: "true"
          AGENT_RUNTIME: "mock"
        run: |
          cd platform
          pytest tests/ --cov=. --cov-report=xml -q
          # 覆盖率门槛
          coverage report --fail-under=70

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with: { files: platform/coverage.xml }

  # ── 前端测试 ──────────────────────────────
  frontend-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: cd studio && pnpm install
      - run: cd studio && pnpm test --coverage --reporter=verbose
      - run: cd studio && pnpm build # 确保构建不报错

  # ── 类型检查 ──────────────────────────────
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: cd studio && pnpm install
      - run: cd studio && pnpm tsc --noEmit

  # ── Lint ──────────────────────────────────
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cd platform && pip install ruff
      - run: cd platform && ruff check . && ruff format --check .
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: cd studio && pnpm install && pnpm lint
```

### 4.2 pytest.ini 配置

```ini
# platform/pytest.ini
[pytest]
asyncio_mode = auto
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
addopts =
    -v
    --tb=short
    --strict-markers
markers =
    slow: 标记为慢测试（CI 中可 -m "not slow" 跳过）
    integration: 集成测试（需要 DB）
    unit: 纯单元测试（无 DB）
```

---

## 五、关键测试清单（每次 PR 必须通过）

```
后端：
□ 工单状态机：所有合法转换 ✓，所有非法转换返回 409 ✓
□ 安全：无 Token 返回 401 ✓，跨场站访问返回 403 ✓，station_id 注入被阻止 ✓
□ 飞书：im.message.receive_v1 返回 200 且不处理 ✓，卡片回调正常 ✓
□ MCP：工具列表包含所有核心工具 ✓，ServiceToken 必须 ✓

前端：
□ P1 告警显示 InvestigationBanner，不用 toast ✓
□ 工单创建后 state 显示 "draft" ✓
□ 切换站场清除已选设备 ✓
□ AI 诊断触发 SSE 订阅，而非轮询 ✓

共同：
□ API 错误格式统一（error.code + message） ✓
□ 所有测试 < 60s 完成（单元 + 集成合计） ✓
```

---

_本文档聚焦"能回归的行为"，不追求 100% 覆盖率，而追求 P0 行为的完全可测试性。_
