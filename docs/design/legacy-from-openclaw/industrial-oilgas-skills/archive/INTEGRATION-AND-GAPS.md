# ClawTwin 集成架构 & 空白分析

## 架构师视角的完整性检查

**版本**：2026-05-08  
**结论**：当前方案有 5 个功能空白 + 6 个安全漏洞（见 ADR-6），需在 Phase A 修复安全基线

---

## 一、飞书集成——两条独立通道

> ⚠️ 重要纠正（见 ADR-5）：OpenClaw 是「团队粒度」部署，不是「用户粒度」。
> 100个用户共用 1个 OpenClaw Gateway 实例，用户身份由 feishu_open_id 区分。
> 飞书私有化部署时 API 只需改 BASE_URL，且全程内网比公有云更简单。

### 1.1 两条通道的本质区别

```
通道 A：用户 AI 对话（OpenClaw 原生集成，团队共用1个 Gateway）
  员工手机/PC（飞书App）
    → 飞书服务器（公有云 or 企业私有化部署）
      → [企业网络] → OpenClaw Gateway（1个实例服务全公司）
        · 通过 feishu_open_id 识别用户身份
        · 查 Platform user registry → 确认用户有权访问哪些场站
        → OpenClaw Agent 推理（调用 industrial-* Skills）
          → Skills 调用 Platform Tool API（带用户身份）
            → Platform 返回数据 + citations（仅返回有权限的数据）
              → OpenClaw 组装回复 → 通过飞书 Bot 回复用户

通道 B：系统通知 & HITL 卡片（Platform 主动推送）
  Platform Scheduler（每小时异常轮询）
    → MOIRAI 检测到异常
      → Platform FeishuClient → 飞书服务器 API → 告警卡片 → 值班群
        → 用户点击卡片上的「✅ 批准」按钮
          → 飞书服务器 POST 回调 → Platform /v1/feishu/webhook
            → Platform 处理：工单状态 APPROVED + 写 L3 知识
```

### 1.2 两条通道的飞书 App 规划

```
方案：Phase A 用单个飞书 App（简化），Phase B 拆成两个

Phase A（开发/单站 Demo）：
  单个飞书 App：ClawTwin
  · OpenClaw 和 Platform 共用同一个 App 的 Bot 账号
  · 权限：im:message, im:message:send_as_bot, im:chat
  · 事件订阅：
    - im.message.receive_v1 → 回调 OpenClaw（AI 对话）
    - card.action.trigger   → 回调 Platform（HITL 审批）
  · 飞书后台配置两个回调 URL

飞书私有化时 API 适配：
  os.getenv("FEISHU_SERVER_URL") or "https://open.feishu.cn"   # 标准键名（FEISHU_SERVER_URL）
  私有化只需改这一个环境变量，所有 API 调用自动适配
  全程内网不需要 ngrok，不需要公网 IP（比公有云更简单）
```

### 1.3 Platform 飞书 Webhook 接收端（目前缺失）

```python
# platform-api/routers/feishu_webhook.py（新增，目前 SCAFFOLD 缺失）

from fastapi import APIRouter, Request, HTTPException
import hashlib, hmac, json, os

router = APIRouter()

FEISHU_VERIFY_TOKEN = os.getenv("FEISHU_VERIFY_TOKEN", "")
FEISHU_ENCRYPT_KEY  = os.getenv("FEISHU_ENCRYPT_KEY",  "")

@router.post("/v1/feishu/webhook")
async def feishu_webhook(request: Request):
    """
    接收飞书事件回调：
    1. URL 验证（飞书首次配置时发 challenge）
    2. 卡片按钮点击事件（工单审批 approve/reject）
    """
    body = await request.json()

    # 1. 飞书 URL 验证（配置 webhook 时第一次调用）
    if "challenge" in body:
        return {"challenge": body["challenge"]}

    # 2. 签名验证（生产必须开启）
    # signature = request.headers.get("X-Lark-Signature", "")
    # verify_signature(body_bytes, signature, FEISHU_VERIFY_TOKEN)

    # 3. 处理卡片按钮事件
    event_type = body.get("type", "")
    if event_type == "card.action.trigger":
        action_value = body.get("action", {}).get("value", {})
        action_type = action_value.get("action")
        wo_id = action_value.get("wo_id")
        eq_id = action_value.get("eq_id")
        operator_id = body.get("operator", {}).get("open_id", "")

        if action_type == "approve" and wo_id:
            from hitl.workorder_fsm import handle_approval
            await handle_approval(wo_id, approved=True, approver_id=operator_id)
            return {"toast": {"type": "success", "content": f"工单 {wo_id} 已批准"}}

        elif action_type == "reject" and wo_id:
            from hitl.workorder_fsm import handle_approval
            await handle_approval(wo_id, approved=False, approver_id=operator_id)
            return {"toast": {"type": "info", "content": "已拒绝，草稿关闭"}}

        elif action_type == "ack" and eq_id:
            # 告警确认处理
            return {"toast": {"type": "success", "content": f"{eq_id} 告警已确认"}}

    return {"status": "ok"}
```

