# ClawTwin 多团队并行开发协作指南

> **读者**：所有参与 ClawTwin 开发的团队成员  
> **目标**：让 3-4 个团队（后端/前端/AI集成/DevOps）并行开发，互不阻塞，最终能正确联调  
> **首次阅读顺序**：`DESIGN-FINAL-MASTER-INDEX.md`（总入口）→ **`DEV-QUICKSTART.md` §〇**（**`platform-api` / `refine-clawtwin` cwd**）→ **`TESTING-GUIDE.md` §二.0**（pytest 目录）→ 本文 → `DEVELOPMENT-CONTRACT.md` → 自己模块设计文档

---

## 一、项目全景（30秒）

```
用户设备（飞书App / Studio浏览器）
        ↓  HTTP/WS
ClawTwin Platform（我们开发的 FastAPI 服务）
        ↓  HTTP Tool API       ↑  技能回调
    OpenClaw（开源，用户自己部署）
        ↓  OpenAI-compat API
    vLLM 推理服务（Qwen3 35B-A3B）
        ↓  IMS Adapter（我们开发）
    OPC-UA / SCADA / ERP
```

**我们只需要开发**：Platform（后端）+ Studio（前端）+ IMS Adapter + OpenClaw Skills

---

## 二、模块归属与团队分工

### 模块地图

```
clawtwin-platform/
├── platform-api/               [后端团队]
│   ├── auth/                   认证 + ABAC
│   ├── routers/                API 端点（RESTful + Tool API）
│   ├── db/models/              ORM 模型（权威见 §19）
│   ├── services/               业务逻辑（FSM/飞书/AI/审计）
│   └── scheduler/              定时任务
│
├── opcua-bridge/               [后端团队 + DevOps]
│   └── server.py               OPC-UA 模拟服务 + 适配层
│
├── frontend/（Studio · **历史示意图**）
│   └── ⚠ Phase A **可运行** UI：**独立仓 `clawtwin-studio/refine-clawtwin/`**（见 `DEV-QUICKSTART.md` §〇、§四；**勿假设** `clawtwin-platform/frontend/` 一定存在）
│       · Refine + Vite；MSW：`VITE_CLAWTWIN_MSW=1`；API：`VITE_CLAWTWIN_API_BASE`
│
└── （OpenClaw 仓）contrib/industrial-oilgas-skills/  [AI集成团队 · 设计与 Skills]
    ├── industrial-twin/SKILL.md       OpenClaw Twin Skill
    ├── industrial-kb/SKILL.md         OpenClaw KB Skill
    ├── industrial-analytics/SKILL.md  OpenClaw Analytics Skill
    └── industrial-workorder/SKILL.md  OpenClaw WorkOrder Skill
```

### 团队职责边界

| 团队        | 负责                                           | 不负责                     |
| :---------- | :--------------------------------------------- | :------------------------- |
| 后端核心    | Platform API、ORM、ABAC、FSM、审计             | Studio 组件、OpenClaw 内部 |
| 前端 Studio | 所有 `*.tsx` 组件、Zustand store、Hook         | Platform 业务逻辑          |
| AI 集成     | 4个 OpenClaw Skill、vLLM 配置、Milvus 初始化   | Platform HITL 状态机       |
| DevOps      | docker-compose、nginx、Milvus/Redis/Kafka 配置 | 业务逻辑代码               |

---

## 三、文档权威层级（冲突时以此为准）

```
Level 1（最高权威 · 运行时契约）：
  DESIGN-FINAL-LOCK.md §一           ← HTTP 路径/方法终态（前后端 / OpenClaw 联调第一依据）
  NEXUS-API-REFERENCE.md             ← Request/Response / 错误码 / curl（须与 LOCK §一 一致）
  MODULE-DESIGN-PLATFORM.md §十九     ← 数据模型（ORM / 枚举；state 等小写）
  ⚠ MODULE-DESIGN-PLATFORM.md §十八 / §18.6：须与 LOCK §一 对齐；
    宽表与 LOCK 冲突时 → 以 LOCK 为准，并回写 §18.6（勿未经评审反向改 LOCK）

Level 2（架构与安全）：
  INDUSTRIAL-FOUNDRY-ARCHITECTURE.md ← Foundry / Ontology 范式
  clawtwin-project/SKILL.md          ← 铁律（违反即错）
  DEVELOPMENT-CONTRACT.md             ← 红线与文档入口指针
  CLAWTWIN-MASTER-V2.md              ← 总体叙事；URL 以 LOCK §一 为准（含已废弃路径）

Level 3（设计权威 · UI/交互）：
  MODULE-DESIGN-STUDIO.md            ← 前端组件设计（§〇：Phase A 实现仓 = refine-clawtwin）
  UI-UX-DESIGN.md                    ← UI/UX 原则

Level 4（参考 / Runbook）：
  DEV-QUICKSTART.md · TESTING-GUIDE.md · CURSOR-MULTITASK-GUIDE.md
  PHASE-A-SCAFFOLD.md · PHASE-A-RUNBOOK.md · CODE-AUDIT-REPORT.md
```

**原则**：代码与文档冲突时以文档为准。**HTTP 面值**冲突 → **DESIGN-FINAL-LOCK §一** → **NEXUS-API-REFERENCE**；**数据结构** → **MODULE §十九**。

---

## 四、API 契约管理（前后端联调协议）

### 4.1 单一真相来源

**REST 路径与方法**：以 **`DESIGN-FINAL-LOCK.md §一`** 为终态；对照 **`NEXUS-API-REFERENCE.md`** 获取 JSON 形状与示例。  
**`MODULE-DESIGN-PLATFORM.md §18.6`**（宽表）必须与上述二者一致；若发现漂移，先改实现与 LOCK，再回写 §18.6。  
**OpenAPI**：以运行中的 **`GET /v1/openapi.json`** 为交付验证辅助，**不以**其与 LOCK 冲突时的旧生成为准。

### 4.2 前后端对接规则

```
后端变更 API 时：
  1. 先在 #dev-api 频道发送 [API变更通知]
  2. 核对并更新 DESIGN-FINAL-LOCK.md §一（必要时 §八 备忘）与 NEXUS-API-REFERENCE.md 对应节
  3. 回写 MODULE-DESIGN-PLATFORM.md §18.6（与 LOCK 对齐）
  4. FastAPI/OpenAPI 与契约一致后，通知前端更新 refine-clawtwin 中的调用与 MSW（mocks/handlers.ts）

前端需要新 API 时：
  1. 在 #dev-api 发 [API需求]，附上 LOCK/NEXUS 格式的期望 URL 与请求/响应草案
  2. 后端评估；双方确认后先 LOCK → NEXUS → §18.6 → 代码
```

### 4.3 Mock 优先开发

前后端可以并行开发。前端使用 MSW（Mock Service Worker）：

```typescript
// refine-clawtwin/src/mocks/handlers.ts（路径以仓库为准）
import { http, HttpResponse } from "msw";

export const handlers = [
  http.get("/v1/equipment/:id", ({ params }) => {
    return HttpResponse.json({
      id: params.id,
      name: "2#压缩机",
      status: "alarm",
      thresholds: { shaft_vibration: { warn: 3.5, alarm: 5.0, unit: "mm/s" } },
    });
  }),
  // ... 见 PHASE-A-SCAFFOLD.md 中的 mock 数据格式
];
```

---

## 五、开发环境搭建（每个团队）

> **执行权威**：**`DEV-QUICKSTART.md` §〇～§四** 与 **`clawtwin-platform/platform-api/README.md`**。下列为摘要；若与上述文件冲突，以磁盘 README 为准。

### 5.1 后端团队

```bash
cd clawtwin-platform/platform-api    # 克隆路径以你本机为准

python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
# 环境变量见 README（如 CLAWTWIN_AUTH_DEV / CLAWTWIN_JWT_SECRET）
.venv/bin/uvicorn apps.http.main:app --reload --host 127.0.0.1 --port 8000

# 验证
curl -s http://127.0.0.1:8000/v1/health
```

### 5.2 前端团队

```bash
cd clawtwin-studio/refine-clawtwin

pnpm install
# .env.local：VITE_CLAWTWIN_API_BASE=http://127.0.0.1:8000
# 可选 VITE_CLAWTWIN_MSW=1
pnpm dev          # 端口见 vite.config（常见 5175）
```

### 5.3 AI 集成团队

```bash
# OpenClaw（以 openclaw 仓与官方文档为准）
cd /path/to/openclaw
pnpm install && pnpm build
# MCP / Tool 指向 Nexus：http://127.0.0.1:8000/v1/mcp（或 /mcp，与部署一致；见 DESIGN-FINAL-LOCK §1.7）
```

### 5.4 完整联调环境

Compose 端口与服务以 **`clawtwin-platform`** 仓内 **`docker-compose*.yml`** 为准（常见 API **8000** 或映射 **8080→8000**）。勿与本文旧示例硬编码端口冲突；以 **`DEV-QUICKSTART.md`** 与 **`platform-api/README.md`** 为准。

---

## 六、代码审查门控（每个 PR 都要过）

### 6.1 后端 PR 检查清单