**开发环境 ngrok 配置：**

```bash
# 安装 ngrok 并暴露 Platform webhook 端点
ngrok http 8080

# ngrok 会给一个公网 URL，如 https://abc123.ngrok.io
# 在飞书开放平台配置：
# 事件请求地址：https://abc123.ngrok.io/v1/feishu/webhook
# 验证 Token 和加密 Key 填入 .env
```

---

## 二、整体系统集成图（完整版）

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        飞书（外部 SaaS）                                    │
│  用户 Feishu App（手机/PC）           飞书服务器（Event Callback）           │
└───────┬───────────────────────────────────────┬────────────────────────────┘
        │ 消息发送（App 1: ClawTwin-OpenClaw）   │ 卡片回调（App 2: Platform）
        ▼                                       ▼
┌───────────────────────┐          ┌─────────────────────────────────────────┐
│  OpenClaw Gateway     │          │  ClawTwin Platform（我们开发）            │
│  （独立产品，用户部署）│          │                                           │
│  Feishu Channel ✅    │          │  POST /v1/feishu/webhook  ←─ 飞书回调  │
│  Agent 推理 ✅        │          │  （⚠️ 当前缺失，需补充）                  │
│  Skills：             │          │                                           │
│  · industrial-twin    │──HTTP──▶│  Industrial Ontology Layer               │
│  · industrial-kb      │          │  /v1/objects/equipment/{id}              │
│  · industrial-workorder│         │  /v1/objects/workorder                   │
│  · industrial-analytics│         │                                           │
└───────────────────────┘          │  Industrial Tool API                     │
                                   │  /v1/tools/kb/search                     │
                                   │  /v1/tools/anomaly/detect                │
                                   │  /v1/tools/workorder/draft               │
                                   │                                           │
┌───────────────────────┐          │  Platform Scheduler（APScheduler）       │
│  ClawTwin Studio      │──HTTP──▶│  晨报 Cron / 每小时异常轮询               │
│  （浏览器，基于        │          │  → FeishuClient 直接发 App2 消息         │
│   maibot-ui 改造）    │          │                                           │
│  /twin  3D 数字孪生   │          │  HITL 工单状态机                         │
│  /command 全屏指挥     │          │  草稿 → 飞书审批卡片 → 回调处理           │
│  /admin  知识管理      │          │                                           │
└───────────────────────┘          │  ⚠️ 缺失：身份认证（JWT/API Key）         │
                                   │  ⚠️ 缺失：ABAC 多站权限                  │
                                   └──────────────────┬──────────────────────┘
                                                      │ 接口调用
                ┌─────────────────────────────────────┴─────────────────────┐
                │                开源基础设施                                │
                │  Ditto (孪生) │ Milvus (向量) │ PostgreSQL │ MinIO         │
                │  Kafka (消息) │ Redis (缓存)  │ GraphRAG  │               │
                └─────────────────────────────────────────────────────────┘
                                                      │
                         ┌────────────────────────────┴───────────────────┐
                         │           外部数据源                             │
                         │  OPC-UA / IMS    知识文档 (PDF)    GPU 服务器   │
                         │  （⚠️ 对接规范    （⚠️ Admin 上传   vLLM / MOIRAI│
                         │   需补充）         UI 需补充）      Embedding    │
                         └──────────────────────────────────────────────┘
```

---

## 三、五大空白——逐一分析和填补方案

### 空白 1：飞书 Webhook 接收端（⚠️ 缺失）

**问题**：Platform 发出飞书卡片后，用户点击按钮，飞书会 POST 回调到 Platform，但当前没有这个接收端。

**填补**：

```
新增：platform-api/routers/feishu_webhook.py
      POST /v1/feishu/webhook
      · challenge 验证（飞书配置时）
      · 卡片按钮回调处理（approve/reject/ack）
      · 签名验证（生产环境）

部署要求：
  开发：ngrok http 8080（临时公网 URL）
  生产：Nginx + Let's Encrypt SSL（固定域名）
        platform.clawtwin.local → 客户内网 + 反向代理
```

### 空白 2：Platform API 身份认证（⚠️ 缺失）

**问题**：OpenClaw 调用 `/v1/tools/*` 时，Platform 如何验证调用者身份？当前 Platform API 没有任何鉴权。

**填补方案（两阶段）：**

```
Phase A（开发阶段）：简单 API Key
  请求头：Authorization: Bearer clawtwin-dev-key-xxxx
  Platform 在 .env 配置 CLAWTWIN_API_KEY
  OpenClaw Skill 配置 CLAWTWIN_API_KEY 环境变量

Phase B（生产阶段）：JWT + 用户身份
  OpenClaw 用户登录 Platform Admin → 获取 JWT
  JWT payload 包含：user_id, station_ids[], role
  Platform 每个 API 端点验证 JWT 并应用 ABAC 权限

实现：
  platform-api/auth/
    api_key.py    ← Phase A：简单 API Key 验证
    jwt_auth.py   ← Phase B：JWT 验证 + ABAC
    depends.py    ← FastAPI dependency（统一鉴权入口）
```

### 空白 3：IMS 对接层（⚠️ 缺失）

**IMS 是什么**：用户现场已有的管理系统，可能是：

- **OPC-UA 服务器**（实时数据）→ 已有 opcua-bridge 覆盖
- **SCADA 系统**（实时报警历史）→ 需要自定义 Adapter
- **CMMS（Maximo/SAP PM）**（历史工单/设备台账）→ 需要数据迁移
- **Excel/CSV**（小型企业的"手工台账"）→ 需要批量导入工具

**填补方案：**

```
新增：platform-api/ims/
  adapter_base.py     ← IMS Adapter 抽象接口（所有 IMS 实现此接口）
  opcua_adapter.py    ← 已有 opcua-bridge 的 Python 版本
  rest_adapter.py     ← 通用 REST API Adapter（配置 URL/method/mapping）
  csv_import.py       ← CSV 历史工单批量导入（入职工具）

接口定义：

class IMSAdapter(ABC):
    async def list_equipment(self) -> list[EquipmentRecord]: ...
    async def get_alarms(self, since: datetime) -> list[AlarmRecord]: ...
    async def get_work_orders(self, since: datetime) -> list[WorkOrderRecord]: ...
    async def get_time_series(self, eq_id, metric, start, end) -> list[DataPoint]: ...

IMS 对接流程（客户现场部署时）：
  1. 工程师确认客户 IMS 类型（OPC-UA / REST / CSV 导出）
  2. 配置对应 Adapter 的连接参数（.env）
  3. 运行 csv_import.py 导入历史工单 → PostgreSQL
  4. 历史工单经过 AI 处理 → 批量写入 L3 kb_documents（层=L3）+ Milvus 向量化
  5. 实时数据通过 opcua-bridge 持续同步 → Ditto
```

### 空白 4：知识库 Admin 上传 UI（⚠️ 缺失）

**问题**：有 ingestion-service，但没有用户界面让知识管理员上传 PDF。

**填补方案：**

```
在 ClawTwin Studio 的 /admin 路由下新增：

/admin/knowledge
  ├── 文档列表（已入库文档，支持按 layer/type 过滤）
  ├── 上传新文档（拖拽 PDF + 填写元数据：layer/equipment_type/标准编号）
  ├── 入库状态（处理中/完成/失败，进度条）
  └── GraphRAG 重建触发（手动触发增量重建）

实现：
  Studio：src/pages/admin/KnowledgeAdminPage.tsx
  Platform API：
    GET  /v1/kb/documents        → 已入库文档列表 + 状态
    POST /v1/ingest/document     → 上传文档（multipart）
    GET  /v1/ingest/status/{id}  → 入库状态查询（轮询）
    POST /v1/ingest/graphrag/rebuild → 触发 GraphRAG 增量重建
```

### 空白 5：多用户 / 多场站 ABAC 权限（⚠️ 缺失）

**问题**：当前设计中，Platform API 没有用户概念，没有权限控制。

**用户权限矩阵：**

```
角色            场站权限      操作权限
───────────────────────────────────────────────────────
场站操作员      仅本站        查询设备/知识，生成工单草稿
场站主管        仅本站        以上 + 审批工单
区域工程师      所辖多站      查询 + 分析，不能审批工单
知识管理员      所辖范围      以上 + 上传/管理知识文档
系统管理员      全部          所有操作

实现路径（Phase B，不影响 Phase A 开发）：
  PostgreSQL: users表 + user_stations表 + roles表
  JWT payload: { user_id, station_ids: ["S001","S002"], role: "operator" }
  FastAPI Depends: 每个 API 验证 station_id 是否在 user.station_ids 中
  Studio: 登录页 → 获取 JWT → 存 localStorage → 后续请求带 Bearer
```

---

## 四、maibot-ui → ClawTwin Studio 迁移步骤

### 4.1 为什么要复制而不是引用

```
原因：
  · maibot-ui 是 openclaw 项目的 UI（功能和结构都是通用的）
  · ClawTwin Studio 需要添加大量工业特定的页面和组件
  · 不能改动 openclaw 仓库里的 maibot-ui（不符合架构边界原则）
  · 需要独立管理 clawtwin-studio 的版本和发布

结论：复制，重命名，按工业需求裁剪和扩展
```

### 4.2 具体步骤

```bash
# 1. 在 clawtwin-platform 项目根目录执行
cp -r /Users/power/Projects/archive/maibot-ui ./clawtwin-studio
cd clawtwin-studio

# 2. 修改 package.json（只改 name，不改依赖版本）
# 将 "name": "maibot-ui" 改为 "name": "@clawtwin/studio"

# 3. 删除与工业无关的页面（减少代码量）
# 删除（这些是 openclaw 企业版功能，ClawTwin 不需要）：
rm -rf src/pages/ExpertMarketPage.tsx
rm -rf src/pages/MarketplacePage.tsx
rm -rf src/pages/BillingPage.tsx
rm -rf src/pages/EmployeeListPage.tsx
rm -rf src/pages/EmployeeProfilePage.tsx
rm -rf src/pages/EmployeeAutopilotNarrowPage.tsx

# 4. 环境变量（添加工业特有的）
cat >> .env.example << 'EOF'
VITE_PLATFORM_URL=http://localhost:8080     # ClawTwin Platform API
VITE_STATION_ID=S001                        # 当前场站 ID
EOF
```

### 4.3 保留和扩展的文件

```
保留（核心，不改）：
  src/shell/DesktopShell.tsx       ← 三栏布局（左/中/右）
  src/shell/PanelShell.tsx         ← AI 对话面板
  src/chat/AssistantThread.tsx     ← AI 对话线程（接 OpenClaw）
  packages/store/                  ← Zustand 状态管理
  packages/adapter/                ← OpenClaw Gateway WebSocket 接入

删除（与工业无关）：
  src/pages/ExpertMarketPage.tsx 等（见上方）

新增（工业 UI）：
  src/pages/TwinPage.tsx           ← /twin：3D 数字孪生主页面
  src/pages/CommandPage.tsx        ← /command：指挥大屏（全屏）
  src/pages/admin/KnowledgeAdminPage.tsx  ← /admin/knowledge：知识管理
  src/pages/admin/EquipmentAdminPage.tsx  ← /admin/equipment：设备台账

  src/surfaces/TwinSurface.tsx           ← Babylon.js 3D 场景
  src/surfaces/EquipmentDetailPanel.tsx  ← 设备详情右侧面板
  src/surfaces/KPIDashboard.tsx          ← KPI 仪表盘
  src/surfaces/WorkOrderBoard.tsx        ← 工单看板

修改（路由扩展）：
  src/router.tsx         ← 添加 /twin, /command, /admin/knowledge
  src/pages/MainShell.tsx ← 左侧 Rail 增加工业入口图标
```

### 4.4 OpenClaw Gateway 接入方式（已有，不需要改）

```
maibot-ui 通过 @maibot/store 中的 gatewayUrl + WebSocket 连接 OpenClaw Gateway
OpenClaw 发来消息 → packages/adapter/ 转成 assistant-ui 格式 → 显示在 AI 对话区

ClawTwin Studio 不需要改这个连接逻辑：
  用户配置：OPENCLAW_GATEWAY_URL（在 Studio 设置页填写）
  效果：Studio 的 AI 对话区 = 用户自己的 OpenClaw Agent（装了 industrial Skills）

这意味着：
  用户在 Studio 里问"C-001 状态？"
  → Studio 发给 OpenClaw Gateway
  → OpenClaw 调用 industrial-twin Skill 的 twin_read 工具
  → Platform 返回设备状态
  → OpenClaw 回复 Studio
  → Studio AI 对话区显示结果（含 citations）
```

---

## 五、系统完整性检查清单

### 5.1 用户场景覆盖

| 场景                 | 实现状态                           | 缺口                    |
| -------------------- | ---------------------------------- | ----------------------- |
| 值班员飞书查设备状态 | ✅ OpenClaw + industrial-twin      | 需配置 App 1            |
| 值班员飞书问 AI 根因 | ✅ OpenClaw + industrial-kb        | 需知识库初始数据        |
| 值班员飞书建工单     | ✅ OpenClaw + industrial-workorder | 需飞书 Webhook（空白1） |
| 主管飞书审批工单     | ⚠️ 需 Webhook 接收回调             | **空白1 阻塞**          |
| 工程师看 3D 孪生     | ✅ Studio /twin（需开发）          | Scaffold 已给代码       |
| 工程师看设备详情     | ✅ Studio 右侧面板（需开发）       | Scaffold 已给代码       |
| 每日晨报             | ✅ Platform Scheduler              | 需配置 App 2            |
| 凌晨异常告警         | ✅ Platform Scheduler              | 需配置 App 2            |
| 知识管理员上传手册   | ⚠️ API 有，UI 缺                   | **空白4**               |
| 接入客户 OPC-UA      | ✅ opcua-bridge（profiles）        | 需客户 OPC-UA 地址      |
| 导入历史工单（IMS）  | ⚠️ 没有 csv_import                 | **空白3**               |
| 区域经理看多站 KPI   | ⚠️ 无权限，无多站视图              | **空白5**（Phase B）    |

### 5.2 技术组件覆盖

| 组件                   | 状态                   | 备注                          |
| ---------------------- | ---------------------- | ----------------------------- |
| Platform Ontology API  | ✅ 设计完整，代码有    | Mock 数据，待接真实           |
| Platform Tool API      | ✅ 设计完整，接口定义  | 各服务需实现                  |
| Platform Scheduler     | ✅ 代码有              | 需配置飞书 App 2              |
| HITL 状态机            | ✅ 代码有              | **需要 Webhook（空白1）**     |
| Feishu Webhook 接收    | ❌ **缺失**            | **空白1，需新增**             |
| Platform API 鉴权      | ❌ **缺失**            | **空白2，Phase A 用 API Key** |
| IMS Adapter            | ❌ **缺失**            | **空白3**                     |
| KB Admin UI            | ❌ **缺失**            | **空白4**                     |
| ABAC 权限              | ❌ **缺失**            | **空白5，Phase B**            |
| Milvus 知识库（真实）  | ⚠️ 服务有，数据无      | 需摄入 L0/L1 文档             |
| GraphRAG               | ⚠️ 服务有，数据无      | 需在文档上运行                |
| MOIRAI 服务            | ⚠️ 设计有，代码无      | Phase A 用 mock               |
| Studio /twin           | ⚠️ Scaffold 有，未实现 | Day 5-7 任务                  |
| Studio AI 对话         | ✅ maibot-ui 已有      | 复制后保留                    |
| Studio /admin          | ⚠️ 路由无，UI 无       | **空白4**                     |
| OpenClaw Skills（4个） | ✅ 完整                | 需部署到用户 OpenClaw         |

---

## 六、Phase A 优先级（修订后，含空白填补）

```
Week 1（基础 + Ontology + 3D）：原计划不变

Week 2（OpenClaw 接入 + 飞书 HITL）：

  必须完成（阻塞 demo）：
  ① 飞书 Webhook 端点（/v1/feishu/webhook）← 补空白1
     · 实现 challenge 验证
     · 实现工单审批回调处理
     · ngrok 配置（开发环境）

  ② Platform API Key 鉴权（简单 API Key）← 补空白2
     · FastAPI Depends 验证 Authorization header
     · .env 配置 CLAWTWIN_API_KEY
     · OpenClaw Skill 配置同一 API Key

  应在 Week 2 完成（不阻塞 demo 但需要）：
  ③ CSV 工单批量导入工具 ← 部分补空白3
     · 简单 Python 脚本，读 CSV → 写 PostgreSQL
     · 同时触发 L3 批量写入（kb_documents layer=L3 + Milvus，初始化场站知识）

  可以推迟到 Week 3+：
  ④ Studio /admin/knowledge UI ← 空白4（Phase B 前）
  ⑤ ABAC 权限 ← 空白5（Phase B）
```

---

## 七、生产部署网络拓扑

```
客户现场（内网）：
  ┌──────────────────────────────────────────────────────────┐
  │  clawtwin-platform 服务器（Mac 或 Linux）                 │
  │  · platform-api:8080                                     │
  │  · postgres / ditto / milvus / kafka 等                  │
  └──────────────────────────────────────────────────────────┘
          │ 内网 LAN
          ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Nginx（反向代理 + SSL 终止）                             │
  │  · https://clawtwin.company.com → platform-api:8080      │
  │  · https://studio.company.com  → clawtwin-studio:3000   │
  │  · 飞书 Webhook 需要此公网/内网域名可达                   │
  └──────────────────────────────────────────────────────────┘
          │ 公网（或通过企业内网穿透）
          ▼
  飞书服务器（事件回调）
```

```
GPU 服务器（同一内网或通过 VPN）：
  · vLLM + Qwen3.6-35B-A3B INT4（:8000，OpenAI-compatible）
  · MOIRAI 2.0 Large（:8888）
  · embedding service（:8001）
  · VLLM_BASE_URL 填入 platform-api .env
```

---

## 八、生态系统接入——甲方已有系统的协作模式

> 本节补充自多轮架构澄清对话（2026-05），固化为设计文档。

### 7.1 审批动作执行链路（完整路径）

审批后「执行」不等于「AI 直控设备」，要分动作类型：

| 动作类型           | 执行位置                             | Platform 角色                             |
| ------------------ | ------------------------------------ | ----------------------------------------- |
| **工单状态变更**   | Platform（HITL FSM）                 | 主体；审计主表                            |
| **飞书通知执行人** | 飞书（Platform 调 sendMessage）      | 触发方                                    |
| **回写 CMMS 工单** | CMMS（Platform Adapter 调 CMMS API） | 幂等写回；需 CMMS 提供写接口              |
| **现场作业执行**   | **人**（执行人去现场）               | Platform 收执行完成证据（照片/文字）      |
| **工艺控制动作**   | **DCS/SCADA（操作员执行）**          | Platform **不直控**；可生成操作票待人确认 |

```
完整审批执行时序：
  AI 起草草稿 (DRAFT)
    → 用户 Studio 点「提交审批」
      → Platform: DRAFT → PENDING_APPROVAL
        → [Option A] 直接发飞书卡片（主管手机收到）
        → [Option B] 调 OA 系统 API 创建审批单（主管在 OA 审批）
          → OA 回调 Platform /v1/hitl/workorders/{id}/oa-callback
            → Platform 验签 + 角色+场站双校验
              → PENDING_APPROVAL → APPROVED
                → 飞书通知执行人
                  → 执行人现场作业
                    → Studio 上传完成证据 + DONE
                      → Platform 可选回写 CMMS
                        → 异步触发 L3 知识写入
```

### 7.2 HiAgent 集成模式（甲方已有）

若甲方已部署 HiAgent，可与 OpenClaw **并存**，共用同一套 Platform Tool API：

```
HiAgent <──Tool HTTPS──> Platform /v1/(objects|kb|hitl|analytics)
OpenClaw <──Tool HTTPS──> Platform /v1/(objects|kb|hitl|analytics)

要求：
  1. HiAgent 用独立的 ServiceToken（与 OpenClaw 的分开，便于分别审计）
  2. 两个 Agent 都不得直连 PostgreSQL/Milvus
  3. Platform 审计日志中 source 字段区分 "openclaw" / "hiagent"
  4. Tool API schema 统一在 Platform 维护，Agent 侧只配 URL

HiAgent 可以承担的：
  ✅ AI 对话路由、工具调用链、HITL 节点等待
  ✅ 调 Platform Tool API 完成工单草稿、知识检索、孪生读数
  ❌ 直连 OT 数据源
  ❌ 绕过 Platform 做权限判断
  ❌ 写工单状态（只能 POST draft，不能改 status FSM 以外的状态）
```

### 7.3 OA/BPM 集成（甲方审批主链）

若甲方 OA/BPM 是制度性审批主链（财务、安全、红头文件类），Platform HITL 作为 **子流程**嵌入：

```python
# Platform 侧 OA 回调端点（routers/hitl.py 中补充）

@router.post("/workorders/{wo_id}/oa-callback")
async def oa_callback(
    wo_id: str,
    body: OACallbackBody,      # action, approver, oa_ref, comment
    oa_token: str = Header(..., alias="X-OA-Service-Token"),
    db: AsyncSession = Depends(get_db),
):
    # 1. 验 OA ServiceToken（与 OpenClaw token 不同）
    if oa_token != settings.oa_service_token:
        raise HTTPException(401, "无效 OA Service Token")

    # 2. 取工单
    wo = await db.get(WorkOrder, wo_id)
    if not wo or wo.state != "pending_approval":   # ← 字段名 state，值小写
        raise HTTPException(400, "工单状态不符")

    # 3. 更新状态（调用权威 FSM，见 §19.4）
    wo.state = "approved" if body.action == "approve" else "rejected"
    wo.approved_by = body.approver
    wo.oa_ref = body.oa_ref      # 保存 OA 单号，便于对账
    await db.commit()

    # 4. 审计日志
    await write_audit(db, f"workorder.{wo.state}", wo_id, body.approver, body.action)

    # 5. 飞书通知执行人
    if wo.state == "approved":
        await FeishuClient.send_alert({...})

    return {"wo_state": wo.state}   # ← 返回字段名也用 wo_state
```

### 7.4 飞书三条通道说明（不会搞混的版本）

```
通道 1：飞书 → Platform（业务门）
  触发：用户点飞书卡片按钮（审批/拒绝/确认）
  协议：HTTP POST（Webhook，飞书服务器主动调你）
  安全：verify_token + Encrypt Key（Platform 验签）
  处理：更新工单状态、写审计、通知下一步

通道 2：飞书 → OpenClaw/HiAgent（AI 对话）
  触发：用户在飞书 @ AI 机器人、发消息
  协议：Bot 消息推送（飞书事件订阅或长连接，取决于 OpenClaw 插件实现）
  安全：Bot App 凭证；AI 侧再用 ServiceToken 调 Platform
  处理：多步 AI 推理 → 工具调用 → 飞书回复

通道 3：Studio → OpenClaw（实时对话）
  触发：浏览器里的 AI 对话面板
  协议：WebSocket（/ws/）
  安全：Studio JWT → Nginx → OpenClaw（再调 Platform 的 ServiceToken）
  处理：流式 AI 输出、工具调用结果实时展示

⚠️ 三条通道完全独立，互不干扰。
   「飞书接两个 WebSocket」不是正确的描述：
    飞书侧没有你们维护的 WebSocket 服务端；
    WebSocket 只在浏览器 Studio 里存在。
```

---

## 九、当前集成全景快照（开发 handoff 用）

### 9.1 飞书三通道一句话版

```
通道 1（业务门）  飞书卡片按钮 → HTTP Webhook → Platform → 更新工单状态
通道 2（AI 对话） 飞书 @ Bot    → Bot 推送    → OpenClaw/HiAgent → 多步推理 → 回复
通道 3（Studio）  浏览器对话框  → WebSocket   → OpenClaw → 流式 AI 输出

三条通道完全独立。飞书侧没有你维护的 WebSocket 服务端；WebSocket 只存在于浏览器Studio。
```

### 9.2 各外部系统集成状态一览

| 外部系统                  | 集成点                                          | Phase | 完成状态                     |
| ------------------------- | ----------------------------------------------- | ----- | ---------------------------- |
| 飞书 Webhook（告警/HITL） | Platform `/v1/feishu/webhook`                   | A     | 已设计，待实现               |
| 飞书 Bot（AI 对话）       | OpenClaw feishu 插件                            | A     | 插件已有，配置 Bot App ID    |
| 飞书 IDaaS                | Platform 可选同步 `/v1/admin/feishu/sync-org`   | B     | Phase B 实现                 |
| OA/BPM 回调               | Platform `/v1/hitl/workorders/{id}/oa-callback` | B     | 已设计（见 §七.3）           |
| HiAgent                   | Platform Tool API + Service Token               | B     | 已设计，需申请独立 token     |
| IMS (ERP/CMMS)            | Platform `/v1/ims/` 代理层                      | B     | Phase B，Phase A 用 CSV 导入 |
| OPC-UA (SCADA/DCS)        | opcua-bridge → Kafka → Platform                 | B     | Phase A 用 mock Redis        |
| 数据中台（海鹰等）        | IT 侧消费 Platform `/v1/export/` Webhook        | C     | 可选，按需对接               |
| NVIDIA Omniverse          | 未来 Phase C 双向 USD 同步                      | C     | 技术预研阶段                 |

### 9.3 当前最重要的 Phase A 未完成项

```
① 飞书 Webhook 接收端（Platform routers/feishu.py）
   → 卡片按钮审批回调必须有，否则 HITL 闭环不了

② 知识 Admin UI（Studio AdminPage → POST /v1/kb/documents）
   → 知识管理员上传 PDF，没有 UI 就无法演示知识检索

③ 3D 场站默认素材（至少 5 个设备的 GLTF/glb 模型文件）
   → TwinSurface 有代码但没资产，场景是空的

④ OpenClaw Skills 配置（4 个 SKILL.md 注册到 OpenClaw）
   → AI 对话没有 Tools 不能调用实时数据和工单

⑤ Docker Compose 端到端联调（所有容器互联验证）
   → Phase A 结束前必须完成一次全链路冒烟测试
```

### 9.4 给新加入开发者的一句话架构指南

```
Platform（我们写的 FastAPI）= Palantir Foundry（数据+工单+权限）
OpenClaw（开源产品）        = Palantir AIP（Agent 推理+工具调用）
Studio（我们写的 React）    = Foundry 的前端（Ontology 可视化+AI 对话）

开发新功能时的判断规则：
  涉及数据读写/工单/权限/IMS → 加到 Platform API
  涉及 AI 推理/工具调用/对话 → 加到 OpenClaw Skill
  涉及界面展示/用户交互       → 加到 Studio 页面
  三者通过 REST API 和 WebSocket 解耦，禁止绕过
```