```
□ 新路由是否有 Depends(get_current_user) ？
□ 涉及场站数据是否调用 require_station_access（或与资源归属场站等价的校验）？
□ station_id 是否从 JWT/设备推导（非用户输入）？
□ 角色限制操作是否有 require_role() ？
□ 关键操作是否调用 audit_log() ？
□ 工单操作：state 字段（非 status），值小写下划线
□ 响应格式：equipment_id/wo_id/station_id 用字符串（非整数）
□ 是否有 403 测试（越权场景）？
□ 是否有 401 测试（未认证场景）？
□ pytest / Alembic：README、PR 描述或 CI 脚本默认 cwd = clawtwin-platform/platform-api/（TESTING-GUIDE.md §二.0；DEV-QUICKSTART.md §〇；CURSOR-MULTITASK-GUIDE.md §七–§八）
```

### 6.2 前端 PR 检查清单

```
□ Phase A PR 是否在正确仓：clawtwin-studio/refine-clawtwin/（cwd 见 DEV-QUICKSTART.md §〇）
□ API URL 是否与 DESIGN-FINAL-LOCK / NEXUS-API-REFERENCE 一致（含 /v1/ 前缀）；历史 §18.6 以 LOCK 裁剪为准时以 LOCK 优先
□ WorkOrder 字段：wo_id（非 work_order_id / id），state（非 status）
□ 状态显示是否用 WO_STATE_LABELS / WO_STATE_COLORS（见 §19.5）？
□ 颜色是否用 tokens.ts 中的 design token（非硬编码十六进制）？
□ AI 输出是否显示 <CitationBadge> ？
□ 关键操作是否有 loading/error 状态处理？
□ 是否在 MSW mock 中添加了对应的 handler？
```

### 6.3 通用检查

```
□ 没有 console.log / print 调试语句遗留
□ 没有 TODO 注释（用 GitHub Issue 跟踪）
□ 没有硬编码的用户 ID / 场站 ID
□ 没有 Magic Number（用常量或配置）
□ 多仓路径与命令 cwd 已按 CURSOR-MULTITASK-GUIDE.md §七、§八 自检后再合并
```

---

## 七、里程碑并行开发矩阵

```
M1 Week 1-2（基础设施）：
  后端：重构 ORM + auth + ABAC + /v1/ 前缀
  前端：Vite 项目搭建 + MSW mock + 登录页
  DevOps：docker-compose 补全 Redis/Milvus

M2 Week 3-4（核心可见）：
  后端：Equipment CRUD + Reading 写入 + OPC-UA mock 数据
  前端：TwinPage 骨架 + NavRail + TwinSurface（Babylon.js 箱体）
  AI集成：vLLM 部署验证

M3 Week 5-6（AI 问答）：
  后端：Tool API（diagnose_equipment + query_kb）+ Milvus 初始化
  前端：DeviceIntelPanel + AIInsightCard + CitationBadge
  AI集成：industrial-twin Skill + industrial-kb Skill 接入

M4 Week 7-8（HITL 工单）：
  后端：完整 HITL 路由 + 飞书 Webhook + 工单 FSM
  前端：WorkOrderDraftInline + KanbanPage
  AI集成：industrial-workorder Skill

M5 Week 9-10（告警 + 晨报）：
  后端：Alarms 路由 + Scheduler（晨报/KPI）
  前端：AlarmQueuePanel + ISA-18.2 UI + ShiftHandoverCard
  AI集成：industrial-analytics Skill

M6 Week 11-12（Phase A 交付）：
  所有团队：联调 + Bug 修复 + Demo 准备
```

---

## 八、团队间的同步协议

### 每日异步同步（Feishu 群消息）

```
格式：
[团队名] [今日完成] [明日计划] [阻塞问题（如有）]

示例：
[后端] [完成 auth/depends.py 重构，JWT 验证已通过测试]
       [明日: Equipment API + require_station]
       [阻塞: 需要前端确认 /v1/equipment/ 响应中是否要包含 realtime_metrics]
```

### 里程碑评审（每两周）

- 参与者：所有团队负责人
- 时长：30分钟
- 交付物：可在本地运行的 Demo 场景（见 DEVELOPMENT-MILESTONES.md §六）

### API 变更影响面评估

```
影响 OpenClaw Skill → 需要 AI 集成团队 review
影响 Studio 显示    → 需要前端团队 review
影响 数据库 Schema  → 需要 Alembic migration + DevOps review
影响 安全边界       → 需要负责人 review，当天处理
```

---

## 九、完整设计文档清单（交付给团队）

### 必读文档（所有团队）

| 文档                        | 行数 | 目的                           |
| :-------------------------- | :--- | :----------------------------- |
| `DEVELOPMENT-CONTRACT.md`   | 391  | 开发前必读契约，10分钟了解全貌 |
| `clawtwin-project/SKILL.md` | 742  | 10条铁律 + 历史错误 + 快速参考 |
| `CODE-AUDIT-REPORT.md`      | ~280 | 现有代码问题和修复指导         |
| `DEVELOPMENT-MILESTONES.md` | 910  | M1-M6 共224个可执行任务        |

### 后端团队专项文档

| 文档                        | 行数 | 目的                                   |
| :-------------------------- | :--- | :------------------------------------- |
| `MODULE-DESIGN-PLATFORM.md` | 5390 | Platform 完整设计（API/ORM/服务/调度） |
| `PHASE-A-SCAFFOLD.md`       | 1242 | Phase A 脚手架代码（可直接参考）       |
| `PHASE-A-RUNBOOK.md`        | 438  | 启动/测试/验证手册                     |
| `INTEGRATION-AND-GAPS.md`   | 678  | 飞书/OA/IMS 集成方案                   |

**重点阅读章节**：

- §十二（认证与权限）
- §十三（IMS适配器）
- §十五（ORM模型，已被§十九取代）
- **§十八（API唯一真相表，36个端点）**
- **§十九（数据模型权威定稿，最高优先级）**

### 前端团队专项文档

| 文档                      | 行数 | 目的                                   |
| :------------------------ | :--- | :------------------------------------- |
| `MODULE-DESIGN-STUDIO.md` | 3902 | Studio 完整设计（组件/State/API/Hook） |
| `UI-UX-DESIGN.md`         | 2144 | UI 设计原则（Palantir + 认知科学）     |

**重点阅读章节（MODULE-DESIGN-STUDIO.md）**：

- §二十七（DeviceIntelPanel V2，One Big Action）
- §二十九（NavRail V2，StationHeatmap）
- §十七（TypeScript 类型定义，已更新至 §19.5）
- §十（Hook 实现）

### AI 集成团队专项文档

| 文档                            | 行数 | 目的                |
| :------------------------------ | :--- | :------------------ |
| `industrial-twin/SKILL.md`      | -    | Twin 状态查询 Skill |
| `industrial-kb/SKILL.md`        | -    | 知识库检索 Skill    |
| `industrial-analytics/SKILL.md` | -    | 趋势分析 Skill      |
| `industrial-workorder/SKILL.md` | -    | 工单操作 Skill      |

**重点阅读章节（MODULE-DESIGN-PLATFORM.md）**：

- §六（OpenClaw 集成模式）
- §十七（AI Tool API 实现，diagnose_equipment/query_kb/health-score/spectrum）
- §十八（OpenClaw Skills 调用的全部端点）

### DevOps 团队专项文档

| 文档                    | 行数 | 目的                                    |
| :---------------------- | :--- | :-------------------------------------- |
| `CLAWTWIN-MASTER-V2.md` | 1724 | 整体架构（部署拓扑/OT-IT分区/安全架构） |
| `PHASE-A-SCAFFOLD.md`   | 1242 | docker-compose / nginx / Alembic 配置   |

**重点阅读章节（CLAWTWIN-MASTER-V2.md）**：

- §五（OT/IT 网络分区）
- §六（安全架构，零信任、审计日志）
- §十（Docker Compose 服务拓扑）

---

## 十、常见问题速查

**Q：前端怎么知道 API 已经准备好了？**  
A：后端在 `#dev-api` 频道发 ✅ 标记，并在 `http://localhost:8080/docs` 显示绿色。

**Q：字段名冲突怎么办？**  
A：查 `MODULE-DESIGN-PLATFORM.md §十九`，那是最高权威，两天内修复。

**Q：工单的主键是什么格式？**  
A：`wo_id: "W-XXXXXXXX"`（8位大写十六进制）。服务端生成，前端只读。

**Q：Equipment 的主键是什么格式？**  
A：`id: "C-001"`（设备类型首字母+序号）。手动在种子数据中定义。

**Q：OpenClaw Skill 怎么获取当前用户的场站数据？**  
A：Skill 调用 `GET /v1/equipment/{id}` 时附带 `X-OpenClaw-Service-Token`，Platform 验证后返回用户有权访问的数据。

**Q：飞书 Bot 回调怎么处理？**  
A：`POST /v1/feishu/events` → Platform 路由 → 调用 OpenClaw `/agents/{id}/chat` → OpenClaw 调用对应 Skill → Skill 调用 Platform Tool API。

---

_本文档是 ClawTwin 多团队开发的协作约定，违反其中规则需要所有团队负责人确认。_
