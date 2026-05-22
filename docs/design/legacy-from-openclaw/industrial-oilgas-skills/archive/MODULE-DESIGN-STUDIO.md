# ClawTwin Studio — 模块概要设计

## 前端组件树与数据流设计文档

**版本**：V3（2026-05-09，对标 Palantir UI/UX 规范重构）  
**UI/UX 规范**：见 `UI-UX-DESIGN.md`（Palantir Foundry + AIP + Gotham 对标）  
**基础**：maibot-ui（复制后改造，保留 AI 对话核心）  
**技术栈**：React 18 + TypeScript + Tailwind + Babylon.js 8 + shadcn/ui

> **设计原则**：对象即中心 · 空间即情报 · AI 即行动 · 决策留痕  
> 详细交互逻辑、布局规范、视觉 Token 见 `UI-UX-DESIGN.md`。

> **Phase A 实现仓（与下文 `src/` 树的关系）**：下文 **`clawtwin-studio/`**、`src/pages/` 等描述的是 **逻辑组件树与职责**（由原 maibot-ui 改造蓝图演化）。Phase A **可运行脚手架** 在 **`clawtwin-studio/refine-clawtwin/`**，路径相对于 **`refine-clawtwin/src/`**（现有 `App.tsx`、`StudioShell.tsx`、`Dashboard.tsx`、`mocks/handlers.ts` 等）；实现与 Code Review 时按**职责对齐**本条与后续章节即可逐步抽出 `pages/`、`components/industrial`、`hooks/`。REST 路由与 SSE 仍以 **`DESIGN-FINAL-LOCK.md`**、`NEXUS-API-REFERENCE.md` 为准；多任务编排见 **`CURSOR-MULTITASK-GUIDE.md`** **[T4]、[T12]–[T16]**。

---

## 一、目录结构

```
clawtwin-studio/                      # 从 maibot-ui 复制后改名
├── package.json                      # name: "@clawtwin/studio"
├── vite.config.ts
├── .env.example
│
├── packages/                         # 【保留，不改动】
│   ├── adapter/                      # OpenClaw Gateway WebSocket 适配器
│   ├── store/                        # Zustand 状态（含 gatewayUrl / connected）
│   ├── contracts/                    # 消息类型定义
│   └── ui-kit/                       # 基础 UI 组件库
│
└── src/
    ├── main.tsx                      # 应用入口
    ├── router.tsx                    # 路由定义（扩展工业路由）
    │
    ├── api/                          # Platform API 客户端（新增）
    │   ├── client.ts                 # axios 实例（baseURL / JWT 注入 / 错误处理）
    │   ├── objects.ts                # /v1/objects/* 调用
    │   ├── tools.ts                  # /v1/tools/* 调用
    │   ├── hitl.ts                   # /v1/hitl/* 调用
    │   ├── ingest.ts                 # /v1/ingest/* 调用
    │   └── admin.ts                  # /v1/admin/* 调用
    │
    ├── stores/                       # 工业状态管理（新增，独立于 @maibot/store）
    │   ├── twin.store.ts             # 数字孪生状态（设备列表、选中设备、实时数据）
    │   ├── workorder.store.ts        # 工单状态（待审批列表、当前工单）
    │   └── auth.store.ts             # Studio 登录状态（JWT、用户信息）
    │
    ├── hooks/                        # 业务 Hook
    │   ├── useEquipment.ts           # 设备实时数据（轮询 or WebSocket）
    │   ├── useStation.ts             # 场站数据（含 KPI）
    │   ├── useWorkOrders.ts          # 工单列表
    │   └── useAuth.ts                # 认证状态和登录动作
    │
    ├── pages/                        # 路由页面
    │   ├── LoginPage.tsx             # 【保留并修改】工号+密码登录（JWT）
    │   ├── BindPage.tsx              # 【新增】/bind?token=xxx&feishu_open_id=yyy
    │   │                             #   无需登录；飞书绑定一键完成页
    │   ├── MainShell.tsx             # 【保留，不改动】AI 对话三栏布局
    │   ├── TwinPage.tsx              # 【新增】/twin 3D 孪生主界面
    │   ├── CommandPage.tsx           # 【新增】/command 指挥大屏（全屏）
    │   └── admin/
    │       ├── KnowledgePage.tsx     # 【新增】/admin/knowledge
    │       ├── EquipmentPage.tsx     # 【新增】/admin/equipment
    │       ├── UsersPage.tsx         # 【新增】/admin/users
    │       └── SystemPage.tsx        # 【新增】/admin/system
    │
    ├── surfaces/                     # 大型场景组件（Babylon.js 3D）
    │   ├── TwinSurface.tsx           # 【新增】Babylon.js 场景容器
    │   ├── CommandSurface.tsx        # 【新增】全屏 3D（/command 专用）
    │   └── equipment/
    │       ├── EquipmentMesh.ts      # 设备 3D 网格工厂（按类型创建）
    │       ├── EquipmentLabel.ts     # 设备悬浮标签（状态/数值）
    │       └── StatusOverlay.ts      # 状态颜色覆盖层
    │
    ├── components/                   # 纯 UI 组件（无业务状态）
    │   ├── intelligence/             # R 区情报面板组件（Palantir 对象页范式）
    │   │   ├── DeviceIntelPanel.tsx  # 选中设备时的完整情报面板（R 区主体）
    │   │   ├── AIInsightCard.tsx     # AI 情报解读卡（紫色边框，citations 可点击）
    │   │   ├── ActionPanel.tsx       # 建议行动面板（一键建工单/通知主管）
    │   │   ├── WorkOrderDraftInline.tsx # R 区内嵌工单草稿（不跳新页面）
    │   │   ├── AlertQueuePanel.tsx   # 无选中时的告警队列摘要
    │   │   └── CitationLink.tsx      # 可点击的 citation 跳转组件
    │   │
    │   ├── industrial/
    │   │   ├── EquipmentCard.tsx     # 设备状态卡片（左侧 L 区列表项）
    │   │   ├── MetricBar.tsx         # 实时指标进度条（含双阈值线，见 UI-UX-DESIGN §9.1）
    │   │   ├── TrendChart.tsx        # 历史趋势迷你图（recharts，24h 实测数据；Phase B 增加 MOIRAI 预测带）
    │   │   ├── StatusBadge.tsx       # 状态标志（🟢🟡🔴⚫ + 脉冲动画）
    │   │   ├── WorkOrderCard.tsx     # 工单卡片（看板视图）
    │   │   ├── WorkOrderKanban.tsx   # 工单看板（四列：草稿/待审批/执行中/完成）
    │   │   ├── AlertBadge.tsx        # 告警角标（数字 + 级别颜色）
    │   │   └── KPIBar.tsx            # 顶部/底部 KPI 数字条
    │   │
    │   ├── ontology/                 # 关系图视图组件
    │   │   ├── OntologyGraph.tsx     # Ontology 关系图（react-force-graph-2d）
    │   │   ├── OntologyNode.tsx      # 图节点（设备/工单/人员/知识 类型区分）
    │   │   └── OntologyEdge.tsx      # 图边（关系类型标签）
    │   │
    │   └── layout/
    │       ├── StudioShell.tsx       # 主布局容器（顶栏+L区+C区+R区+时间轴）
    │       ├── NavRail.tsx           # 左侧对象浏览器（展开/收起，替代原 IndustrialRail）
    │       ├── CenterPanel.tsx       # 中央决策面（四视图 Tab 切换）
    │       ├── IntelPanel.tsx        # 右侧情报面板（可拖拽宽度 340-480px）
    │       ├── TimeLine.tsx          # 底部时间轴（历史状态穿越）
    │       └── StationSelector.tsx   # 场站选择器（顶栏下拉）
    │
    └── lib/
        ├── babylon-utils.ts          # Babylon.js 工具函数（场景初始化等）
        ├── status-utils.ts           # 设备状态计算（阈值比较→status）
        └── citation-utils.ts         # Citations 格式化和显示
```

**删除的 maibot-ui 文件（工业版不需要）**：

```
src/pages/ExpertMarketPage.tsx
src/pages/MarketplacePage.tsx
src/pages/BillingPage.tsx
src/pages/EmployeeListPage.tsx
src/pages/EmployeeProfilePage.tsx
src/pages/EmployeeAutopilotNarrowPage.tsx
```

---

## 二、路由结构

### 2.0 RequireAuth 鉴权组件

```tsx
// src/components/RequireAuth.tsx
import { Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/auth.store";

interface Props {
  children: React.ReactNode;
  roles?: string[]; // 允许的角色列表；为空=只验证登录
}

export default function RequireAuth({ children, roles }: Props) {
  const { isAuthenticated, user } = useAuthStore();
  const location = useLocation();

  if (!isAuthenticated) {
    // 保存目标路径，登录后跳回
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (roles && roles.length > 0 && user) {
    if (!roles.includes(user.role)) {
      return (
        <div className="flex items-center justify-center h-screen">
          <div className="text-center">
            <h2 className="text-xl font-semibold text-red-500">权限不足</h2>
            <p className="text-gray-400 mt-2">当前角色 ({user.role}) 无法访问此页面</p>
            <p className="text-gray-500 text-sm mt-1">需要角色：{roles.join(" / ")}</p>
          </div>
        </div>
      );
    }
  }

  return <>{children}</>;
}
```

### 2.1 路由配置（router.tsx）

```tsx
// src/router.tsx（在现有路由基础上扩展）

// 【保留，不动】
const MainShell = lazy(() => import("./pages/MainShell"));      // /
const LoginPage = lazy(() => import("./pages/LoginPage"));      // /login（修改为工号登录）
const SettingsPage = lazy(() => import("./pages/SettingsPage")); // /settings

// 【新增工业路由】
const TwinPage    = lazy(() => import("./pages/TwinPage"));
const CommandPage = lazy(() => import("./pages/CommandPage"));
const BindPage    = lazy(() => import("./pages/BindPage"));   // 飞书绑定，无需登录
const KnowledgePage = lazy(() => import("./pages/admin/KnowledgePage"));
const EquipmentPage = lazy(() => import("./pages/admin/EquipmentPage"));
const UsersPage     = lazy(() => import("./pages/admin/UsersPage"));
const SystemPage    = lazy(() => import("./pages/admin/SystemPage"));

// 路由配置（添加到 createBrowserRouter 的 routes 数组）：
{ path: "/twin",             element: <RequireAuth><TwinPage /></RequireAuth> },
{ path: "/command",          element: <CommandPage /> },      // 无 RequireAuth，大屏专用
{ path: "/bind",             element: <BindPage /> },         // 无 RequireAuth，飞书绑定页
{ path: "/admin/knowledge",  element: <RequireAuth roles={["kb_admin","sys_admin"]}><KnowledgePage /></RequireAuth> },
{ path: "/admin/equipment",  element: <RequireAuth roles={["sys_admin"]}><EquipmentPage /></RequireAuth> },
{ path: "/admin/users",      element: <RequireAuth roles={["sys_admin"]}><UsersPage /></RequireAuth> },
{ path: "/admin/system",     element: <RequireAuth roles={["sys_admin","engineer"]}><SystemPage /></RequireAuth> },
```

### 2.1 BindPage.tsx（飞书绑定页）

```typescript
// src/pages/BindPage.tsx
// 用途：/bind?token=xxx&feishu_open_id=yyy
// Platform Admin 通过飞书 Bot 发送该链接；用户点击后用工号+密码确认身份完成绑定
// ⚠️ 此页面不使用 RequireAuth，但提交时验证 bind_token 有效性

import { useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { platformClient } from "@/api/client";

export default function BindPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token");
  const feishuOpenId = params.get("feishu_open_id");

  const [employeeId, setEmployeeId] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = async () => {
    if (!token || !feishuOpenId) {
      setErrorMsg("链接无效，请重新向管理员申请");
      setStatus("error");
      return;
    }
    setStatus("loading");
    try {
      await platformClient.post("/v1/admin/feishu-bind", {
        bind_token:     token,
        feishu_open_id: feishuOpenId,
        employee_id:    employeeId,
        password,
      });
      setStatus("ok");
      // 3 秒后跳回首页
      setTimeout(() => navigate("/"), 3000);
    } catch (e: any) {
      setStatus("error");
      setErrorMsg(e.response?.data?.detail ?? "绑定失败，请检查账号密码");
    }
  };

  if (status === "ok") {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <div className="text-2xl text-green-600">✓ 飞书账号绑定成功</div>
        <div className="text-gray-500">您已可以通过飞书使用 ClawTwin AI 助手</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen gap-6 max-w-sm mx-auto">
      <h1 className="text-xl font-semibold">绑定飞书账号</h1>
      <p className="text-sm text-gray-500">请输入工号和密码确认您的身份</p>
      <input
        className="input w-full" placeholder="工号" type="text"
        value={employeeId} onChange={e => setEmployeeId(e.target.value)}
      />
      <input
        className="input w-full" placeholder="密码" type="password"
        value={password} onChange={e => setPassword(e.target.value)}
      />
      {status === "error" && <p className="text-red-500 text-sm">{errorMsg}</p>}
      <button
        className="btn btn-primary w-full" disabled={status === "loading"}
        onClick={handleSubmit}
      >
        {status === "loading" ? "绑定中..." : "确认绑定"}
      </button>
    </div>
  );
}
```

**对应 Platform 端点**（见 §十三 Admin API）：`POST /v1/admin/feishu-bind`

- 验证 `bind_token` 有效且未过期（30 分钟 TTL）
- 验证 `employee_id + password`（与 `/v1/auth/login` 同逻辑）
- 写入 `user_feishu_bindings` 表
- 标记 `bind_token` 已使用（防重放）

````

---

## 三、状态管理设计

### 3.1 auth.store.ts（登录状态，完整实现）

```typescript
// src/stores/auth.store.ts
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { platformClient } from "@/api/client";

interface UserInfo {
  user_id: string;
  employee_id: string;
  name: string;
  role: "operator" | "supervisor" | "engineer" | "kb_admin" | "sys_admin";
  station_ids: string[];
  feishu_open_id?: string;
}

interface AuthState {
  token: string | null;
  user: UserInfo | null;
  isAuthenticated: boolean;

  login: (employee_id: string, password: string) => Promise<void>;
  logout: () => void;
  hasStationAccess: (station_id: string) => boolean;
  hasRole: (...roles: string[]) => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      isAuthenticated: false,

      login: async (employee_id, password) => {
        const { data } = await platformClient.post("/v1/auth/login", {
          employee_id,
          password,
        });
        // data: { access_token, token_type, expires_in, user }
        set({
          token: data.access_token,
          user: data.user,
          isAuthenticated: true,
        });
        // 注入 axios 默认 header（后续请求自动携带）
        platformClient.defaults.headers.common["Authorization"] =
          `Bearer ${data.access_token}`;
      },

      logout: () => {
        set({ token: null, user: null, isAuthenticated: false });
        delete platformClient.defaults.headers.common["Authorization"];
        window.location.href = "/login";
      },

      hasStationAccess: (station_id) => {
        const { user } = get();
        return user?.station_ids.includes(station_id) ?? false;
      },

      hasRole: (...roles) => {
        const { user } = get();
        return user ? roles.includes(user.role) : false;
      },
    }),
    {
      name: "clawtwin-auth",            // localStorage key
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({         // 只持久化 token 和 user，不持久化函数
        token: state.token,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        // 页面刷新后恢复时，重新注入 axios header
        if (state?.token) {
          platformClient.defaults.headers.common["Authorization"] =
            `Bearer ${state.token}`;
        }
      },
    },
  ),
);
````

### 3.2 twin.store.ts（数字孪生状态）

```typescript
// src/stores/twin.store.ts
interface EquipmentState {
  equipment_id: string;
  name: string;
  type: string;
  station_id: string;
  status: "NORMAL" | "WARNING" | "ALARM" | "OFFLINE";
  current: Record<string, { value: number; unit: string; updated_at: string }>;
  thresholds: Record<string, { warn: number; alarm: number; unit: string }>;
  last_workorder?: { id: string; status: string; work_type: string };
}

interface TwinState {
  selectedStationId: string;
  equipmentList: EquipmentState[]; // 左侧列表
  selectedEquipmentId: string | null; // 点击选中的设备
  selectedEquipment: EquipmentState | null; // 选中设备的完整数据
  isLoading: boolean;
  lastUpdated: string | null;

  // Actions
  selectStation: (station_id: string) => void;
  selectEquipment: (equipment_id: string) => void;
  refreshEquipment: (equipment_id: string) => Promise<void>;
  startPolling: (interval_ms?: number) => void; // 默认 10 秒轮询
  stopPolling: () => void;
}

// 重要：实时数据通过 10 秒轮询（Phase A），WebSocket 推送为 Phase B
// 选中设备时立即刷新一次（单设备详情），然后继续全局轮询

// ── 完整实现 ─────────────────────────────────────────────────
import { create } from "zustand";
import { platformClient } from "@/api/client";

let _pollInterval: ReturnType<typeof setInterval> | null = null;

export const useTwinStore = create<TwinState>()((set, get) => ({
  selectedStationId: import.meta.env.VITE_STATION_ID ?? "STATION-CNG-001",
  equipmentList: [],
  selectedEquipmentId: null,
  selectedEquipment: null,
  isLoading: false,
  lastUpdated: null,

  selectStation: (station_id) => {
    set({ selectedStationId: station_id, selectedEquipmentId: null, selectedEquipment: null });
    // 切站后立即刷新列表
    get().startPolling();
  },

  selectEquipment: (equipment_id) => {
    set({ selectedEquipmentId: equipment_id });
    get().refreshEquipment(equipment_id);
  },

  refreshEquipment: async (equipment_id) => {
    try {
      const { data } = await platformClient.get(`/v1/objects/equipment/${equipment_id}`);
      set({ selectedEquipment: data });
      // 同步更新列表中该设备的状态
      set((state) => ({
        equipmentList: state.equipmentList.map((eq) =>
          eq.equipment_id === equipment_id ? { ...eq, ...data } : eq,
        ),
      }));
    } catch {
      // 静默失败，保留上次数据
    }
  },

  startPolling: (interval_ms = 10_000) => {
    // 先清除旧轮询
    if (_pollInterval) clearInterval(_pollInterval);

    const poll = async () => {
      const { selectedStationId } = get();
      try {
        set({ isLoading: true });
        const { data } = await platformClient.get(`/v1/objects/station/${selectedStationId}`);
        set({
          equipmentList: data.equipment ?? [],
          lastUpdated: new Date().toISOString(),
          isLoading: false,
        });
        // 同步刷新已选中设备的详情
        const { selectedEquipmentId } = get();
        if (selectedEquipmentId) {
          get().refreshEquipment(selectedEquipmentId);
        }
      } catch {
        set({ isLoading: false });
      }
    };

    poll(); // 立即执行一次
    _pollInterval = setInterval(poll, interval_ms);
  },

  stopPolling: () => {
    if (_pollInterval) {
      clearInterval(_pollInterval);
      _pollInterval = null;
    }
  },
}));
```

---

## 四、TwinPage 组件树

```
TwinPage                                    # /twin 入口页面
├── StationSelector                         # 场站切换（多站权限用户）
│   └── 下拉菜单：[S001 压气站, S002 分输站]
│
├── [左栏 240px] EquipmentListPanel
│   ├── EquipmentSearchInput                # 快速搜索（设备 ID / 名称）
│   ├── StatusFilterTabs                    # 全部 / 告警 / 警告 / 正常
│   └── EquipmentList
│       └── EquipmentCard × N              # 每个设备一张卡片
│           ├── StatusBadge                 # 🟢🟡🔴⚫
│           ├── 设备名称 + ID
│           └── 关键指标（最多 2 个）
│
├── [中栏 flex] TwinSurface                 # Babylon.js 3D 场景
│   ├── BabylonEngine（WebGPU）
│   ├── HDRIEnvironment（Polyhaven 工业场景）
│   ├── EquipmentMesh × N                  # 每台设备的 3D 表示
│   │   ├── MeshGeometry（Phase A：BOX，Phase C：真实模型）
│   │   ├── StatusMaterial（颜色随状态变化）
│   │   └── HoverLabel（悬浮显示设备名 + 关键数值）
│   ├── CameraController                   # 轨道相机（鼠标拖拽/缩放）
│   └── ClickHandler → selectEquipment()
│
├── [右栏 340px] EquipmentDetailPanel       # 选中设备时显示
│   ├── 设备标题（名称 + ID + StatusBadge）
│   ├── MetricGauge × N                    # 每个指标一个进度条
│   │   ├── 指标名 + 当前值 + 单位
│   │   ├── 进度条（warn/alarm 两条线）
│   │   └── 时间戳（最后更新）
│   ├── TrendChart（24h 趋势迷你图）
│   ├── RecentWorkOrders（最近 3 条工单）
│   └── QuickActions
│       ├── [问 AI] → 打开 AI 对话，预填设备上下文
│       ├── [建工单] → 打开工单草稿表单
│       └── [查知识] → 搜索该设备相关知识
│
└── BottomStatusBar                         # 底部状态栏
    ├── 场站 KPI（设备总数/告警数/今日工单）
    ├── 数据时间戳
    └── 连接状态灯（Platform / AI / OPC-UA 数据流）
```

---

## 五、TwinSurface 实现要点

### 5.1 TwinSurface.tsx（完整实现）

```typescript
// src/surfaces/TwinSurface.tsx
import { useEffect, useRef, useCallback } from "react";
import {
  Engine, Scene, ArcRotateCamera, HemisphericLight,
  DirectionalLight, MeshBuilder, StandardMaterial,
  Color3, Vector3, ActionManager, ExecuteCodeAction,
  ShadowGenerator, PointLight,
} from "@babylonjs/core";
import "@babylonjs/core/Engines/webgpuEngine";  // 按需引入 WebGPU

import { useTwinStore } from "@/stores/twin.store";
import type { EquipmentState } from "@/types/twin";

// 设备状态 → 颜色映射
const STATUS_COLORS: Record<string, Color3> = {
  NORMAL:  new Color3(0.15, 0.75, 0.15),
  WARNING: new Color3(1.00, 0.65, 0.00),
  ALARM:   new Color3(0.90, 0.10, 0.10),
  OFFLINE: new Color3(0.45, 0.45, 0.45),
};

// Phase A 设备布局（手动坐标；Phase C 改为从 GIS/CAD 导入）
const EQUIPMENT_POSITIONS: Record<string, Vector3> = {
  "C-001":    new Vector3(0,   0,  0),
  "C-002":    new Vector3(6,   0,  0),
  "V-001":    new Vector3(0,   0,  5),
  "V-002":    new Vector3(6,   0,  5),
  "F-001":    new Vector3(-5,  0,  0),
  "METER-001":new Vector3(0,   0, -5),
};

interface Props {
  onEquipmentClick?: (equipment_id: string) => void;
}

export default function TwinSurface({ onEquipmentClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const sceneRef  = useRef<Scene | null>(null);
  // equipment_id → mesh（用于后续状态更新）
  const meshMapRef = useRef<Map<string, ReturnType<typeof MeshBuilder.CreateBox>>>(new Map());

  const { equipmentList, selectedEquipmentId, selectEquipment } = useTwinStore();

  // ── 场景初始化（只执行一次）─────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;

    // 优先 WebGPU，降级 WebGL2（Babylon.js 8 自动判断）
    const engine = new Engine(canvas, true, {
      adaptToDeviceRatio: true,
      powerPreference: "high-performance",
    });
    engineRef.current = engine;

    const scene = new Scene(engine);
    sceneRef.current = scene;
    scene.clearColor = new Color3(0.06, 0.06, 0.10).toColor4(1);  // 深色背景

    // 相机（弧形旋转，鼠标拖拽）
    const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 3.5, 25, Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 5;
    camera.upperRadiusLimit = 60;

    // 环境光（基础照明）
    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.6;

    // 方向光（阴影）
    const dirLight = new DirectionalLight("dir", new Vector3(-1, -2, -1), scene);
    dirLight.intensity = 0.8;
    const shadows = new ShadowGenerator(1024, dirLight);
    shadows.useBlurExponentialShadowMap = true;

    // 地面
    const ground = MeshBuilder.CreateGround("ground", { width: 40, height: 40 }, scene);
    const groundMat = new StandardMaterial("groundMat", scene);
    groundMat.diffuseColor = new Color3(0.12, 0.14, 0.16);
    groundMat.specularColor = Color3.Black();
    ground.material = groundMat;
    ground.receiveShadows = true;

    // 渲染循环
    engine.runRenderLoop(() => scene.render());
    const handleResize = () => engine.resize();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      scene.dispose();
      engine.dispose();
      engineRef.current = null;
      sceneRef.current = null;
      meshMapRef.current.clear();
    };
  }, []);  // 空依赖：仅初始化一次

  // ── 设备 Mesh 同步（equipmentList 变化时重建 Mesh）─────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || equipmentList.length === 0) return;

    // 清除旧 mesh
    meshMapRef.current.forEach(mesh => mesh.dispose());
    meshMapRef.current.clear();

    equipmentList.forEach((eq) => {
      const pos = EQUIPMENT_POSITIONS[eq.equipment_id] ?? new Vector3(
        Math.random() * 20 - 10, 0, Math.random() * 20 - 10
      );

      // 按设备类型选择形状（Phase A 简化版）
      const mesh = buildEquipmentMesh(eq, pos, scene);
      mesh.receiveShadows = true;

      // 点击事件
      mesh.actionManager = new ActionManager(scene);
      mesh.actionManager.registerAction(
        new ExecuteCodeAction(ActionManager.OnPickTrigger, () => {
          selectEquipment(eq.equipment_id);
          onEquipmentClick?.(eq.equipment_id);
        })
      );

      meshMapRef.current.set(eq.equipment_id, mesh);
    });
  }, [equipmentList, selectEquipment, onEquipmentClick]);

  // ── 设备状态颜色实时更新（不重建 mesh，只更新材质颜色）──────
  useEffect(() => {
    equipmentList.forEach((eq) => {
      const mesh = meshMapRef.current.get(eq.equipment_id);
      if (!mesh || !mesh.material) return;
      const mat = mesh.material as StandardMaterial;
      mat.diffuseColor = STATUS_COLORS[eq.status] ?? STATUS_COLORS.OFFLINE;
    });
  }, [equipmentList]);

  // ── 选中设备高亮（outline 发光效果）──────────────────────────
  useEffect(() => {
    meshMapRef.current.forEach((mesh, id) => {
      const mat = mesh.material as StandardMaterial;
      if (id === selectedEquipmentId) {
        mat.emissiveColor = new Color3(0.3, 0.3, 0.0);  // 选中：微黄发光
      } else {
        mat.emissiveColor = Color3.Black();
      }
    });
  }, [selectedEquipmentId]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full block"
      style={{ touchAction: "none" }}  // 禁止默认触摸行为（防止移动端滚动干扰）
    />
  );
}

// ── 设备 Mesh 工厂（按类型创建不同形状）─────────────────────────
function buildEquipmentMesh(
  eq: EquipmentState,
  position: Vector3,
  scene: Scene,
): ReturnType<typeof MeshBuilder.CreateBox> {
  const color = STATUS_COLORS[eq.status] ?? STATUS_COLORS.OFFLINE;
  const mat = new StandardMaterial(`mat-${eq.equipment_id}`, scene);
  mat.diffuseColor = color;
  mat.specularColor = new Color3(0.3, 0.3, 0.3);

  let mesh: ReturnType<typeof MeshBuilder.CreateBox>;

  switch (eq.type) {
    case "compressor":
      // 压缩机：大立方体（代表机组外壳）
      mesh = MeshBuilder.CreateBox(`mesh-${eq.equipment_id}`, { width: 2.5, height: 2, depth: 3 }, scene);
      break;
    case "pressure_regulator":
    case "shutoff_valve":
      // 阀门：扁平圆柱
      mesh = MeshBuilder.CreateCylinder(`mesh-${eq.equipment_id}`,
        { diameter: 0.8, height: 1.2, tessellation: 12 }, scene) as any;
      break;
    case "separator":
      // 分离器：高圆柱
      mesh = MeshBuilder.CreateCylinder(`mesh-${eq.equipment_id}`,
        { diameter: 1.5, height: 3.5, tessellation: 16 }, scene) as any;
      break;
    case "flow_meter":
      // 流量计：小球
      mesh = MeshBuilder.CreateSphere(`mesh-${eq.equipment_id}`,
        { diameter: 0.8, segments: 8 }, scene) as any;
      break;
    default:
      mesh = MeshBuilder.CreateBox(`mesh-${eq.equipment_id}`, { size: 1.2 }, scene);
  }

  mesh.position = position.clone();
  mesh.position.y = mesh.getBoundingInfo().boundingBox.extendSize.y;  // 贴地
  mesh.material = mat;
  return mesh;
}
```

### 5.2 使用注意

- **Babylon.js 包安装**：`npm install @babylonjs/core @babylonjs/loaders @babylonjs/gui`
- **WebGPU 降级**：旧浏览器自动降级 WebGL2，代码无需修改
- **Phase C 3D 模型**：将 `buildEquipmentMesh` 替换为 `SceneLoader.ImportMeshAsync(glbUrl)`
- **性能**：场站 ≤ 20 台设备，Phase A 简化 Mesh 性能充足；`LOD` 在 Phase C 引入

---

## 六、Platform API 客户端设计

```typescript
// src/api/client.ts

import axios from "axios";
import { useAuthStore } from "../stores/auth.store";

const platformClient = axios.create({
  baseURL: import.meta.env.VITE_PLATFORM_URL || "http://localhost:8080",
  timeout: 10000,
});

// 自动注入 JWT
platformClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 统一错误处理
platformClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = "/login";
    }
    return Promise.reject(error);
  },
);

export { platformClient };

// ──────────────────────────────────────────────────────

// src/api/objects.ts
export async function getEquipment(equipment_id: string): Promise<EquipmentState> {
  const { data } = await platformClient.get(`/v1/objects/equipment/${equipment_id}`);
  return data;
}

export async function getStation(station_id: string): Promise<StationState> {
  const { data } = await platformClient.get(`/v1/objects/station/${station_id}`);
  return data;
}

// src/api/hitl.ts
// ⚠️ 注意：路径已统一，以下为唯一正确版本
export async function aiDraftWorkOrder(params: { equipment_id: string; context_hint?: string }) {
  // AI 预填草稿（WorkOrderDraftInline 用，不创建工单，只返回草稿内容）
  const { data } = await platformClient.post("/v1/workorders/ai-draft", params);
  return data; // { title, priority, description, estimated_duration_hours }
}

export async function createWorkOrder(params: WorkOrderCreateParams) {
  // 真正建工单（提交 WorkOrderDraftInline 表单后调用）
  const { data } = await platformClient.post("/v1/workorders/", params);
  return data; // { wo_id, state: "draft" }
}

export async function pendingApproval(wo_id: string) {
  // 提交审批（draft → pending_approval，触发飞书推送）
  const { data } = await platformClient.post(`/v1/hitl/workorders/${wo_id}/pending`);
  return data;
}
```

---

## 七、AI 对话与工业能力的集成

```
Studio 的 AI 对话不由 Platform 提供，而是通过 OpenClaw Gateway：

  用户 → Studio AI 对话框（MainShell 右栏）
        → @maibot/adapter WebSocket 连接 OpenClaw Gateway
          → OpenClaw 调用 industrial-twin/kb/workorder/analytics Skills
            → Skills 调用 Platform Tool API（携带用户身份）
              → Platform 返回数据 + citations
                → OpenClaw 组装回复
                  → Studio 渲染（含 citations 角标）

关键点：
  1. Studio 配置 VITE_OPENCLAW_GATEWAY_URL（用户的 OpenClaw）
  2. Studio 配置 VITE_PLATFORM_URL（Platform API）
  3. 这两个是独立的连接，AI 对话走 OpenClaw，数据查询走 Platform
  4. 快捷操作「问 AI」→ 在对话框预填上下文（设备 ID + 当前状态摘要）
     → 用户确认发送 → OpenClaw 收到 → 调用 industrial-twin Skill
```

---

## 八、环境变量（.env）& vite.config.ts

### 8.1 .env 配置

```bash
# Platform API
VITE_PLATFORM_URL=http://localhost:8080

# OpenClaw Gateway（用户地址，由用户在 Settings 中配置，存 localStorage）
# VITE_OPENCLAW_GATEWAY_URL=ws://localhost:3000  ← 不在 .env，在用户设置里

# 当前场站（多站时用户可切换，此为默认值）
VITE_DEFAULT_STATION_ID=CNG-001

# 功能开关（Phase A）
VITE_ENABLE_COMMAND_PAGE=true
VITE_ENABLE_ADMIN=true
VITE_POLLING_INTERVAL_MS=10000   # 实时数据轮询间隔（10秒）
```

### 8.2 vite.config.ts（开发代理配置）

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig(({ mode }) => ({
  plugins: [react()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"), // @ → src/
    },
  },

  server: {
    port: 5173,
    proxy: {
      // 开发时将 /v1/* 请求代理到 Platform API（避免 CORS）
      "/v1": {
        target: process.env.VITE_PLATFORM_URL || "http://localhost:8080",
        changeOrigin: true,
        // rewrite: (path) => path,  // 路径不变，保留 /v1 前缀
      },
    },
  },

  build: {
    target: "esnext", // WebGPU 需要现代浏览器
    sourcemap: mode !== "production",
    rollupOptions: {
      output: {
        // Babylon.js 单独分包（避免主 chunk 过大）
        manualChunks: {
          babylon: ["@babylonjs/core", "@babylonjs/loaders"],
          vendor: ["react", "react-dom", "react-router-dom", "zustand", "axios"],
        },
      },
    },
  },
}));
```

### 8.3 src/types/twin.ts（共享类型定义）

```typescript
// src/types/twin.ts
// 与 Platform API /v1/objects/equipment/{id} 返回结构完全对应

export interface MetricValue {
  value: number;
  unit: string;
  updated_at?: string;
}

export interface ThresholdConfig {
  warn_high?: number;
  alarm_high?: number;
  warn_low?: number;
  alarm_low?: number;
  unit?: string;
}

export type EquipmentStatus = "NORMAL" | "WARNING" | "ALARM" | "OFFLINE";

export interface EquipmentState {
  equipment_id: string;
  name: string;
  type: "compressor" | "pressure_regulator" | "shutoff_valve" | "separator" | "flow_meter" | string;
  station_id: string;
  status: EquipmentStatus;
  current: Record<string, MetricValue>;
  thresholds: Record<string, ThresholdConfig>;
  last_workorder?: {
    id: string;
    status: string;
    work_type: string;
    created_at: string;
  };
  last_updated: string;
}

export interface StationState {
  station_id: string;
  name: string;
  type: string;
  location?: { city: string; coordinates: [number, number] };
  equipment_ids: string[];
  kpi?: {
    availability: number;
    daily_throughput_m3: number;
    active_alarms: number;
    pending_workorders: number;
  };
}

// ── 工单相关类型 ──────────────────────────────────────────────
// ⚠️ 权威定义在 MODULE-DESIGN-PLATFORM.md §19.5
// 开发时直接复制 §19.5 的内容到 src/types/workorder.ts，此处仅作摘要引用

// 字段名对照（与 Platform WorkOrder.to_dict() 输出完全一致）：
//   主键：wo_id（格式 "W-XXXXXXXX"，非 work_order_id / id）
//   状态字段：state（非 status），值全部小写下划线
//   优先级：priority = "P1" | "P2" | "P3"
//   无 action / actual_action / WorkOrderDraftParams.action 字段
//   创建工单用 WorkOrderCreateReq（见 §19.5），非 WorkOrderDraftParams

// 全文搜索 MODULE-DESIGN-PLATFORM.md §19.5 获取完整 TypeScript 类型定义：
//   - WorkOrderState（type union）
//   - WorkOrderPriority（type union）
//   - WorkOrder（interface，含所有字段）
//   - WO_STATE_LABELS / WO_STATE_COLORS / WO_PRIORITY_COLORS（显示映射）
//   - WorkOrderCreateReq（POST /v1/workorders/ 请求体）

// ⚠️ 已废弃：WorkOrderStatus（改为 WorkOrderState），work_order_id（改为 wo_id）
//           status（改为 state），priority "low/normal/high/emergency"（改为 P1/P2/P3）

// ── 知识库查询结果 ────────────────────────────────────────────

export interface KBResult {
  content: string;
  title: string;
  source: string;
  layer: "L0" | "L1" | "L2" | "L3";
  score: number;
  citation: string; // 格式：KB:L0:source / L3:station-X:WO-...
}
```

---

## 九、Studio package.json 依赖

```json
{
  "name": "@clawtwin/studio",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "type-check": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0",
    "zustand": "^4.5.0",
    "axios": "^1.7.0",
    "@babylonjs/core": "^7.0.0",
    "@babylonjs/loaders": "^7.0.0",
    "@babylonjs/gui": "^7.0.0",
    "lucide-react": "^0.400.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.3.0",
    "date-fns": "^3.6.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0",
    "typescript": "^5.5.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "tailwindcss": "^3.4.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0"
  }
}
```

> **shadcn/ui**：通过 `npx shadcn-ui@latest init` 初始化，按需添加组件，不作为 npm 依赖直接安装。
> **Babylon.js 版本**：7.x（最新稳定版，原生支持 WebGPU）；8.x 目前 beta，7.x 更稳定，实际以最新 stable 为准。

---

## 十、组件开发规范

```
命名规范：
  · 工业组件：Industrial*.tsx 或 Equipment*.tsx（在 components/industrial/）
  · 3D 场景：Twin*.tsx 或 Command*.tsx（在 surfaces/）
  · Admin 页面：*Page.tsx（在 pages/admin/）
  · Hooks：use*.ts（在 hooks/）

Citations 显示规范（必须执行）：
  · 所有来自 AI 或 Platform 的数据，必须显示 citations
  · 使用 <CitationBadge citations={data.citations} /> 组件
  · citations 为空时不显示（不是错误，但这种情况需要关注）

状态更新规范：
  · 不在组件内直接调用 platformClient（通过 hooks 封装）
  · 不在组件内处理 loading/error 重试逻辑（在 hooks 层处理）
  · 设备状态计算（阈值比较→status）用 lib/status-utils.ts，不写在组件里

Babylon.js 规范：
  · Babylon 相关代码只在 surfaces/ 目录下
  · 不在普通 React 组件里直接操作 Babylon 场景
  · 场景初始化和销毁必须在同一个 useEffect
  · 不使用 canvas 的 React ref 在其他组件中（单一 owner 原则）
```

---

## 十、LoginPage.tsx + useWorkOrders Hook

### 10.1 LoginPage.tsx（工号登录，完整实现）

```tsx
// src/pages/LoginPage.tsx
import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/auth.store";

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const login = useAuthStore((s) => s.login);

  const [employeeId, setEmployeeId] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const from = (location.state as any)?.from?.pathname ?? "/twin";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeId || !password) {
      setError("请输入工号和密码");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await login(employeeId, password);
      navigate(from, { replace: true });
    } catch (err: any) {
      const msg = err.response?.data?.detail ?? "登录失败，请检查工号和密码";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950">
      <div className="w-full max-w-sm space-y-6 rounded-xl bg-gray-900 p-8 shadow-2xl border border-gray-800">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-white">ClawTwin</h1>
          <p className="text-sm text-gray-400">智能场站数字孪生平台</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-300 mb-1">工号</label>
            <input
              type="text"
              className="w-full rounded-lg bg-gray-800 border border-gray-700 px-4 py-2.5
                         text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
              placeholder="请输入工号"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-1">密码</label>
            <input
              type="password"
              className="w-full rounded-lg bg-gray-800 border border-gray-700 px-4 py-2.5
                         text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
              placeholder="请输入密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>

          {error && <p className="text-sm text-red-400 bg-red-950/30 rounded px-3 py-2">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white
                       hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed
                       transition-colors"
          >
            {loading ? "登录中..." : "登录"}
          </button>
        </form>

        <p className="text-center text-xs text-gray-500">忘记密码请联系系统管理员</p>
      </div>
    </div>
  );
}
```

### 10.2 useWorkOrders Hook

```typescript
// src/hooks/useWorkOrders.ts
import { useState, useEffect, useCallback } from "react";
import { platformClient } from "@/api/client";
import type { WorkOrder, WorkOrderDraftParams } from "@/types/twin";

interface UseWorkOrdersResult {
  workOrders: WorkOrder[];
  isLoading: boolean;
  error: string | null;
  draftWorkOrder: (params: WorkOrderDraftParams) => Promise<WorkOrder>;
  submitForApproval: (wo_id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useWorkOrders(
  station_id: string | null,
  filter?: { status?: WorkOrder["status"]; equipment_id?: string },
): UseWorkOrdersResult {
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkOrders = useCallback(async () => {
    if (!station_id) return;
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ station_id });
      if (filter?.status) params.append("status", filter.status);
      if (filter?.equipment_id) params.append("equipment_id", filter.equipment_id);

      const { data } = await platformClient.get(`/v1/workorders?${params}`);
      setWorkOrders(data.items ?? []);
    } catch (err: any) {
      setError(err.response?.data?.detail ?? "工单加载失败");
    } finally {
      setIsLoading(false);
    }
  }, [station_id, filter?.status, filter?.equipment_id]);

  useEffect(() => {
    fetchWorkOrders();
  }, [fetchWorkOrders]);

  // ⚠️ 路径已统一：草稿用 ai-draft，建单用 /v1/workorders/，提交审批用 /pending
  const aiDraftWorkOrder = async (params: { equipment_id: string }): Promise<AIDraftResult> => {
    const { data } = await platformClient.post("/v1/workorders/ai-draft", params);
    return data; // 只返回草稿内容，不创建工单
  };

  const createWorkOrder = async (params: WorkOrderCreateParams): Promise<WorkOrder> => {
    const { data } = await platformClient.post("/v1/workorders/", params);
    await fetchWorkOrders();
    return data;
  };

  const pendingApproval = async (wo_id: string) => {
    await platformClient.post(`/v1/hitl/workorders/${wo_id}/pending`);
    await fetchWorkOrders();
  };

  return {
    workOrders,
    isLoading,
    error,
    draftWorkOrder,
    submitForApproval,
    refresh: fetchWorkOrders,
  };
}

// ── 待审批工单（主管视角）────────────────────────────────────
export function usePendingApprovals(station_id: string | null) {
  return useWorkOrders(station_id, { state: "pending_approval" }); // ← state 非 status，小写
}
```

---

## 十一、useEquipment Hook 实现

```typescript
// src/hooks/useEquipment.ts
/**
 * 设备实时数据 Hook
 * Phase A：10 秒轮询（简单可靠）
 * Phase B：换成 WebSocket 订阅（Ditto 推送）
 *
 * 使用方式：
 *   const { equipment, isLoading, error } = useEquipment("C-001");
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { getEquipment } from "../api/objects";
import type { EquipmentState } from "../stores/twin.store";

interface UseEquipmentResult {
  equipment: EquipmentState | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useEquipment(
  equipment_id: string | null,
  pollingInterval = 10_000, // 默认 10 秒
): UseEquipmentResult {
  const [equipment, setEquipment] = useState<EquipmentState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEquipment = useCallback(async () => {
    if (!equipment_id) return;
    try {
      const data = await getEquipment(equipment_id);
      setEquipment(data);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "获取设备数据失败");
    } finally {
      setIsLoading(false);
    }
  }, [equipment_id]);

  useEffect(() => {
    if (!equipment_id) {
      setEquipment(null);
      return;
    }

    setIsLoading(true);
    fetchEquipment(); // 立即获取一次

    intervalRef.current = setInterval(fetchEquipment, pollingInterval);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [equipment_id, pollingInterval, fetchEquipment]);

  return { equipment, isLoading, error, refresh: fetchEquipment };
}

// 场站设备列表 Hook
export function useStationEquipment(station_id: string) {
  const [list, setList] = useState<EquipmentState[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const { data } = await import("../api/objects").then((m) => m.getStation(station_id));
      setList(data.equipment ?? []);
      setIsLoading(false);
    };
    load();
    const timer = setInterval(load, 15_000); // 15 秒刷新列表
    return () => clearInterval(timer);
  }, [station_id]);

  return { list, isLoading };
}
```

---

## 十一、AI 快捷操作——「问 AI」上下文注入

```typescript
// src/components/industrial/QuickAskButton.tsx
/**
 * 点击后：
 * 1. 构建设备状态上下文摘要
 * 2. 注入到 OpenClaw 对话框的 draft message
 * 3. 跳转到 AI 对话界面（MainShell 的对话区）
 */

import { useMaibotStore } from "@maibot/store";
import type { EquipmentState } from "../../stores/twin.store";

interface QuickAskButtonProps {
  equipment: EquipmentState;
  prompt?: string;   // 自定义提问前缀，如「帮我建一个工单：」
}

export function QuickAskButton({ equipment, prompt }: QuickAskButtonProps) {
  const setDraftMessage = useMaibotStore(s => s.setDraftMessage);  // maibot-ui 原生 API

  const handleClick = () => {
    // 构建上下文摘要（让 AI 知道当前在看哪台设备）
    const statusLine = Object.entries(equipment.current ?? {})
      .map(([k, v]) => `${k}: ${v.value} ${v.unit}`)
      .slice(0, 3)
      .join("，");

    const context = [
      `[设备上下文] ${equipment.name}（${equipment.equipment_id}）`,
      `当前状态：${equipment.status}`,
      statusLine,
      prompt ?? "请分析这台设备的当前状态并给出建议。",
    ].join("\n");

    // 注入到 AI 对话框（用户仍可修改后发送）
    setDraftMessage(context);
  };

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
    >
      🤖 问 AI
    </button>
  );
}

// 工单快捷建单按钮（预填设备和症状）
export function QuickWorkOrderButton({ equipment }: { equipment: EquipmentState }) {
  const setDraftMessage = useMaibotStore(s => s.setDraftMessage);

  const handleClick = () => {
    const alarmMetrics = Object.entries(equipment.current ?? {})
      .filter(([k]) => {
        const th = equipment.thresholds?.[k];
        const v = equipment.current?.[k]?.value;
        return th && v !== undefined && v >= th.warn;
      })
      .map(([k, v]) => `${k}: ${v.value} ${v.unit}（阈值: ${equipment.thresholds?.[k]?.warn}）`)
      .join("，");

    setDraftMessage(
      `[设备上下文] ${equipment.name}（${equipment.equipment_id}）\n` +
      `异常指标：${alarmMetrics || "请描述"}\n` +
      `请帮我生成一个维修工单草稿。`
    );
  };

  return (
    <button onClick={handleClick} className="flex items-center gap-1 text-sm text-orange-600">
      📋 建工单
    </button>
  );
}
```

---

## 十二、CommandPage 组件设计（指挥大屏）

```
CommandPage（/command，全屏，无 RequireAuth）
│
├── CommandSurface（全屏 Babylon.js，占 80% 宽度）
│   ├── 与 TwinSurface 共用同一个场景逻辑
│   ├── 相机：俯视固定角度（适合大屏投影）
│   └── 告警闪烁动画（ALARM 设备 → 红色脉冲效果）
│
├── RightKPIPanel（固定 20% 宽度，深色背景）
│   ├── StationNameHeader（场站名 + 日期时间，大字体）
│   ├── AlertSummary
│   │   ├── P1 告警数（红色大数字）
│   │   ├── P2 告警数（黄色）
│   │   └── P3 告警数（蓝色）
│   ├── KeyEquipmentStatus（5-8台核心设备）
│   │   └── [每行] 设备名 + StatusBadge + 关键指标值
│   ├── TodayWorkOrders
│   │   ├── 待审批：N条（红色提示）
│   │   └── 已完成：N条
│   └── DataFeedHealth
│       ├── OPC-UA：🟢 / 🔴
│       ├── Platform：🟢 / 🔴
│       └── 数据时间：最后更新 HH:mm:ss
│
└── AlertOverlay（告警时弹出，5秒自动消失）
    ├── 设备名 + 告警级别
    ├── 告警指标和当前值
    └── [跳转 Studio] 按钮
```

```typescript
// 关键实现：CommandPage 自动刷新 + 告警触发
// 不需要用户交互，设计为"被动展示"模式

useEffect(() => {
  // 每 5 秒刷新 KPI 数据
  const timer = setInterval(async () => {
    const kpi = await getStation(stationId);
    setKpiData(kpi);

    // 检查新告警
    const newAlarms = kpi.equipment.filter((e) => e.status === "ALARM");
    if (newAlarms.length > prevAlarmCount.current) {
      setActiveAlert(newAlarms[0]); // 显示 Overlay
      setTimeout(() => setActiveAlert(null), 5000); // 5s 后消失
    }
    prevAlarmCount.current = newAlarms.length;
  }, 5000);

  return () => clearInterval(timer);
}, [stationId]);
```

---

## 十三、Admin KnowledgePage 组件设计

```
KnowledgePage（/admin/knowledge，需要 kb_admin 或 sys_admin 角色）
│
├── PageHeader（页面标题 + 上传按钮）
│
├── DocumentFilterBar
│   ├── LayerFilter（全部 / L0 / L1 / L2）
│   ├── StatusFilter（全部 / 处理中 / 已入库 / 失败）
│   ├── EquipmentTypeFilter（可选）
│   └── SearchInput（按文件名/标题搜索）
│
├── DocumentTable
│   ├── 列：文件名 / 层级 / 来源 / 分块数 / 状态 / 入库时间 / 操作
│   ├── 状态展示：
│   │   · pending    → 灰色点 + "等待处理"
│   │   · processing → 蓝色旋转 + 进度提示
│   │   · indexed    → 绿色 ✓ + 分块数
│   │   · failed     → 红色 ✗ + 错误信息 hover 展开
│   └── 操作列：[重试]（failed 状态）/ [删除]
│
├── UploadDialog（点击「上传文档」弹出）
│   ├── FileDrop（拖拽或点击上传，支持 PDF/DOCX/TXT）
│   ├── LayerSelect（L0 / L1 / L2，必填）
│   ├── EquipmentTypeSelect（可选，缩小检索范围）
│   ├── StationSelect（L2 必填，限制到用户有权限的场站）
│   ├── TitleInput（可选，留空从文件名推断）
│   ├── SourceInput（标准编号或来源，建议填写）
│   └── 上传按钮
│
└── GraphRAGPanel（折叠面板）
    ├── GraphRAG 状态（上次重建时间、实体数量）
    └── [触发重建] 按钮（sys_admin only）
```

```typescript
// 关键：上传后轮询状态（最终换成 SSE 流）
const handleUpload = async (formData: FormData) => {
  const { doc_id } = await ingestDocument(formData);
  setUploadingDocId(doc_id);

  // 每 2 秒轮询状态（最多 5 分钟）
  const pollTimer = setInterval(async () => {
    const { status, chunk_count } = await getDocumentStatus(doc_id);
    updateDocumentStatus(doc_id, status, chunk_count);
    if (status === "indexed" || status === "failed") {
      clearInterval(pollTimer);
      setUploadingDocId(null);
    }
  }, 2000);
};
```

---

## 十四、Admin UserPage 组件设计

```
UserPage（/admin/users，需要 sys_admin 角色）
│
├── PageHeader（"用户管理" + 「新建用户」按钮）
│
├── UserTable
│   ├── 列：工号 / 姓名 / 角色 / 场站权限 / 飞书绑定状态 / 最后登录 / 操作
│   ├── 角色显示：
│   │   · operator   → 蓝色徽章 "操作员"
│   │   · supervisor → 橙色徽章 "主管"
│   │   · kb_admin   → 紫色徽章 "知识管理员"
│   │   · sys_admin  → 红色徽章 "系统管理员"
│   ├── 飞书绑定状态：
│   │   · 已绑定 → 🟢 显示飞书头像缩略图 + open_id 尾部
│   │   · 未绑定 → 🔴 "未绑定" + [发送绑定邀请] 按钮
│   └── 操作列：[编辑权限] [重置密码] [禁用]
│
├── CreateUserDialog（点击「新建用户」）
│   ├── 工号 Input（唯一，系统用于登录）
│   ├── 姓名 Input
│   ├── 初始密码 Input（用户首次登录后强制修改）
│   ├── 角色 Select（单选：operator / supervisor / kb_admin / sys_admin）
│   ├── 场站权限 MultiSelect（从场站列表中选，可多选）
│   └── 创建按钮
│
└── EditPermissionsDialog（点击「编辑权限」）
    ├── 角色 Select
    └── 场站权限 MultiSelect（动态更新，下次请求生效）
```

```typescript
// 关键：飞书绑定邀请流程
// 管理员点击「发送绑定邀请」→ Platform 生成一次性绑定码 → 通过飞书 Bot 私信发给用户
// 用户打开链接（studio.clawtwin.local/bind?token=xxx）→ 用工号密码登录 → 自动绑定

const sendBindInvite = async (userId: string) => {
  await platformClient.post(`/v1/admin/users/${userId}/bind-invite`);
  // Platform 会：
  //   1. 生成 15 分钟有效的绑定 token
  //   2. 发飞书私信给用户（通过 user.feishu_open_id 发，如已知）
  //      或发到管理员，让管理员转发（如用户未绑定）
};

// BindPage（/bind，不需要认证，只需 token 参数）
// 用于处理飞书绑定邀请的一次性页面
// URL：/bind?token=xxx&feishu_open_id=ou_yyy
// 1. 用户用工号+密码登录
// 2. Platform 验证 token 有效 + 未使用 → 写 user_feishu_bindings 表
// 3. 跳转 /twin（或飞书内跳转回对话）
```

---

## 十五、Nginx 路由配置（nginx/nginx.conf）

```nginx
# nginx/nginx.conf
# Nginx 是所有外部流量的唯一入口
# 路由规则：/ai/* → OpenClaw Gateway，/api/* → Platform API，/ → Studio

upstream platform_api {
    server platform-api:8080;
}
upstream openclaw_gateway {
    server openclaw:3000;
}

server {
    listen 80;
    server_name studio.clawtwin.local;

    # 强制 HTTPS（生产环境）
    # return 301 https://$host$request_uri;

    # OpenClaw AI 对话通道
    location /ai/ {
        proxy_pass http://openclaw_gateway/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket 支持
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;   # AI 推理可能慢，超时设长
    }

    # Platform API
    location /api/ {
        rewrite ^/api/(.*) /v1/$1 break;
        proxy_pass http://platform_api;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # 速率限制（防暴力破解和 DDoS）
        # limit_req zone=api burst=20 nodelay;
    }

    # 飞书 Webhook 回调（直接到 Platform）
    location /v1/feishu/ {
        proxy_pass http://platform_api;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Studio 前端静态资源
    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files $uri $uri/ /index.html;  # SPA fallback
        # 静态资源缓存
        location ~* \.(js|css|png|jpg|woff2|glb|hdr)$ {
            expires 30d;
            add_header Cache-Control "public, immutable";
        }
    }
}
```

Docker Compose 中 Nginx 的配置挂载：

```yaml
nginx:
  image: nginx:1.25-alpine
  volumes:
    - ./nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro
    - ./clawtwin-studio/dist:/usr/share/nginx/html:ro # Studio 构建产物
  ports:
    - "80:80"
    - "443:443"
  depends_on:
    - platform-api
    - openclaw
```

---

## 十六、StudioShell — 主布局实现（Palantir 三区+时间轴）

新版布局替代原来的 `TwinPage` + `MainShell` 拼接方式。
完整布局逻辑见 `UI-UX-DESIGN.md §二`。

```tsx
// src/components/layout/StudioShell.tsx
import { useState, useCallback } from "react";
import NavRail from "./NavRail";
import CenterPanel from "./CenterPanel";
import IntelPanel from "./IntelPanel";
import TimeLine from "./TimeLine";
import { useTwinStore } from "@/stores/twin.store";

type CenterView = "twin" | "graph" | "trend" | "workorders";

export default function StudioShell() {
  const [centerView, setCenterView] = useState<CenterView>("twin");
  const [navExpanded, setNavExpanded] = useState(true);
  const { selectedEquipmentId } = useTwinStore();

  return (
    <div className="flex flex-col h-screen bg-[#0D1117] text-[#E6EDF3]">
      {/* 顶栏 48px */}
      <header
        className="h-12 flex items-center justify-between px-4
                         border-b border-[#21262D] bg-[#161B22] shrink-0"
      >
        <div className="flex items-center gap-3">
          <span className="text-[#1F6FEB] font-bold text-sm">◆ ClawTwin</span>
          <StationSelector />
        </div>
        <div className="flex items-center gap-3 text-sm text-[#8B949E]">
          <AIStatusIndicator />
          <UserMenu />
        </div>
      </header>

      {/* 主体区域：L + C + R */}
      <div className="flex flex-1 overflow-hidden">
        {/* L：左侧对象浏览器 */}
        <NavRail expanded={navExpanded} onToggle={() => setNavExpanded((v) => !v)} />

        {/* C：中央决策面 */}
        <CenterPanel view={centerView} onViewChange={setCenterView} className="flex-1 min-w-0" />

        {/* R：右侧情报面板（始终存在，宽度变化） */}
        <IntelPanel
          selectedEquipmentId={selectedEquipmentId}
          className="w-[340px] border-l border-[#21262D] shrink-0"
        />
      </div>

      {/* 底部时间轴 40px */}
      <TimeLine className="h-10 border-t border-[#21262D] bg-[#161B22] shrink-0" />
    </div>
  );
}
```

---

## 十七、IntelPanel — 右侧情报面板（核心 UI 创新）

这是 ClawTwin 最重要的 UI 组件，实现 Palantir「对象页」范式：

```tsx
// src/components/layout/IntelPanel.tsx
import { useEffect, useState } from "react";
import AlertQueuePanel from "@/components/intelligence/AlertQueuePanel";
import DeviceIntelPanel from "@/components/intelligence/DeviceIntelPanel";
import { useTwinStore } from "@/stores/twin.store";

interface Props {
  selectedEquipmentId: string | null;
  className?: string;
}

export default function IntelPanel({ selectedEquipmentId, className }: Props) {
  return (
    <aside className={`flex flex-col bg-[#161B22] overflow-hidden ${className}`}>
      {selectedEquipmentId ? (
        // 选中设备：显示完整情报页
        <DeviceIntelPanel equipmentId={selectedEquipmentId} />
      ) : (
        // 无选中：显示全局告警摘要
        <AlertQueuePanel />
      )}
    </aside>
  );
}
```

```tsx
// src/components/intelligence/DeviceIntelPanel.tsx
// 对应 UI-UX-DESIGN.md §三.2 的完整实现

import { useState } from "react";
import { MetricBar } from "@/components/industrial/MetricBar";
import AIInsightCard from "./AIInsightCard";
import ActionPanel from "./ActionPanel";
import WorkOrderDraftInline from "./WorkOrderDraftInline";
import { useTwinStore } from "@/stores/twin.store";
import { useEquipmentIntel } from "@/hooks/useEquipmentIntel";

type PanelMode = "intel" | "draft_workorder";

export default function DeviceIntelPanel({ equipmentId }: { equipmentId: string }) {
  const [mode, setMode] = useState<PanelMode>("intel");
  const { equipmentList } = useTwinStore();
  const equipment = equipmentList.find((e) => e.equipment_id === equipmentId);
  const { aiInsight, isLoadingAI } = useEquipmentIntel(equipmentId);

  if (!equipment) return null;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* 设备标题 */}
      <div className="p-4 border-b border-[#21262D] sticky top-0 bg-[#161B22] z-10">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">{equipment.name}</h2>
            <p className="text-xs text-[#8B949E]">{equipment.equipment_id}</p>
          </div>
          <StatusBadge status={equipment.status} />
        </div>
        <div className="flex gap-2 mt-2">
          <button
            className="text-xs text-[#1F6FEB] hover:underline"
            onClick={() => {
              /* 定位到3D */
            }}
          >
            在3D中定位
          </button>
          <button
            className="text-xs text-[#1F6FEB] hover:underline"
            onClick={() => {
              /* 切换到关系图 */
            }}
          >
            关系图
          </button>
        </div>
      </div>

      {mode === "intel" ? (
        <>
          {/* Section 1: 实时指标 */}
          <section className="p-4 border-b border-[#21262D]">
            <h3 className="text-xs font-medium text-[#8B949E] mb-3 uppercase tracking-wide">
              实时指标
            </h3>
            {Object.entries(equipment.realtime ?? {}).map(([key, val]) => (
              <MetricBar
                key={key}
                label={key}
                value={val.value}
                unit={val.unit}
                warnThreshold={equipment.thresholds?.[key]?.warn}
                alarmThreshold={equipment.thresholds?.[key]?.alarm}
                updatedAt={val.timestamp}
              />
            ))}
          </section>

          {/* Section 2: AI 情报解读（自动触发，流式输出） */}
          <section className="p-4 border-b border-[#21262D]">
            <AIInsightCard equipmentId={equipmentId} insight={aiInsight} isLoading={isLoadingAI} />
          </section>

          {/* Section 3: 建议行动 */}
          <section className="p-4 border-b border-[#21262D]">
            <ActionPanel
              equipmentId={equipmentId}
              onCreateWorkOrder={() => setMode("draft_workorder")}
            />
          </section>

          {/* Section 4: 24h 趋势迷你图（可展开） */}
          <section className="p-4 border-b border-[#21262D]">
            <TrendMiniChart equipmentId={equipmentId} hours={24} />
          </section>

          {/* Section 5: 最近工单 */}
          <section className="p-4">
            <RecentWorkOrders equipmentId={equipmentId} limit={3} />
          </section>
        </>
      ) : (
        // 工单草稿模式（内嵌，不跳页面）
        <WorkOrderDraftInline
          equipmentId={equipmentId}
          onBack={() => setMode("intel")}
          onSubmitted={() => setMode("intel")}
        />
      )}
    </div>
  );
}
```

---

## 十八、AIInsightCard — AI 情报卡（citations 必须可点击）

```tsx
// src/components/intelligence/AIInsightCard.tsx
// 对应 UI-UX-DESIGN.md §九.2

interface Citation {
  type: "data" | "prediction" | "workorder" | "knowledge";
  label: string;
  link?: string; // 可点击跳转
}

interface AIInsight {
  summary: string; // AI 主判断文本
  citations: Citation[]; // 证据链
  generatedAt: string;
}

interface Props {
  equipmentId: string;
  insight: AIInsight | null;
  isLoading: boolean;
}

export default function AIInsightCard({ equipmentId, insight, isLoading }: Props) {
  return (
    // AI 内容专属样式：淡紫底 + 左紫边框（见 UI-UX-DESIGN §八.1）
    <div className="rounded border-l-2 border-[#A78BFA] bg-[rgba(167,139,250,0.08)] p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-[#A78BFA]">✦ AI 情报解读</span>
        <span className="text-xs text-[#484F58]">自动生成</span>
      </div>

      {isLoading ? (
        <div className="text-sm text-[#8B949E] animate-pulse">AI 正在分析...</div>
      ) : insight ? (
        <>
          {/* 主判断（流式输出完成后显示全文） */}
          <p className="text-sm text-[#E6EDF3] mb-3 leading-relaxed">「{insight.summary}」</p>

          {/* 证据链：每个 citation 都可点击 */}
          <div className="space-y-1">
            <p className="text-xs text-[#8B949E] mb-1">证据链：</p>
            {insight.citations.map((c, i) => (
              <CitationLink key={i} citation={c} />
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-[#8B949E]">暂无 AI 分析（设备状态正常）</p>
      )}
    </div>
  );
}

// CitationLink：可点击的 citation（不可用时禁用，不隐藏）
function CitationLink({ citation }: { citation: Citation }) {
  const icons: Record<Citation["type"], string> = {
    data: "•",
    prediction: "•",
    workorder: "•",
    knowledge: "•",
  };

  return (
    <div className="text-xs text-[#8B949E]">
      {icons[citation.type]}{" "}
      {citation.link ? (
        <a
          href={citation.link}
          className="text-[#1F6FEB] underline hover:text-[#58A6FF]"
          target="_blank"
          rel="noopener noreferrer"
        >
          {citation.label}
        </a>
      ) : (
        <span>{citation.label}</span>
      )}
    </div>
  );
}
```

---

## 十九、NavRail — 左侧对象浏览器

```tsx
// src/components/layout/NavRail.tsx
// 对应 UI-UX-DESIGN.md §二.2 的对象浏览器

import { useTwinStore } from "@/stores/twin.store";
import { useAlertStore } from "@/stores/alert.store";
import { useWorkOrderStore } from "@/stores/workorder.store";

interface Props {
  expanded: boolean;
  onToggle: () => void;
}

export default function NavRail({ expanded, onToggle }: Props) {
  const { equipmentList, selectedEquipmentId, selectEquipment } = useTwinStore();
  const { alerts } = useAlertStore();
  const { pendingApprovals } = useWorkOrderStore();

  // 按 status 排序：ALARM 最前，WARN 次之，NORMAL 最后
  const sorted = [...equipmentList].sort((a, b) => {
    const order = { ALARM: 0, WARNING: 1, NORMAL: 2, OFFLINE: 3 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9);
  });

  return (
    <nav
      className={`flex flex-col bg-[#161B22] border-r border-[#21262D]
                     transition-all duration-200 shrink-0 overflow-hidden
                     ${expanded ? "w-60" : "w-12"}`}
    >
      {/* 折叠/展开按钮 */}
      <button
        onClick={onToggle}
        className="h-12 flex items-center justify-center text-[#8B949E] hover:text-[#E6EDF3]"
      >
        {expanded ? "◀" : "▶"}
      </button>

      <div className="overflow-y-auto flex-1">
        {/* 全局搜索（展开状态才显示输入框） */}
        {expanded && (
          <div className="px-3 pb-2">
            <input
              placeholder="搜索设备 / 工单"
              className="w-full bg-[#21262D] text-xs rounded px-2 py-1.5
                         text-[#E6EDF3] placeholder:text-[#484F58] outline-none"
            />
          </div>
        )}

        {/* 设备列表（按工艺系统分组） */}
        <EquipmentTree
          equipment={sorted}
          selectedId={selectedEquipmentId}
          onSelect={selectEquipment}
          compact={!expanded}
        />

        {/* 告警队列 */}
        <NavSection
          icon="⚡"
          label="告警队列"
          badge={alerts.filter((a) => a.level === "P1").length}
          badgeColor="red"
          compact={!expanded}
          href="/twin?view=alerts"
        />

        {/* 工单 */}
        <NavSection
          icon="📋"
          label={`工单 · 今日${pendingApprovals.length}待审`}
          badge={pendingApprovals.length}
          badgeColor="orange"
          compact={!expanded}
          href="/twin?view=workorders"
        />

        {/* 知识库 / 报告 / 管理 */}
        <NavSection icon="📚" label="知识库" compact={!expanded} href="/admin/knowledge" />
        <NavSection icon="📊" label="报告" compact={!expanded} href="/reports" />
        <NavSection icon="⚙️" label="管理" compact={!expanded} href="/admin" />
      </div>

      {/* 底部状态 */}
      {expanded && (
        <div className="p-3 border-t border-[#21262D] text-xs text-[#484F58]">
          <div>
            AI 状态: <span className="text-[#22C55E]">● 在线</span>
          </div>
          <div>
            数据: <span className="text-[#22C55E]">● 实时</span>
          </div>
        </div>
      )}
    </nav>
  );
}
```

---

## 二十、useEquipmentIntel Hook — AI 情报自动触发

选中设备时自动请求 AI 分析（不需要用户手动点击）：

```typescript
// src/hooks/useEquipmentIntel.ts

import { useState, useEffect } from "react";
import { platformClient } from "@/api/client";
import { useTwinStore } from "@/stores/twin.store";

interface AIInsight {
  summary: string;
  citations: Array<{ type: string; label: string; link?: string }>;
  generatedAt: string;
}

export function useEquipmentIntel(equipmentId: string | null) {
  const [aiInsight, setAiInsight] = useState<AIInsight | null>(null);
  const [isLoadingAI, setIsLoadingAI] = useState(false);

  useEffect(() => {
    if (!equipmentId) {
      setAiInsight(null);
      return;
    }

    // 设备选中后，立即触发 AI 分析（不等用户点按钮）
    const controller = new AbortController();
    setIsLoadingAI(true);
    setAiInsight(null);

    platformClient
      .post(
        `/v1/tools/diagnose_equipment`,
        { equipment_id: equipmentId, auto_trigger: true },
        { signal: controller.signal },
      )
      .then((res) => {
        setAiInsight(res.data.insight);
      })
      .catch((err) => {
        if (err.name !== "CanceledError") console.error("AI insight error", err);
      })
      .finally(() => {
        setIsLoadingAI(false);
      });

    // 切换设备时取消上一个请求
    return () => controller.abort();
  }, [equipmentId]);

  return { aiInsight, isLoadingAI };
}
```

> **注意**：`auto_trigger: true` 时 Platform 调用 OpenClaw Tool `diagnose_equipment`，
> 使用 AI 推理模式（较轻量，约 2-4 秒）。手动点「展开完整分析」时，去掉此参数，
> 调用完整的多步推理（可能 8-15 秒）。

---

## 二十一、TimeLine — 底部时间轴

```tsx
// src/components/layout/TimeLine.tsx
// 对应 UI-UX-DESIGN.md §四

import { useState } from "react";
import { useTwinStore } from "@/stores/twin.store";

export default function TimeLine({ className }: { className?: string }) {
  const [isLive, setIsLive] = useState(true);
  const [currentTime, setCurrentTime] = useState<Date>(new Date());
  const { setHistoryMode } = useTwinStore();

  function handleReturnToLive() {
    setIsLive(true);
    setHistoryMode(null); // 清除历史时间，恢复实时
  }

  return (
    <div className={`flex items-center gap-3 px-4 text-xs text-[#8B949E] ${className}`}>
      {/* 时间范围快捷选择 */}
      <div className="flex gap-1">
        {["1h", "6h", "24h", "7d"].map((r) => (
          <button key={r} className="px-1.5 py-0.5 rounded hover:bg-[#21262D] hover:text-[#E6EDF3]">
            {r}
          </button>
        ))}
      </div>

      {/* 时间轴（简化实现：Phase A 用时间选择器，Phase B 改为拖拽） */}
      <div className="flex-1 h-2 bg-[#21262D] rounded-full relative cursor-pointer">
        {/* 告警事件标记（相对位置） */}
        {/* Phase A: 静态展示最近几个告警时间点 */}
        <div className="absolute inset-y-0 right-0 w-1/3 bg-[#22C55E]/20 rounded-full" />
      </div>

      {/* 当前时间 / 历史时间 */}
      <span className="font-mono text-[#E6EDF3]">
        {isLive
          ? new Date().toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })
          : currentTime.toLocaleString("zh-CN")}
      </span>

      {/* 实时/历史切换 */}
      {isLive ? (
        <span className="text-[#22C55E]">● 实时</span>
      ) : (
        <button onClick={handleReturnToLive} className="text-[#1F6FEB] underline">
          ▶ 回到实时
        </button>
      )}
    </div>
  );
}
```

---

## 二十二、P&ID 视图 — PIDView.tsx（工艺流程图，react-flow）

P&ID 视图是给流程工程师用的第五个中央视图，使用 `react-flow` 渲染管道仪表图。

### 22.1 依赖安装

```bash
# package.json 追加
pnpm add reactflow @reactflow/node-toolbar
```

### 22.2 类型定义（src/types/pid.ts）

```typescript
// src/types/pid.ts

export type PIDNodeStatus = "normal" | "warn" | "alarm" | "offline";

export interface PIDEquipmentData {
  label: string;
  equipment_id: string;
  design: Record<string, string>; // { pressure: "6.0 MPa" }
  realtime: Record<string, number>; // { pressure: 5.8 }
  status: PIDNodeStatus;
  alerts: string[];
}

export interface PIDInstrumentData {
  tag: string; // "PIC-001"
  type: "pressure" | "temperature" | "flow" | "level" | "control_valve";
  realtime_value?: number;
  unit?: string;
  status: PIDNodeStatus;
}

export type PIDEdgeType = "gas_line" | "liquid_line" | "instrument_line" | "signal_line";
```

### 22.3 PID 节点组件（src/components/pid/）

```typescript
// src/components/pid/EquipmentNode.tsx
import { Handle, Position, NodeProps } from "reactflow";
import type { PIDEquipmentData } from "@/types/pid";

const STATUS_COLORS: Record<string, string> = {
  normal:  "#22C55E",
  warn:    "#F59E0B",
  alarm:   "#EF4444",
  offline: "#6B7280",
};

export function EquipmentNode({ data }: NodeProps<PIDEquipmentData>) {
  const color = STATUS_COLORS[data.status];
  const isAlarm = data.status === "alarm";

  return (
    <div
      className="relative px-3 py-2 rounded border-2 bg-[#161B22] text-xs min-w-[80px] text-center"
      style={{
        borderColor: color,
        boxShadow: isAlarm ? `0 0 8px ${color}` : "none",
        animation: isAlarm ? "pid-alarm-pulse 1s infinite" : "none",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#6B7280" }} />

      {/* 设备符号（Phase A: 文字标识，Phase B: SVG 图标） */}
      <div className="text-[10px] text-[#8B949E]">{data.equipment_id}</div>
      <div className="font-medium text-[#E6EDF3]">{data.label}</div>

      {/* 实时参数（最多显示 2 个关键参数） */}
      {Object.entries(data.realtime).slice(0, 2).map(([k, v]) => (
        <div key={k} className="text-[10px]" style={{ color }}>
          {k}: {v} {data.design[k]?.match(/[a-zA-Z%/]+/)?.[0] ?? ""}
        </div>
      ))}

      {/* 告警气泡 */}
      {data.alerts.length > 0 && (
        <div className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-[#EF4444] text-white text-[8px] flex items-center justify-center">
          {data.alerts.length}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: "#6B7280" }} />
    </div>
  );
}
```

```typescript
// src/components/pid/InstrumentNode.tsx
import { Handle, Position, NodeProps } from "reactflow";
import type { PIDInstrumentData } from "@/types/pid";

const TYPE_SYMBOL: Record<string, string> = {
  pressure:       "P",
  temperature:    "T",
  flow:           "F",
  level:          "L",
  control_valve:  "V",
};

export function InstrumentNode({ data }: NodeProps<PIDInstrumentData>) {
  const symbol = TYPE_SYMBOL[data.type] ?? "?";
  const isOk = data.status === "normal";

  return (
    <div className="flex flex-col items-center gap-0.5">
      <Handle type="target" position={Position.Top} />
      {/* ISA-5.1 圆形仪表符号 */}
      <div
        className="w-8 h-8 rounded-full border-2 flex items-center justify-center text-[10px] font-bold bg-[#161B22]"
        style={{ borderColor: isOk ? "#30363D" : "#F59E0B" }}
      >
        {symbol}
      </div>
      {/* 位号标签 */}
      <div className="text-[9px] text-[#8B949E]">{data.tag}</div>
      {/* 实时值 */}
      {data.realtime_value !== undefined && (
        <div className="text-[9px] font-mono text-[#E6EDF3]">
          {data.realtime_value} {data.unit}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
```

### 22.4 PIDView 主视图（src/pages/studio/PIDView.tsx）

```typescript
// src/pages/studio/PIDView.tsx
import ReactFlow, {
  Background, Controls, MiniMap, useNodesState, useEdgesState,
  addEdge, Panel, MarkerType
} from "reactflow";
import "reactflow/dist/style.css";
import { EquipmentNode } from "@/components/pid/EquipmentNode";
import { InstrumentNode } from "@/components/pid/InstrumentNode";
import { useTwinStore } from "@/stores/twin.store";
import { useEffect, useCallback, useState } from "react";
import { api } from "@/lib/api";

// 注册自定义节点类型
const nodeTypes = {
  equipment: EquipmentNode,
  instrument: InstrumentNode,
};

// 管线样式定义
const edgeStyles = {
  gas_line:        { stroke: "#E6EDF3", strokeWidth: 2 },
  liquid_line:     { stroke: "#3B82F6", strokeWidth: 2, strokeDasharray: "5,5" },
  instrument_line: { stroke: "#F59E0B", strokeWidth: 1, strokeDasharray: "2,3" },
  signal_line:     { stroke: "#8B5CF6", strokeWidth: 1, strokeDasharray: "2,3" },
};

export default function PIDView() {
  const { selectedStationId, setSelectedEquipmentId } = useTwinStore();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [displayMode, setDisplayMode] = useState<"design" | "realtime" | "delta">("realtime");
  const [filter, setFilter] = useState("all");

  // 从 Platform 加载 P&ID 数据
  useEffect(() => {
    if (!selectedStationId) return;
    api.get(`/v1/pid/layout/${selectedStationId}`).then(res => {
      const { nodes: rawNodes, edges: rawEdges } = res.data;
      setNodes(rawNodes.map((n: any) => ({
        ...n,
        type: n.data?.tag ? "instrument" : "equipment",
      })));
      setEdges(rawEdges.map((e: any) => ({
        ...e,
        style: edgeStyles[e.data?.line_type as keyof typeof edgeStyles] ?? edgeStyles.gas_line,
        markerEnd: { type: MarkerType.ArrowClosed, color: "#E6EDF3" },
      })));
    });
  }, [selectedStationId]);

  // 定时刷新实时数据（10 秒）
  useEffect(() => {
    if (displayMode !== "realtime") return;
    const id = setInterval(() => {
      api.get(`/v1/pid/realtime/${selectedStationId}`).then(res => {
        const updates: Record<string, any> = res.data;
        setNodes(prev => prev.map(n => {
          const upd = updates[n.id];
          if (!upd) return n;
          return { ...n, data: { ...n.data, ...upd } };
        }));
      });
    }, 10_000);
    return () => clearInterval(id);
  }, [displayMode, selectedStationId]);

  // 点击设备节点 → 联动右侧情报面板
  const onNodeClick = useCallback((_: any, node: any) => {
    if (node.type === "equipment" && node.data.equipment_id) {
      setSelectedEquipmentId(node.data.equipment_id);
    }
  }, [setSelectedEquipmentId]);

  return (
    <div className="w-full h-full flex flex-col bg-[#0D1117]">
      {/* 工具栏 */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[#30363D] text-xs">
        <span className="text-[#8B949E]">显示模式</span>
        {(["design", "realtime", "delta"] as const).map(m => (
          <button key={m}
            onClick={() => setDisplayMode(m)}
            className={`px-2 py-1 rounded ${displayMode === m
              ? "bg-[#1F6FEB] text-white"
              : "text-[#8B949E] hover:text-[#E6EDF3]"}`}
          >
            {{ design: "设计值", realtime: "实时值", delta: "偏差" }[m]}
          </button>
        ))}

        <div className="flex-1" />

        {/* 工艺区过滤 */}
        <span className="text-[#8B949E]">工艺区</span>
        {["all", "inlet", "compress", "meter", "outlet"].map(f => (
          <button key={f}
            onClick={() => setFilter(f)}
            className={`px-2 py-0.5 rounded ${filter === f
              ? "bg-[#21262D] text-[#E6EDF3]"
              : "text-[#6B7280] hover:text-[#8B949E]"}`}
          >
            {{ all: "全部", inlet: "进站", compress: "压缩", meter: "计量", outlet: "外输" }[f]}
          </button>
        ))}

        {/* 图例 */}
        <div className="flex items-center gap-3 ml-4">
          <span className="flex items-center gap-1">
            <span className="w-4 h-0.5 bg-[#E6EDF3] inline-block" />
            <span className="text-[#6B7280]">气管</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-4 h-0.5 bg-[#3B82F6] inline-block border-dashed border-t border-[#3B82F6]" />
            <span className="text-[#6B7280]">液管</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="w-4 h-0.5 bg-[#F59E0B] inline-block" />
            <span className="text-[#6B7280]">仪表线</span>
          </span>
        </div>
      </div>

      {/* react-flow 画布 */}
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.3}
          maxZoom={3}
        >
          <Background color="#21262D" gap={20} />
          <Controls className="!bg-[#161B22] !border-[#30363D]" />
          <MiniMap
            className="!bg-[#161B22] !border-[#30363D]"
            nodeColor={n => STATUS_COLORS[n.data?.status] ?? "#6B7280"}
          />
          {/* AI 分析面板（右上角悬浮） */}
          <Panel position="top-right">
            <PIDInsightPanel />
          </Panel>
        </ReactFlow>
      </div>
    </div>
  );
}

// P&ID AI 洞察悬浮面板
function PIDInsightPanel() {
  const [insight, setInsight] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runAnalysis() {
    setLoading(true);
    try {
      const res = await api.post("/v1/tools/analyze_pid", {});
      setInsight(res.data.insight);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-[#161B22] border border-[#30363D] rounded-lg p-3 w-64 text-xs">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[#8B5CF6] font-medium">🤖 AI 工艺分析</span>
        <button onClick={runAnalysis}
          className="text-[#1F6FEB] hover:text-[#58A6FF] disabled:opacity-40"
          disabled={loading}>
          {loading ? "分析中..." : "立即分析"}
        </button>
      </div>
      {insight
        ? <p className="text-[#E6EDF3] leading-relaxed">{insight}</p>
        : <p className="text-[#6B7280]">点击「立即分析」，AI 将检查当前工艺状态，识别偏差点并给出优化建议。</p>
      }
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  normal: "#22C55E", warn: "#F59E0B", alarm: "#EF4444", offline: "#6B7280",
};
```

---

## 二十三、HealthScoreCard — 设备健康评分卡

```typescript
// src/components/intelligence/HealthScoreCard.tsx
import { useMemo } from "react";

interface ScoreDimension {
  key: string;
  label: string;
  score: number;          // 0-100
  trend: "up" | "down" | "flat";
  delta: number;
  status_text: string;
}

interface HealthScoreCardProps {
  equipment_id: string;
  overall_score: number;
  overall_trend: "up" | "down" | "flat";
  overall_delta: number;
  dimensions: ScoreDimension[];
  ai_summary: string;
  ai_confidence: number;
  onBuildWorkOrder?: () => void;
  onViewHistory?: () => void;
}

const STATUS_FROM_SCORE = (s: number) =>
  s >= 85 ? "normal" : s >= 65 ? "warn" : s >= 45 ? "critical" : "alarm";

const STATUS_COLORS: Record<string, string> = {
  normal:   "#22C55E",
  warn:     "#F59E0B",
  critical: "#F97316",
  alarm:    "#EF4444",
};

const TREND_ICON = { up: "↑", down: "↓", flat: "→" };
const TREND_COLOR = { up: "#22C55E", down: "#EF4444", flat: "#8B949E" };

export function HealthScoreCard({
  overall_score, overall_trend, overall_delta,
  dimensions, ai_summary, ai_confidence,
  onBuildWorkOrder, onViewHistory,
}: HealthScoreCardProps) {
  const status = STATUS_FROM_SCORE(overall_score);
  const color = STATUS_COLORS[status];
  const statusLabel = { normal: "良好", warn: "需关注", critical: "较差", alarm: "危险" }[status];

  return (
    <div className="rounded-lg border border-[#30363D] bg-[#161B22] overflow-hidden text-xs">
      {/* 总分标题区 */}
      <div className="flex items-center gap-3 p-3 border-b border-[#21262D]">
        <div className="flex flex-col items-center min-w-[56px]">
          <span className="text-2xl font-bold" style={{ color }}>{overall_score}</span>
          <div className="w-full h-1.5 bg-[#21262D] rounded-full mt-1">
            <div className="h-full rounded-full transition-all" style={{ width: `${overall_score}%`, backgroundColor: color }} />
          </div>
        </div>
        <div className="flex-1">
          <div className="font-medium text-[#E6EDF3]">健康评分</div>
          <div className="text-[#8B949E]">
            {statusLabel}
            <span style={{ color: TREND_COLOR[overall_trend] }} className="ml-2">
              {TREND_ICON[overall_trend]} {overall_delta > 0 ? "+" : ""}{overall_delta} 周环比
            </span>
          </div>
        </div>
      </div>

      {/* 分维度评分 */}
      <div className="grid grid-cols-2 gap-px bg-[#21262D]">
        {dimensions.map(dim => (
          <div key={dim.key} className="bg-[#161B22] p-2">
            <div className="flex justify-between items-baseline">
              <span className="text-[#8B949E]">{dim.label}</span>
              <span style={{ color: STATUS_COLORS[STATUS_FROM_SCORE(dim.score)] }}
                className="font-mono font-medium">{dim.score}</span>
            </div>
            {/* 进度条 */}
            <div className="w-full h-1 bg-[#21262D] rounded-full mt-1">
              <div className="h-full rounded-full transition-all"
                style={{
                  width: `${dim.score}%`,
                  backgroundColor: STATUS_COLORS[STATUS_FROM_SCORE(dim.score)]
                }} />
            </div>
            <div className="text-[#6B7280] mt-0.5 truncate">{dim.status_text}</div>
          </div>
        ))}
      </div>

      {/* AI 综合分析 */}
      <div className="p-2 border-t border-[#21262D]">
        <div className="flex items-center gap-1 text-[#8B5CF6] mb-1">
          <span>🤖 AI 分析</span>
          <ConfidenceBadge confidence={ai_confidence} />
        </div>
        <p className="text-[#C9D1D9] leading-relaxed">{ai_summary}</p>
      </div>

      {/* 操作按钮 */}
      <div className="flex gap-2 p-2 border-t border-[#21262D]">
        <button onClick={onViewHistory}
          className="flex-1 py-1 rounded text-[#8B949E] hover:text-[#E6EDF3] hover:bg-[#21262D]">
          历史评分曲线
        </button>
        {overall_score < 75 && (
          <button onClick={onBuildWorkOrder}
            className="flex-1 py-1 rounded bg-[#1F6FEB]/20 text-[#58A6FF] hover:bg-[#1F6FEB]/30">
            建预防性工单
          </button>
        )}
      </div>
    </div>
  );
}

// 置信度标签组件
function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color = pct >= 85 ? "#22C55E" : pct >= 65 ? "#F59E0B" : "#EF4444";
  return (
    <span className="ml-auto text-[10px] px-1 py-0.5 rounded"
      style={{ color, background: `${color}20` }}>
      {pct}%
    </span>
  );
}
```

---

## 二十四、VisualInspectionPanel — 视觉巡检面板

集成在 `DeviceIntelPanel` 中（作为可展开的 Tab）：

```typescript
// src/components/intelligence/VisualInspectionPanel.tsx
import { useState, useCallback } from "react";
import { api } from "@/lib/api";

interface InspectionFinding {
  item: string;
  status: "ok" | "attention" | "warning" | "critical";
  confidence: number;
  detail: string;
}

interface InspectionRecord {
  captured_at: string;
  ai_summary: string;
  confidence: number;
  severity: string;
  findings: InspectionFinding[];
  image_url?: string;
}

const FINDING_ICONS: Record<string, string> = {
  ok:        "✅",
  attention: "⚠️",
  warning:   "🟠",
  critical:  "🔴",
};

const SEVERITY_COLORS: Record<string, string> = {
  normal:   "#22C55E",
  attention:"#F59E0B",
  warning:  "#F97316",
  critical: "#EF4444",
};

export function VisualInspectionPanel({ equipmentId }: { equipmentId: string }) {
  const [latest, setLatest] = useState<InspectionRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const runInspection = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.post("/v1/visual/inspect", { equipment_id: equipmentId });
      setLatest(res.data);
      setShowDetails(true);
    } finally {
      setLoading(false);
    }
  }, [equipmentId]);

  return (
    <div className="text-xs border border-[#30363D] rounded-lg overflow-hidden">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#161B22] border-b border-[#21262D]">
        <span className="text-[#8B949E]">📷 视觉巡检</span>
        <button
          onClick={runInspection}
          disabled={loading}
          className="text-[#1F6FEB] hover:text-[#58A6FF] disabled:opacity-40"
        >
          {loading ? "分析中..." : "立即分析"}
        </button>
      </div>

      {latest ? (
        <div className="bg-[#0D1117]">
          {/* 总体结论 */}
          <div className="flex items-center gap-2 px-3 py-2">
            <span style={{ color: SEVERITY_COLORS[latest.severity] }}>
              {latest.severity === "normal" ? "✅" : "⚠️"} {latest.ai_summary}
            </span>
            <ConfBadge v={latest.confidence} />
          </div>

          {/* 更新时间 */}
          <div className="px-3 pb-1 text-[#6B7280]">
            {new Date(latest.captured_at).toLocaleString("zh-CN")}
          </div>

          {/* 展开/收起详情 */}
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="w-full px-3 py-1 text-[#8B949E] hover:bg-[#21262D] text-left"
          >
            {showDetails ? "▲ 收起" : "▼ 查看详情"}
          </button>

          {showDetails && (
            <div className="divide-y divide-[#21262D]">
              {latest.findings.map((f, i) => (
                <div key={i} className="flex items-start gap-2 px-3 py-2">
                  <span>{FINDING_ICONS[f.status]}</span>
                  <div className="flex-1">
                    <div className="text-[#E6EDF3]">{f.item}</div>
                    {f.detail && <div className="text-[#8B949E]">{f.detail}</div>}
                  </div>
                  <ConfBadge v={f.confidence} />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="px-3 py-4 text-[#6B7280] text-center bg-[#0D1117]">
          点击「立即分析」触发 AI 视觉巡检
        </div>
      )}
    </div>
  );
}

function ConfBadge({ v }: { v: number }) {
  const pct = Math.round(v * 100);
  const c = pct >= 85 ? "#22C55E" : pct >= 65 ? "#F59E0B" : "#EF4444";
  return (
    <span className="text-[9px] px-1 rounded shrink-0"
      style={{ color: c, background: `${c}20` }}>{pct}%</span>
  );
}
```

### 24.1 将 VisualInspectionPanel 接入 DeviceIntelPanel

在 `DeviceIntelPanel.tsx` 的 `WorkOrderDraftInline` 之后追加：

```typescript
// 在 DeviceIntelPanel.tsx 中的设备详情区添加视觉巡检（Phase C 功能，Phase A 可 hide）
{PHASE_C_FEATURES_ENABLED && (
  <VisualInspectionPanel equipmentId={selectedEquipmentId} />
)}

// src/config/features.ts（功能开关，Phase A 设 false，Phase B/C 渐进开启）
export const PHASE_C_FEATURES_ENABLED =
  import.meta.env.VITE_ENABLE_VISUAL_INSPECTION === "true";
```

---

## 二十五、AlarmManager — 告警管理（ISA-18.2 对标）

> 告警疲劳是工业系统的头号用户体验杀手。按 ISA-18.2 标准设计。

### 25.1 告警分级与显示规范

```typescript
// src/components/alerts/AlarmManager.tsx
// 实现 ISA-18.2 告警分级管理

export type AlarmPriority = "P1" | "P2" | "P3" | "P4";
export type AlarmState = "active" | "acknowledged" | "shelved" | "suppressed";

export interface Alarm {
  id: string;
  equipment_id: string;
  tag: string; // "C-001-VIB-HIGH"
  priority: AlarmPriority;
  state: AlarmState;
  message: string;
  first_occurred: string; // ISO datetime
  occurrence_count: number; // 重复次数（去重合并）
  shelved_until?: string; // 搁置到何时
  ack_by?: string; // 已确认人
  ack_at?: string;
}

// P1: 立即响应（< 5 min）—— 飞书推送 + Studio 全屏弹窗
// P2: 快速响应（< 30 min）—— 飞书推送 + Studio 右侧告警队列
// P3: 计划响应（< 2h）—— Studio 右侧队列 + 晨报汇总
// P4: 信息提示（值班结束前处理）—— Studio 状态栏 + 晨报

const PRIORITY_STYLE: Record<
  AlarmPriority,
  { color: string; label: string; maxResponseMin: number }
> = {
  P1: { color: "#EF4444", label: "紧急", maxResponseMin: 5 },
  P2: { color: "#F97316", label: "高优先", maxResponseMin: 30 },
  P3: { color: "#F59E0B", label: "中优先", maxResponseMin: 120 },
  P4: { color: "#3B82F6", label: "低优先", maxResponseMin: 480 },
};
```

### 25.2 告警抑制与去重（防告警风暴）

```typescript
// src/lib/alarmDeduplication.ts
// ISA-18.2 要求：重复告警必须合并，不得向操作员呈现告警洪流

export function deduplicateAlarms(alarms: Alarm[]): Alarm[] {
  const grouped = new Map<string, Alarm>();

  for (const alarm of alarms) {
    // 去重 key：设备 + 告警类型（忽略值）
    const key = `${alarm.equipment_id}:${alarm.tag.replace(/-\d+$/, "")}`;
    const existing = grouped.get(key);

    if (existing) {
      // 合并：保留最高优先级，叠加计数
      const highPrio = existing.priority < alarm.priority ? existing.priority : alarm.priority;
      grouped.set(key, {
        ...existing,
        priority: highPrio,
        occurrence_count: existing.occurrence_count + 1,
        // 更新时间为最新
        first_occurred: existing.first_occurred,
      });
    } else {
      grouped.set(key, { ...alarm });
    }
  }

  return Array.from(grouped.values()).sort((a, b) => {
    // 排序：P1 > P2 > P3 > P4，同级按时间
    const priOrder = ["P1", "P2", "P3", "P4"];
    return priOrder.indexOf(a.priority) - priOrder.indexOf(b.priority);
  });
}

// 告警搁置（Shelve）：操作员可以临时搁置已知的、正在处理的告警
// 防止同一告警反复打扰操作员
export async function shelveAlarm(alarmId: string, durationMinutes: number) {
  return api.post(`/v1/alarms/${alarmId}/shelve`, { duration_minutes: durationMinutes });
}
```

### 25.3 告警队列 UI（左侧 NavRail 告警区）

```typescript
// src/components/alerts/AlarmQueuePanel.tsx（简化版，集成在 NavRail 中）

export function AlarmQueuePanel({ alarms }: { alarms: Alarm[] }) {
  const deduped = deduplicateAlarms(alarms.filter(a => a.state === "active"));
  const p1Count = deduped.filter(a => a.priority === "P1").length;

  return (
    <div className="text-xs">
      {/* 汇总头 */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-[#21262D]">
        <span className="text-[#8B949E]">活动告警</span>
        <div className="flex gap-1">
          {p1Count > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-[#EF4444]/20 text-[#EF4444] font-medium">
              P1×{p1Count}
            </span>
          )}
          <span className="text-[#6B7280]">{deduped.length} 条</span>
        </div>
      </div>

      {/* 告警列表（最多显示 10 条，超出折叠） */}
      <div className="divide-y divide-[#21262D] max-h-64 overflow-y-auto">
        {deduped.slice(0, 10).map(alarm => (
          <AlarmRow key={alarm.id} alarm={alarm} />
        ))}
        {deduped.length > 10 && (
          <div className="px-3 py-2 text-[#6B7280] text-center">
            还有 {deduped.length - 10} 条...
          </div>
        )}
      </div>
    </div>
  );
}

function AlarmRow({ alarm }: { alarm: Alarm }) {
  const style = PRIORITY_STYLE[alarm.priority];
  const elapsed = Math.round((Date.now() - new Date(alarm.first_occurred).getTime()) / 60000);

  return (
    <div className="flex items-start gap-2 px-3 py-2 hover:bg-[#21262D] cursor-pointer">
      <span style={{ color: style.color }} className="font-bold shrink-0">{alarm.priority}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[#E6EDF3] truncate">{alarm.message}</div>
        <div className="text-[#6B7280]">
          {alarm.equipment_id} · {elapsed} 分钟前
          {alarm.occurrence_count > 1 && (
            <span className="ml-1 text-[#F59E0B]">×{alarm.occurrence_count}</span>
          )}
        </div>
      </div>
      {/* 搁置按钮 */}
      <button
        onClick={e => { e.stopPropagation(); shelveAlarm(alarm.id, 30); }}
        className="text-[#6B7280] hover:text-[#F59E0B] shrink-0"
        title="搁置 30 分钟"
      >⏸</button>
    </div>
  );
}
```

---

## 二十六、路由更新（添加 P&ID 视图）

```typescript
// src/App.tsx 路由增加 P&ID 视图

// 在 /studio/twin 的同级添加：
<Route path="/studio/pid" element={
  <RequireAuth>
    <StudioShell activeView="pid">
      <PIDView />
    </StudioShell>
  </RequireAuth>
} />

// StudioShell 导航栏 Tab 更新（中央视图选项卡）
// 在 twin.store.ts 的 CenterView 类型中追加 "pid"：
export type CenterView = "twin" | "graph" | "trend" | "kanban" | "pid";
```

---

_模块设计文档版本 2.1，2026-05-09。_  
_新增：P&ID 视图（§22）、健康评分卡（§23）、视觉巡检面板（§24）、ISA-18.2 告警管理（§25）、路由更新（§26）。_

---

## 二十七、DeviceIntelPanel 决策优化重构（整合版）

> 将所有分散的组件整合为一个决策驱动的情报面板。  
> 设计原则：一眼知状态 → 一键知原因 → 一键执行行动

### 27.1 重构后的完整 DeviceIntelPanel.tsx

```typescript
// src/components/intelligence/DeviceIntelPanel.tsx（V2 重构版）
// 核心变化：
//   1. 置顶"AI 下一步建议"（One Big Action）
//   2. 倒计时预测（UrgencyCountdown）
//   3. 折叠式详情（默认收起，减少视觉噪音）
//   4. 频谱图（SpectrogramView）按需展开
//   5. 健康评分卡置于实时指标之后

import { useState, useCallback } from "react";
import { useTwinStore } from "@/stores/twin.store";
import { useEquipmentIntel } from "@/hooks/useEquipmentIntel";
import { useEquipmentDetail } from "@/hooks/useEquipmentDetail";
import AIInsightCard from "./AIInsightCard";
import { HealthScoreCard } from "./HealthScoreCard";
import { VisualInspectionPanel } from "./VisualInspectionPanel";
import { UrgencyCountdown } from "./UrgencyCountdown";
import { SpectrogramView } from "./SpectrogramView";
import WorkOrderDraftInline from "./WorkOrderDraftInline";
import { MetricBar } from "@/components/industrial/MetricBar";
import { api } from "@/lib/api";

type PanelTab = "intel" | "draft_wo" | "history";

interface PrimaryAction {
  label: string;
  icon: string;
  color: "blue" | "orange" | "red" | "green";
  reason: string;
  action_type: "create_wo" | "notify" | "inspect" | "schedule";
  urgent: boolean;
}

export default function DeviceIntelPanel({ equipmentId }: { equipmentId: string }) {
  const [tab, setTab] = useState<PanelTab>("intel");
  const [metricsExpanded, setMetricsExpanded] = useState(false);
  const [showSpectrum, setShowSpectrum] = useState(false);
  const [isExecutingAction, setIsExecutingAction] = useState(false);

  const { equipmentList } = useTwinStore();
  const equipment = equipmentList.find(e => e.equipment_id === equipmentId);
  const { aiInsight, isLoadingAI, primaryAction, urgencyMinutes, healthScore } =
    useEquipmentIntel(equipmentId);
  const { recentWorkOrders } = useEquipmentDetail(equipmentId);

  if (!equipment) return null;

  const hasVibrationMetric = Object.keys(equipment.realtime ?? {})
    .some(k => k.toLowerCase().includes("vib") || k.toLowerCase().includes("vibrat"));

  async function handlePrimaryAction() {
    if (!primaryAction) return;
    setIsExecutingAction(true);
    try {
      if (primaryAction.action_type === "create_wo") {
        setTab("draft_wo");
      } else if (primaryAction.action_type === "notify") {
        await api.post("/v1/notifications/notify-operator", { equipment_id: equipmentId });
      }
    } finally {
      setIsExecutingAction(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-[#161B22] overflow-hidden">

      {/* ── 顶部：设备标题（固定，不滚动） ─────────────────────────── */}
      <header className="shrink-0 px-4 py-3 border-b border-[#21262D] flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <StatusDot status={equipment.status} />
            <h2 className="text-sm font-semibold text-[#E6EDF3] leading-none">
              {equipment.name}
            </h2>
          </div>
          <p className="text-[11px] text-[#6B7280] mt-0.5">{equipment.equipment_id}</p>
        </div>
        <div className="flex gap-2 text-[11px] text-[#1F6FEB] mt-0.5">
          <button className="hover:underline">定位</button>
          <span className="text-[#30363D]">·</span>
          <button className="hover:underline">P&ID</button>
          <span className="text-[#30363D]">·</span>
          <button className="hover:underline">历史</button>
        </div>
      </header>

      {/* ── 可滚动区域 ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-[#30363D]">

        {tab === "intel" && (
          <div className="space-y-0 divide-y divide-[#21262D]">

            {/* 1. 倒计时预测（有预测超限时才显示，放最顶部） */}
            {urgencyMinutes !== null && urgencyMinutes < 24 * 60 && (
              <div className="px-4 py-3">
                <UrgencyCountdown
                  predicted_breach_minutes={urgencyMinutes}
                  threshold_label={`${equipment.name} 关键指标超限`}
                  confidence={aiInsight?.confidence ?? 0.7}
                />
              </div>
            )}

            {/* 2. One Big Action（AI 推荐的唯一主行动） */}
            {primaryAction && (
              <div className="px-4 py-3">
                <PrimaryActionSection
                  action={primaryAction}
                  isLoading={isExecutingAction}
                  onExecute={handlePrimaryAction}
                  onCreateWO={() => setTab("draft_wo")}
                  onNotify={() => api.post("/v1/notifications/notify-operator",
                    { equipment_id: equipmentId })}
                />
              </div>
            )}

            {/* 3. AI 情报解读 */}
            <div className="px-4 py-3">
              <AIInsightCard
                equipmentId={equipmentId}
                insight={aiInsight}
                isLoading={isLoadingAI}
              />
            </div>

            {/* 4. 实时指标（可折叠） */}
            <div className="px-4 py-2">
              <button
                onClick={() => setMetricsExpanded(!metricsExpanded)}
                className="w-full flex items-center justify-between text-xs text-[#8B949E] hover:text-[#E6EDF3] py-1"
              >
                <span className="uppercase tracking-wide font-medium">实时指标</span>
                <span>{metricsExpanded ? "▲ 收起" : "▼ 展开"}</span>
              </button>
              {metricsExpanded && (
                <div className="mt-2 space-y-2">
                  {Object.entries(equipment.realtime ?? {}).map(([key, val]) => (
                    <MetricBar
                      key={key}
                      label={key}
                      value={val.value}
                      unit={val.unit}
                      warnThreshold={equipment.thresholds?.[key]?.warn}
                      alarmThreshold={equipment.thresholds?.[key]?.alarm}
                      updatedAt={val.timestamp}
                    />
                  ))}
                </div>
              )}
              {/* 收起状态只显示最关键的 2 个指标 */}
              {!metricsExpanded && (
                <div className="mt-1 space-y-1">
                  {Object.entries(equipment.realtime ?? {}).slice(0, 2).map(([key, val]) => (
                    <MetricBar
                      key={key}
                      label={key}
                      value={val.value}
                      unit={val.unit}
                      warnThreshold={equipment.thresholds?.[key]?.warn}
                      alarmThreshold={equipment.thresholds?.[key]?.alarm}
                      updatedAt={val.timestamp}
                      compact
                    />
                  ))}
                </div>
              )}
            </div>

            {/* 5. 健康评分卡 */}
            {healthScore && (
              <div className="px-4 py-3">
                <HealthScoreCard
                  {...healthScore}
                  onBuildWorkOrder={() => setTab("draft_wo")}
                  onViewHistory={() => setTab("history")}
                />
              </div>
            )}

            {/* 6. 振动频谱（有振动指标时才显示展开按钮） */}
            {hasVibrationMetric && (
              <div className="px-4 py-2">
                <button
                  onClick={() => setShowSpectrum(!showSpectrum)}
                  className="w-full flex items-center justify-between text-xs text-[#8B949E] hover:text-[#E6EDF3] py-1"
                >
                  <span className="uppercase tracking-wide font-medium">📊 振动频谱分析</span>
                  <span>{showSpectrum ? "▲ 收起" : "▼ 展开"}</span>
                </button>
                {showSpectrum && (
                  <div className="mt-2">
                    <SpectrogramView equipmentId={equipmentId} />
                  </div>
                )}
              </div>
            )}

            {/* 7. 视觉巡检（Phase C，feature flag 控制） */}
            {import.meta.env.VITE_ENABLE_VISUAL_INSPECTION === "true" && (
              <div className="px-4 py-3">
                <VisualInspectionPanel equipmentId={equipmentId} />
              </div>
            )}

            {/* 8. 最近工单（折叠，3 条） */}
            <div className="px-4 py-3">
              <h3 className="text-xs font-medium text-[#8B949E] uppercase tracking-wide mb-2">
                最近工单
              </h3>
              {recentWorkOrders?.slice(0, 3).map(wo => (
                <WorkOrderRow key={wo.wo_id} wo={wo} />
              ))}
              {(!recentWorkOrders || recentWorkOrders.length === 0) && (
                <p className="text-xs text-[#6B7280]">暂无历史工单</p>
              )}
            </div>

          </div>
        )}

        {tab === "draft_wo" && (
          <WorkOrderDraftInline
            equipmentId={equipmentId}
            onBack={() => setTab("intel")}
            onSubmitted={() => setTab("intel")}
          />
        )}

        {tab === "history" && (
          <EquipmentHistoryTab equipmentId={equipmentId} />
        )}
      </div>

      {/* ── 底部快捷栏（次要行动） ──────────────────────────────────── */}
      <footer className="shrink-0 border-t border-[#21262D] px-4 py-2 flex gap-2">
        <SecondaryButton onClick={() => setTab("draft_wo")} disabled={tab === "draft_wo"}>
          ＋ 建工单
        </SecondaryButton>
        <SecondaryButton onClick={() => {}}>
          📣 通知
        </SecondaryButton>
        <SecondaryButton onClick={() => setTab("history")} disabled={tab === "history"}>
          📋 历史
        </SecondaryButton>
      </footer>
    </div>
  );
}

/* ── 主行动区（One Big Action）────────────────────────────────────── */
interface PrimaryActionSectionProps {
  action: PrimaryAction;
  isLoading: boolean;
  onExecute: () => void;
  onCreateWO: () => void;
  onNotify: () => void;
}

function PrimaryActionSection({ action, isLoading, onExecute }: PrimaryActionSectionProps) {
  const COLOR_MAP = {
    red:    { bg: "bg-[#EF4444]",         text: "text-white",      ring: "ring-[#EF4444]/40" },
    orange: { bg: "bg-[#F97316]",         text: "text-white",      ring: "ring-[#F97316]/40" },
    blue:   { bg: "bg-[#1F6FEB]",         text: "text-white",      ring: "ring-[#1F6FEB]/40" },
    green:  { bg: "bg-[#22C55E]",         text: "text-white",      ring: "ring-[#22C55E]/40" },
  };
  const style = COLOR_MAP[action.color];

  return (
    <div>
      <p className="text-[10px] text-[#8B949E] uppercase tracking-wider mb-1.5">
        AI 推荐行动
      </p>
      {/* 大按钮 */}
      <button
        onClick={onExecute}
        disabled={isLoading}
        className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-medium text-sm
          ${style.bg} ${style.text} ring-2 ${style.ring}
          transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-50`}
      >
        <span className="text-lg shrink-0">{action.icon}</span>
        <span className="flex-1 text-left">{action.label}</span>
        {isLoading && <span className="text-xs opacity-70">执行中…</span>}
      </button>
      {/* AI 依据（1-2 句） */}
      <p className="text-[11px] text-[#8B949E] mt-1.5 leading-relaxed">
        {action.reason}
      </p>
    </div>
  );
}

/* ── 工单行（紧凑） ───────────────────────────────────────────────── */
function WorkOrderRow({ wo }: { wo: any }) {
  // ⚠️ 与 Platform 状态枚举保持一致（见 MODULE-DESIGN-PLATFORM.md §18.6）
  // 从 src/types/workorder.ts 导入 WO_STATE_LABELS / WO_STATE_COLORS 复用
  const STATE_LABELS: Record<string, string> = {
    draft:            "草稿",
    pending_approval: "待审批",
    approved:         "已批准",
    in_progress:      "执行中",
    done:             "已完成",
    rejected:         "已驳回",
  };
  const STATE_COLOR: Record<string, string> = {
    draft:            "text-[#8B949E]",
    pending_approval: "text-[#8B5CF6]",
    approved:         "text-[#22C55E]",
    in_progress:      "text-[#1F6FEB]",
    done:             "text-[#6B7280]",
    rejected:         "text-[#EF4444]",
  };
  return (
    <div className="flex items-start gap-2 py-1.5 text-xs">
      <span className={`shrink-0 ${STATE_COLOR[wo.state] ?? "text-[#8B949E]"}`}>
        {STATE_LABELS[wo.state] ?? wo.state}
      </span>
      <span className="flex-1 text-[#C9D1D9] truncate">{wo.title}</span>
      <span className="shrink-0 text-[#6B7280]">{wo.wo_id}</span>
    </div>
  );
}

/* ── 小工具 ───────────────────────────────────────────────────────── */
function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    normal: "bg-[#22C55E]", warn: "bg-[#F59E0B] animate-pulse",
    alarm: "bg-[#EF4444] animate-ping", offline: "bg-[#6B7280]",
  };
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[status] ?? "bg-[#6B7280]"}`} />;
}

function SecondaryButton({ children, onClick, disabled }: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex-1 py-1.5 text-xs rounded text-[#8B949E] border border-[#30363D]
        hover:text-[#E6EDF3] hover:border-[#8B949E] disabled:opacity-30 transition-colors"
    >
      {children}
    </button>
  );
}

/* ── 历史 Tab（占位） ─────────────────────────────────────────────── */
function EquipmentHistoryTab({ equipmentId }: { equipmentId: string }) {
  return (
    <div className="p-4 text-xs text-[#8B949E]">
      设备 {equipmentId} 的完整运维历史（工单/告警/指标）将在 M4 实现。
    </div>
  );
}
```

---

## 二十八、useEquipmentIntel Hook 扩展版（包含 primaryAction）

```typescript
// src/hooks/useEquipmentIntel.ts（V2，新增 primaryAction + urgencyMinutes + healthScore）
import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";

export interface AIInsight {
  summary: string;
  confidence: number;
  citations: Array<{ label: string; link?: string }>;
}

export interface PrimaryAction {
  label: string;
  icon: string;
  color: "blue" | "orange" | "red" | "green";
  reason: string;
  action_type: "create_wo" | "notify" | "inspect" | "schedule";
  urgent: boolean;
}

export interface HealthScoreData {
  equipment_id: string;
  overall_score: number;
  overall_trend: "up" | "down" | "flat";
  overall_delta: number;
  dimensions: Array<{
    key: string;
    label: string;
    score: number;
    trend: "up" | "down" | "flat";
    delta: number;
    status_text: string;
  }>;
  ai_summary: string;
  ai_confidence: number;
}

export function useEquipmentIntel(equipmentId: string | null) {
  const [aiInsight, setAiInsight] = useState<AIInsight | null>(null);
  const [primaryAction, setPrimaryAction] = useState<PrimaryAction | null>(null);
  const [urgencyMinutes, setUrgencyMinutes] = useState<number | null>(null);
  const [healthScore, setHealthScore] = useState<HealthScoreData | null>(null);
  const [isLoadingAI, setIsLoadingAI] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!equipmentId) {
      setAiInsight(null);
      setPrimaryAction(null);
      setUrgencyMinutes(null);
      setHealthScore(null);
      return;
    }

    // 取消前一次请求
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setIsLoadingAI(true);
    setAiInsight(null);
    setPrimaryAction(null);

    // 并发请求：AI 诊断 + 健康评分
    Promise.all([
      api.post(
        "/v1/tools/diagnose_equipment",
        { equipment_id: equipmentId },
        { signal: abortRef.current.signal },
      ),
      api
        .get(`/v1/equipment/${equipmentId}/health-score`, { signal: abortRef.current.signal })
        .catch(() => null), // 健康评分失败不影响主流程
    ])
      .then(([diagRes, healthRes]) => {
        const diag = diagRes.data;

        setAiInsight({
          summary: diag.summary,
          confidence: diag.confidence,
          citations: diag.citations ?? [],
        });

        // 解析主行动（Platform 返回）
        if (diag.primary_action) {
          setPrimaryAction(diag.primary_action);
        }

        // 解析超限倒计时
        if (diag.predicted_breach_minutes !== undefined) {
          setUrgencyMinutes(diag.predicted_breach_minutes);
        }

        if (healthRes?.data) {
          setHealthScore(healthRes.data);
        }
      })
      .catch((err) => {
        if (err.name !== "CanceledError") console.error(err);
      })
      .finally(() => {
        setIsLoadingAI(false);
      });

    return () => abortRef.current?.abort();
  }, [equipmentId]);

  return { aiInsight, primaryAction, urgencyMinutes, healthScore, isLoadingAI };
}
```

---

## 二十九、NavRail 重构版（添加站场热力图 + 班次快捷区）

```typescript
// src/components/layout/NavRail.tsx（V2 重构版）
import { useState } from "react";
import { useTwinStore } from "@/stores/twin.store";
import { AlarmQueuePanel } from "@/components/alerts/AlarmQueuePanel";
import { StationHeatmap } from "./StationHeatmap";
import { useAlarms } from "@/hooks/useAlarms";

type NavSection = "heatmap" | "equipment" | "alarms" | "workorders";

export default function NavRail({ className }: { className?: string }) {
  const [activeSection, setActiveSection] = useState<NavSection>("equipment");
  const {
    equipmentList, selectedEquipmentId, setSelectedEquipmentId,
    selectedStationId
  } = useTwinStore();
  const { activeAlarms, areaStatuses } = useAlarms(selectedStationId);

  // 告警数统计
  const p1Count = activeAlarms.filter(a => a.priority === "P1").length;
  const totalAlarms = activeAlarms.length;

  return (
    <nav className={`flex flex-col bg-[#0D1117] border-r border-[#21262D] text-xs ${className}`}>

      {/* ── 顶部：场站热力图（始终可见，高度固定） ──── */}
      <div className="shrink-0 border-b border-[#21262D] py-2">
        <div className="px-3 text-[10px] text-[#6B7280] uppercase tracking-wider mb-1">
          场站健康总览
        </div>
        <StationHeatmap
          areas={areaStatuses}
          onAreaClick={areaName => {
            /* 过滤设备列表到该区域 */
            setActiveSection("equipment");
          }}
        />
      </div>

      {/* ── 导航 Tab ────────────────────────────────── */}
      <div className="shrink-0 flex border-b border-[#21262D]">
        {([
          { key: "equipment", label: "设备", badge: null },
          { key: "alarms",    label: "告警", badge: totalAlarms > 0 ? totalAlarms : null },
          { key: "workorders",label: "工单", badge: null },
        ] as Array<{ key: NavSection; label: string; badge: number | null }>).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveSection(tab.key)}
            className={`flex-1 py-2 relative transition-colors ${
              activeSection === tab.key
                ? "text-[#E6EDF3] border-b-2 border-[#1F6FEB]"
                : "text-[#8B949E] hover:text-[#E6EDF3]"
            }`}
          >
            {tab.label}
            {tab.badge !== null && (
              <span className={`absolute top-1 right-1 text-[9px] px-1 rounded-full
                ${p1Count > 0 ? "bg-[#EF4444]" : "bg-[#F59E0B]"} text-white`}>
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── 内容区（可滚动） ─────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-[#21262D]">

        {activeSection === "equipment" && (
          <EquipmentSection
            equipmentList={equipmentList}
            selectedId={selectedEquipmentId}
            onSelect={setSelectedEquipmentId}
          />
        )}

        {activeSection === "alarms" && (
          <AlarmQueuePanel alarms={activeAlarms} />
        )}

        {activeSection === "workorders" && (
          <WorkOrderSection stationId={selectedStationId} />
        )}
      </div>

      {/* ── 底部：班次交接快捷入口 ──────────────────── */}
      <div className="shrink-0 border-t border-[#21262D] p-2">
        <ShiftHandoverButton />
      </div>
    </nav>
  );
}

/* ── 设备列表区 ─────────────────────────────────────────────────── */
function EquipmentSection({
  equipmentList, selectedId, onSelect
}: {
  equipmentList: any[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "alarm" | "warn" | "normal">("all");

  const filtered = equipmentList
    .filter(e => filter === "all" || e.status === filter)
    .sort((a, b) => {
      const order = { alarm: 0, warn: 1, normal: 2, offline: 3 };
      return (order[a.status as keyof typeof order] ?? 4) -
             (order[b.status as keyof typeof order] ?? 4);
    });

  return (
    <div>
      {/* 过滤 Tab */}
      <div className="sticky top-0 bg-[#0D1117] flex gap-1 px-2 py-1.5 border-b border-[#21262D]">
        {(["all", "alarm", "warn", "normal"] as const).map(f => (
          <button key={f}
            onClick={() => setFilter(f)}
            className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
              filter === f ? "bg-[#21262D] text-[#E6EDF3]" : "text-[#6B7280] hover:text-[#8B949E]"
            }`}>
            {{ all: "全部", alarm: "告警", warn: "警告", normal: "正常" }[f]}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-[#6B7280]">{filtered.length}</span>
      </div>

      {/* 设备列表 */}
      <div className="divide-y divide-[#21262D]">
        {filtered.map(eq => (
          <EquipmentRow
            key={eq.equipment_id}
            equipment={eq}
            isSelected={eq.equipment_id === selectedId}
            onClick={() => onSelect(eq.equipment_id)}
          />
        ))}
      </div>
    </div>
  );
}

function EquipmentRow({ equipment, isSelected, onClick }: any) {
  const STATUS_DOT: Record<string, string> = {
    alarm: "bg-[#EF4444] animate-pulse", warn: "bg-[#F59E0B]",
    normal: "bg-[#22C55E]", offline: "bg-[#6B7280]",
  };
  return (
    <div
      onClick={onClick}
      className={`px-3 py-2 cursor-pointer flex items-center gap-2 transition-colors ${
        isSelected ? "bg-[#21262D]" : "hover:bg-[#161B22]"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[equipment.status]}`} />
      <div className="flex-1 min-w-0">
        <div className="text-[#E6EDF3] truncate">{equipment.name}</div>
        <div className="text-[#6B7280] text-[10px]">{equipment.equipment_id}</div>
      </div>
      {/* 最关键指标（如振动） */}
      {equipment.key_metric && (
        <div className="text-[10px] font-mono text-right shrink-0"
          style={{ color: equipment.status === "alarm" ? "#EF4444" :
                          equipment.status === "warn"  ? "#F59E0B" : "#8B949E" }}>
          {equipment.key_metric.value}{equipment.key_metric.unit}
        </div>
      )}
    </div>
  );
}

/* ── 工单列表区（简版） ─────────────────────────────────────────── */
function WorkOrderSection({ stationId }: { stationId: string | null }) {
  return (
    <div className="p-2 text-[#8B949E] text-xs">工单列表（M4 实现）</div>
  );
}

/* ── 班次交接按钮 ───────────────────────────────────────────────── */
function ShiftHandoverButton() {
  const [show, setShow] = useState(false);
  return (
    <>
      <button
        onClick={() => setShow(true)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs
          text-[#8B949E] hover:bg-[#21262D] hover:text-[#E6EDF3] transition-colors"
      >
        <span>📋</span>
        <span>班次交接</span>
      </button>
      {/* 交接 Modal（简版，M5 完整实现） */}
      {show && (
        <div className="absolute bottom-12 left-2 w-72 bg-[#161B22] border border-[#30363D]
          rounded-lg shadow-xl z-50 p-3 text-xs">
          <div className="flex justify-between items-center mb-2">
            <span className="font-medium text-[#E6EDF3]">班次交接报告</span>
            <button onClick={() => setShow(false)} className="text-[#8B949E]">✕</button>
          </div>
          <p className="text-[#6B7280]">生成当班摘要并推送给接班人员飞书...</p>
          <button
            onClick={() => { setShow(false); /* TODO: POST /v1/shifts/handover */ }}
            className="mt-2 w-full py-1.5 rounded bg-[#1F6FEB] text-white">
            生成并发送交接报告
          </button>
        </div>
      )}
    </>
  );
}
```

---

## 三十、StudioShell 中央视图 Tab 更新（含 P&ID）

```typescript
// src/components/layout/StudioShell.tsx 中的中央 Tab 部分更新

// CenterView 类型更新（在 twin.store.ts 中）
export type CenterView = "twin" | "graph" | "trend" | "kanban" | "pid";

// Tab 配置
const CENTER_TABS: Array<{ view: CenterView; label: string; icon: string }> = [
  { view: "twin",   label: "孪生",  icon: "🏭" },
  { view: "graph",  label: "关系图", icon: "🕸" },
  { view: "trend",  label: "趋势",  icon: "📈" },
  { view: "kanban", label: "工单",  icon: "📋" },
  { view: "pid",    label: "P&ID",  icon: "📐" },
];

// Tab 渲染（替换 StudioShell 中的 CenterPanel 头部）
function CenterTabBar({ activeView, onChange }: {
  activeView: CenterView;
  onChange: (v: CenterView) => void;
}) {
  return (
    <div className="flex items-center border-b border-[#21262D] bg-[#0D1117] px-4">
      {CENTER_TABS.map(tab => (
        <button
          key={tab.view}
          onClick={() => onChange(tab.view)}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs transition-colors border-b-2 ${
            activeView === tab.view
              ? "border-[#1F6FEB] text-[#E6EDF3]"
              : "border-transparent text-[#8B949E] hover:text-[#E6EDF3]"
          }`}
        >
          <span>{tab.icon}</span>
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
```

---

## 三十一、Platform API 新增端点（决策效率支撑）

```python
# routers/diagnosis.py - diagnose_equipment 返回体扩展（新增 primary_action）

class DiagnosisResult(BaseModel):
    equipment_id: str
    summary: str
    confidence: float
    citations: list[dict]
    primary_action: Optional[dict]           # ← 新增：主行动
    predicted_breach_minutes: Optional[int]  # ← 新增：超限倒计时（分钟）
    data_quality_issues: list[dict] = []


def compute_primary_action(
    equipment_id: str,
    status: str,
    health_score: float,
    urgency_minutes: Optional[int],
    active_alarms: list,
) -> dict:
    """根据设备状态计算 AI 推荐主行动（One Big Action）"""
    p1_alarms = [a for a in active_alarms if a["priority"] == "P1"]

    if p1_alarms:
        return {
            "label": "立即通知现场操作员",
            "icon": "🚨",
            "color": "red",
            "reason": f"P1 告警：{p1_alarms[0]['message']}，需立即响应（< 5 分钟）",
            "action_type": "notify",
            "urgent": True,
        }
    elif urgency_minutes is not None and urgency_minutes < 120:
        return {
            "label": "建紧急预防性工单",
            "icon": "⚠️",
            "color": "orange",
            "reason": f"预计 {urgency_minutes // 60}h{urgency_minutes % 60}m 后超限，建议立即安排检查",
            "action_type": "create_wo",
            "urgent": True,
        }
    elif health_score < 65:
        return {
            "label": "建预防性维保工单",
            "icon": "🔧",
            "color": "blue",
            "reason": f"健康评分 {health_score}，建议近期安排预防性维保",
            "action_type": "create_wo",
            "urgent": False,
        }
    else:
        return None   # 健康状态好时不显示主行动


# routers/equipment.py - 新增频谱端点
@router.get("/{equipment_id}/spectrum")
async def get_vibration_spectrum(
    equipment_id: str,
    window: str = "60s",
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    获取振动时序数据的频谱（FFT）分析。

    返回：频率-幅值对 + AI 解读（Qwen2.5-VL 分析频谱图）
    Phase A：基于 mock 振动数据计算
    Phase B：基于真实 OPC-UA 振动数据
    """
    # 1. 获取最近 60s 振动时序
    readings = await get_recent_readings(equipment_id, "vibration", window, db)
    values = [float(r.value) for r in readings]

    if len(values) < 10:
        return {"error": "振动数据不足，无法计算频谱", "spectrum": []}

    # 2. FFT 计算
    import numpy as np
    fft_vals = np.abs(np.fft.rfft(values))
    freqs = np.fft.rfftfreq(len(values), d=1.0/100)   # 假设 100Hz 采样率
    spectrum = [
        {"freq": round(float(f), 2), "amplitude": round(float(a), 4)}
        for f, a in zip(freqs, fft_vals)
    ]

    # 3. AI 解读（调用 Qwen2.5-VL，Phase A 可 skip）
    ai_interpretation = "频谱分析：基频正常，暂未发现特征频率异常。"  # Phase A mock

    return {"spectrum": spectrum, "ai_interpretation": ai_interpretation, "sample_rate_hz": 100}


# routers/shifts.py - 新增班次交接端点
@router.post("/handover")
async def create_shift_handover(
    station_id: str,
    to_user_id: str,
    db: AsyncSession = Depends(get_db),
    current_user = Depends(get_current_user),
):
    """
    生成当班摘要并推送交接报告给接班人飞书。

    内容：
    · 本班处置的告警列表
    · 未完成的工单（Pending/In_Progress）
    · 搁置中的告警（将在接班后解除）
    · AI 预测接班后 8 小时的趋势
    """
    # 1. 收集本班数据
    shift_start = datetime.utcnow() - timedelta(hours=8)
    handled_alarms = await get_alarms_handled_since(station_id, shift_start, db)
    pending_workorders = await get_pending_workorders(station_id, db)
    shelved_alarms = await get_shelved_alarms(station_id, db)

    # 2. 生成摘要（LLM）
    summary = f"本班处理 {len(handled_alarms)} 个告警，{len(pending_workorders)} 个工单待接手"

    # 3. AI 预测接班后趋势（调用 MOIRAI，Phase B 实现）
    predictions = ["C-001 振动趋势稳定，预计班次内无需特别关注"]

    handover = {
        "from_user": current_user.username,
        "to_user_id": to_user_id,
        "station_id": station_id,
        "handled_alarms": len(handled_alarms),
        "pending_items": [f"工单 {wo.wo_id}：{wo.title}" for wo in pending_workorders],
        "shelved_alarms": [a.message for a in shelved_alarms],
        "ai_predictions": predictions,
        "summary": summary,
    }

    # 4. 推送飞书
    to_user = await get_user_by_id(to_user_id, db)
    if to_user and to_user.feishu_open_id:
        await FeishuClient.send_handover_card(to_user.feishu_open_id, handover)

    return handover
```

---

## 三十二、组件文件结构总图（最终版）

```
src/
├── components/
│   ├── layout/
│   │   ├── StudioShell.tsx         # 五区主布局
│   │   ├── NavRail.tsx             # ← V2 重构（热力图+班次交接）
│   │   ├── CenterPanel.tsx         # 中央视图容器（含 Tab）
│   │   ├── IntelPanel.tsx          # 右侧情报面板容器
│   │   ├── TimeLine.tsx            # 底部时间轴
│   │   └── StationHeatmap.tsx      # ← 新增：站场热力图
│   │
│   ├── intelligence/
│   │   ├── DeviceIntelPanel.tsx    # ← V2 重构（One Big Action 整合版）
│   │   ├── AlertQueuePanel.tsx     # 全局告警队列
│   │   ├── AIInsightCard.tsx       # AI 情报卡（citations 可点击）
│   │   ├── HealthScoreCard.tsx     # ← 新增（§23）
│   │   ├── VisualInspectionPanel.tsx # ← 新增（§24，feature flag）
│   │   ├── UrgencyCountdown.tsx    # ← 新增（§20.2 决策倒计时）
│   │   ├── SpectrogramView.tsx     # ← 新增（§20.3 频谱图）
│   │   ├── WorkOrderDraftInline.tsx # 内嵌工单草稿表单
│   │   └── ActionPanel.tsx         # 次要行动按钮区
│   │
│   ├── alerts/
│   │   ├── AlarmManager.tsx        # ISA-18.2 告警管理（§25）
│   │   └── AlarmQueuePanel.tsx     # 告警队列展示
│   │
│   ├── pid/
│   │   ├── EquipmentNode.tsx       # P&ID 设备节点
│   │   └── InstrumentNode.tsx      # P&ID 仪表节点
│   │
│   ├── industrial/
│   │   └── MetricBar.tsx           # 指标进度条（含 compact 模式）
│   │
│   └── shift/
│       └── ShiftHandoverCard.tsx   # 班次交接卡片（§20.5）
│
├── hooks/
│   ├── useEquipmentIntel.ts        # ← V2 扩展（primaryAction + urgency）
│   ├── useEquipmentDetail.ts       # ← 新增（工单/历史）
│   ├── useAlarms.ts                # ← 新增（告警 + 区域状态）
│   └── useWorkOrders.ts            # 工单列表
│
├── pages/
│   ├── studio/
│   │   ├── TwinPage.tsx
│   │   ├── TrendPage.tsx
│   │   ├── KanbanPage.tsx
│   │   ├── PIDView.tsx             # ← 新增（§22）
│   │   └── GraphPage.tsx
│   └── admin/
│       ├── AdminHome.tsx
│       ├── UserPage.tsx
│       ├── KnowledgePage.tsx
│       └── DataQualityPage.tsx     # ← 新增（数据质量 Dashboard）
│
└── stores/
    ├── twin.store.ts               # ← 更新（CenterView 增加 "pid"）
    └── auth.store.ts
```

---

_模块设计文档版本 2.2，2026-05-09。_  
_新增：§27 DeviceIntelPanel V2 决策整合重构（One Big Action + 倒计时 + 健康评分 + 频谱）_  
_新增：§28 useEquipmentIntel V2（primaryAction + urgencyMinutes + healthScore）_  
_新增：§29 NavRail V2（热力图 + 班次交接 + 告警 Tab）_  
_新增：§30 StudioShell Tab 含 P&ID_  
_新增：§31 Platform 新增端点（spectrum / shifts/handover / compute_primary_action）_  
_新增：§32 组件文件结构总图（最终版）_

---

## §33 Admin 后台页面设计（IT 管理员专用，2026-05-09）

> **定位**：ClawTwin Admin 是 sys_admin 角色专用的系统配置后台。  
> 技术上复用 Studio 的路由、UI 组件和 API client，不是独立应用。  
> 视觉风格：极简表格 + 表单，不需要 3D 和图表。

---

### 33.1 Admin 路由结构

```typescript
// src/router.tsx — Admin 路由（仅 sys_admin 可见）
import { AdminGuard } from "@/components/AdminGuard";

const adminRoutes = [
  { path: "/admin",              element: <AdminLayout /> },
  { path: "/admin/users",        element: <AdminUsersPage /> },
  { path: "/admin/stations",     element: <AdminStationsPage /> },
  { path: "/admin/equipment",    element: <AdminEquipmentPage /> },
  { path: "/admin/kb",           element: <AdminKBPage /> },
  { path: "/admin/system",       element: <AdminSystemPage /> },
];

// AdminGuard：不是 sys_admin 则跳转 /403
function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();
  if (user?.role !== "sys_admin") return <Navigate to="/403" replace />;
  return <>{children}</>;
}
```

---

### 33.2 AdminLayout — Admin 导航壳

```typescript
// src/pages/admin/AdminLayout.tsx
export function AdminLayout() {
  const nav = [
    { path: "/admin/users",     icon: <UsersIcon />,   label: "用户管理" },
    { path: "/admin/stations",  icon: <MapPinIcon />,  label: "场站管理" },
    { path: "/admin/equipment", icon: <CpuIcon />,     label: "设备管理" },
    { path: "/admin/kb",        icon: <BookIcon />,    label: "知识库" },
    { path: "/admin/system",    icon: <SettingsIcon />,label: "系统" },
  ];
  return (
    <div className="flex h-screen bg-[#0D1117] text-[#C9D1D9]">
      {/* 左侧导航 */}
      <aside className="w-48 border-r border-[#30363D] flex flex-col py-6 px-3 gap-1">
        <p className="text-xs text-[#8B949E] px-3 mb-4 font-mono">ClawTwin Admin</p>
        {nav.map(item => (
          <NavLink key={item.path} to={item.path}
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-2 rounded text-sm
               ${isActive ? "bg-[#21262D] text-white" : "text-[#8B949E] hover:text-white hover:bg-[#161B22]"}`
            }>
            {item.icon}{item.label}
          </NavLink>
        ))}
        <div className="flex-1" />
        <NavLink to="/studio" className="px-3 py-2 text-xs text-[#8B949E] hover:text-white">
          ← 返回 Studio
        </NavLink>
      </aside>
      {/* 内容区 */}
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

---

### 33.3 AdminUsersPage — 用户管理

```typescript
// src/pages/admin/AdminUsersPage.tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { DataTable } from "@/components/admin/DataTable";
import { UserFormModal } from "@/components/admin/UserFormModal";

interface AdminUser {
  id: string; username: string; role: string;
  station_ids: string[]; is_active: boolean; created_at: string;
}

export function AdminUsersPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);

  const { data } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => apiFetch<AdminUser[]>("/v1/admin/users/?per_page=100"),
  });

  const toggleActive = useMutation({
    mutationFn: (user: AdminUser) =>
      apiFetch(`/v1/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !user.is_active }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin","users"] }),
  });

  const columns = [
    { key: "username",    label: "用户名", render: (u: AdminUser) => (
        <span className="font-mono text-sm">{u.username}</span>
      )},
    { key: "role",        label: "角色",   render: (u: AdminUser) => (
        <RoleBadge role={u.role} />
      )},
    { key: "station_ids", label: "可访问场站", render: (u: AdminUser) => (
        <span className="text-xs text-[#8B949E]">{u.station_ids.join(", ") || "—"}</span>
      )},
    { key: "is_active",   label: "状态",   render: (u: AdminUser) => (
        <button onClick={() => toggleActive.mutate(u)}
          className={`text-xs px-2 py-0.5 rounded ${u.is_active ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
          {u.is_active ? "活跃" : "停用"}
        </button>
      )},
    { key: "actions",     label: "",       render: (u: AdminUser) => (
        <button onClick={() => setEditing(u)} className="text-xs text-blue-400 hover:underline">
          编辑
        </button>
      )},
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">用户管理</h1>
        <button onClick={() => setCreating(true)}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded">
          + 新建用户
        </button>
      </div>
      <DataTable columns={columns} rows={data?.data ?? []} rowKey="id" />
      {(creating || editing) && (
        <UserFormModal
          user={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["admin","users"] }); }}
        />
      )}
    </div>
  );
}

// UserFormModal：创建/编辑用户表单
function UserFormModal({ user, onClose, onSaved }: {
  user: AdminUser | null; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    username: user?.username ?? "",
    password: "",              // 编辑时留空 = 不改密码
    role: user?.role ?? "operator",
    station_ids: user?.station_ids.join(",") ?? "",
  });
  const save = async () => {
    const body: Record<string, unknown> = {
      role: form.role,
      station_ids: form.station_ids.split(",").map(s => s.trim()).filter(Boolean),
    };
    if (!user) { body.username = form.username; body.password = form.password; }
    if (form.password) body.password = form.password;

    await apiFetch(user ? `/v1/admin/users/${user.id}` : "/v1/admin/users/", {
      method: user ? "PATCH" : "POST",
      body: JSON.stringify(body),
    });
    onSaved(); onClose();
  };

  return (
    <Modal onClose={onClose} title={user ? "编辑用户" : "新建用户"}>
      {!user && <FormField label="用户名" value={form.username}
          onChange={v => setForm(f => ({...f, username: v}))} />}
      <FormField label={user ? "新密码（留空不改）" : "密码"}
          type="password" value={form.password}
          onChange={v => setForm(f => ({...f, password: v}))} />
      <FormSelect label="角色" value={form.role}
          options={["operator","supervisor","engineer","sys_admin"]}
          onChange={v => setForm(f => ({...f, role: v}))} />
      <FormField label="场站 ID（逗号分隔）" value={form.station_ids}
          onChange={v => setForm(f => ({...f, station_ids: v}))}
          placeholder="S001,S002" />
      <ModalFooter onCancel={onClose} onConfirm={save} confirmLabel="保存" />
    </Modal>
  );
}
```

---

### 33.4 AdminKBPage — 知识库文档管理

```typescript
// src/pages/admin/AdminKBPage.tsx
export function AdminKBPage() {
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data: docs } = useQuery({
    queryKey: ["admin", "kb"],
    queryFn: () => apiFetch<KBDoc[]>("/v1/admin/kb/documents/?per_page=100"),
  });

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadProgress("上传中...");

    const form = new FormData();
    form.append("file", file);
    form.append("layer", "L1");    // 默认 L1，用户可选
    form.append("doc_type", "manual");

    const res = await fetch("/v1/admin/kb/documents/", {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}` },
      body: form,
    });
    const { data } = await res.json();
    setUploadProgress(`向量化中... task: ${data.task_id}`);

    // 轮询向量化进度
    let done = false;
    while (!done) {
      await new Promise(r => setTimeout(r, 2000));
      const taskRes = await apiFetch<{ status: string }>(`/v1/tools/tasks/${data.task_id}`);
      if (taskRes.data?.status === "done") { done = true; setUploadProgress("✓ 完成"); }
      else if (taskRes.data?.status === "failed") { done = true; setUploadProgress("✗ 失败"); }
    }

    setUploading(false);
    qc.invalidateQueries({ queryKey: ["admin","kb"] });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">知识库管理</h1>
        <label className={`px-3 py-1.5 text-sm rounded cursor-pointer ${uploading ? "bg-gray-600" : "bg-blue-600 hover:bg-blue-500"}`}>
          {uploading ? uploadProgress : "上传文档"}
          <input type="file" accept=".pdf,.docx,.txt" className="hidden"
                 disabled={uploading} onChange={handleUpload} />
        </label>
      </div>

      {/* 文档列表 */}
      <div className="rounded border border-[#30363D] divide-y divide-[#30363D]">
        {(docs?.data ?? []).map(doc => (
          <div key={doc.id} className="flex items-center px-4 py-3 gap-4">
            <span className={`text-xs px-1.5 py-0.5 rounded font-mono
              ${doc.layer==="L0"?"bg-purple-500/20 text-purple-400":
                doc.layer==="L1"?"bg-blue-500/20 text-blue-400":
                doc.layer==="L3"?"bg-green-500/20 text-green-400":"bg-gray-500/20 text-gray-400"}`}>
              {doc.layer}
            </span>
            <span className="flex-1 text-sm truncate">{doc.filename}</span>
            <span className="text-xs text-[#8B949E]">{doc.chunk_count} 块</span>
            <span className="text-xs text-[#8B949E]">{formatTime(doc.created_at, "MM-DD")}</span>
            <button onClick={() => deleteDoc(doc.id)}
              className="text-xs text-red-400 hover:underline">删除</button>
          </div>
        ))}
        {(docs?.data ?? []).length === 0 && (
          <p className="py-8 text-center text-sm text-[#8B949E]">
            暂无文档。上传 PDF/Word 文档开始构建知识库。
          </p>
        )}
      </div>
    </div>
  );
}
```

---

### 33.5 AdminSystemPage — 系统状态与审计

```typescript
// src/pages/admin/AdminSystemPage.tsx
export function AdminSystemPage() {
  const { data: stats } = useQuery({
    queryKey: ["admin","stats"],
    queryFn: () => apiFetch<SystemStats>("/v1/admin/system/stats"),
    refetchInterval: 30_000,
  });
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => apiFetch<HealthCheck>("/health"),
    refetchInterval: 10_000,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-medium">系统状态</h1>

      {/* 健康检查 */}
      <div className="grid grid-cols-4 gap-3">
        {Object.entries(health?.data?.checks ?? {}).map(([k, v]) => (
          <div key={k} className="rounded border border-[#30363D] p-3">
            <p className="text-xs text-[#8B949E] uppercase">{k}</p>
            <p className={`text-sm font-mono mt-1 ${v==="ok"?"text-green-400":"text-red-400"}`}>{v}</p>
          </div>
        ))}
      </div>

      {/* 统计数字 */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "用户", value: stats?.data?.user_count },
          { label: "场站", value: stats?.data?.station_count },
          { label: "设备", value: stats?.data?.equipment_count },
          { label: "工单（30天）", value: stats?.data?.workorder_30d },
          { label: "KB 文档", value: stats?.data?.kb_doc_count },
          { label: "告警（今日）", value: stats?.data?.alarm_today },
        ].map(item => (
          <div key={item.label} className="rounded border border-[#30363D] p-3">
            <p className="text-xs text-[#8B949E]">{item.label}</p>
            <p className="text-2xl font-mono mt-1">{item.value ?? "—"}</p>
          </div>
        ))}
      </div>

      {/* 审计日志（最近 20 条）*/}
      <div>
        <h2 className="text-sm font-medium mb-2">审计日志</h2>
        <AuditLogTable />
      </div>

      {/* 备份 */}
      <div className="flex items-center gap-3">
        <button onClick={triggerBackup}
          className="px-3 py-1.5 text-sm bg-[#21262D] hover:bg-[#30363D] border border-[#30363D] rounded">
          触发手动备份
        </button>
        <span className="text-xs text-[#8B949E]">自动备份：每天 02:00</span>
      </div>
    </div>
  );
}
```

---

### 33.6 公共 Admin 组件（DataTable / Modal / FormField）

```typescript
// src/components/admin/DataTable.tsx — 通用数据表格
interface Column<T> {
  key: string; label: string;
  render: (row: T) => React.ReactNode;
}
export function DataTable<T extends Record<string, unknown>>({
  columns, rows, rowKey,
}: { columns: Column<T>[]; rows: T[]; rowKey: keyof T }) {
  return (
    <div className="rounded border border-[#30363D] overflow-auto">
      <table className="w-full text-sm">
        <thead className="bg-[#161B22]">
          <tr>{columns.map(c => (
            <th key={c.key} className="px-4 py-2 text-left text-xs text-[#8B949E] font-normal">
              {c.label}
            </th>
          ))}</tr>
        </thead>
        <tbody className="divide-y divide-[#21262D]">
          {rows.map(row => (
            <tr key={String(row[rowKey])} className="hover:bg-[#161B22]">
              {columns.map(c => (
                <td key={c.key} className="px-4 py-2">{c.render(row)}</td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={columns.length} className="px-4 py-8 text-center text-[#8B949E]">
              暂无数据
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// src/components/admin/Modal.tsx — 通用弹层
export function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-[#161B22] border border-[#30363D] rounded-lg w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">{title}</h2>
          <button onClick={onClose} className="text-[#8B949E] hover:text-white">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ModalFooter({ onCancel, onConfirm, confirmLabel = "确认" }: {
  onCancel: () => void; onConfirm: () => void; confirmLabel?: string;
}) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <button onClick={onCancel} className="px-3 py-1.5 text-sm text-[#8B949E] hover:text-white">取消</button>
      <button onClick={onConfirm} className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded">{confirmLabel}</button>
    </div>
  );
}

// FormField / FormSelect（复用 Input 样式）
export function FormField({ label, value, onChange, type="text", placeholder="" }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-[#8B949E]">{label}</label>
      <input type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-[#0D1117] border border-[#30363D] rounded px-3 py-1.5
                   text-sm text-[#C9D1D9] focus:border-blue-500 outline-none" />
    </div>
  );
}

export function FormSelect({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-[#8B949E]">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full bg-[#0D1117] border border-[#30363D] rounded px-3 py-1.5
                   text-sm text-[#C9D1D9] focus:border-blue-500 outline-none">
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}
```

---

### 33.7 Admin 新增文件结构

```
src/
├── pages/admin/
│   ├── AdminLayout.tsx         ← §33.2
│   ├── AdminUsersPage.tsx      ← §33.3
│   ├── AdminStationsPage.tsx   ← 仿 UsersPage，管场站 IMS config（JSON textarea）
│   ├── AdminEquipmentPage.tsx  ← 仿 UsersPage，支持 CSV 批量导入
│   ├── AdminKBPage.tsx         ← §33.4
│   └── AdminSystemPage.tsx     ← §33.5
└── components/admin/
    ├── DataTable.tsx            ← §33.6
    ├── Modal.tsx                ← §33.6
    ├── UserFormModal.tsx        ← §33.3
    ├── StationFormModal.tsx     ← IMS config JSON 编辑器（monaco-editor lite）
    └── EquipmentImportModal.tsx ← CSV 预览 + 批量导入
```

---

_§33 新增（2026-05-09）：Admin 后台完整组件设计。_
_5 个页面：用户/场站/设备/知识库/系统；公共组件 DataTable/Modal/FormField/FormSelect。_
_复用 Studio 基础设施（React Query / Tailwind / 颜色 token），无需新应用。_

---

## 三十四、StationSwitcher — 多站场切换器（补充）

> **背景**：一个操作员可能被分配多个站场（`station_ids` 字段），Studio 需要提供站场切换器让用户在不同站场间快速切换。这是多工作区支持的核心 UI 入口。

### 34.1 放置位置

```
StudioShell 顶部 Header 栏（右侧，用户头像左边）
┌─────────────────────────────────────────────────────────┐
│  [ClawTwin Logo]  [Mission Control]  [TwinPage]  ...    │
│                                    [泵站一 ▼] [👤 李强] │
└─────────────────────────────────────────────────────────┘
```

### 34.2 组件实现

```typescript
// src/components/layout/StationSwitcher.tsx
import { useAuth } from "@/hooks/useAuth";
import { useTwinStore } from "@/stores/twin.store";

interface Station {
  id: number;
  name: string;
  status: "normal" | "alarm" | "offline";
}

export function StationSwitcher() {
  const { user } = useAuth();                     // JWT 中的 station_ids + station 名称
  const { currentStationId, setCurrentStation } = useTwinStore();
  const [open, setOpen] = useState(false);

  // 仅展示当前用户有权限的站场
  const stations: Station[] = user?.stations ?? [];

  // 单站场用户：隐藏切换器（不需要切换）
  if (stations.length <= 1) return null;

  const current = stations.find(s => s.id === currentStationId);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md
                   bg-[#161B22] border border-[#30363D]
                   text-sm text-[#E6EDF3] hover:border-[#6E7681] transition"
      >
        {/* 状态指示点 */}
        <span className={`w-2 h-2 rounded-full ${
          current?.status === "alarm" ? "bg-[#EF4444]" :
          current?.status === "offline" ? "bg-[#6B7280]" : "bg-[#22C55E]"
        }`} />
        <span>{current?.name ?? "选择站场"}</span>
        <ChevronDownIcon className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[180px]
                        bg-[#161B22] border border-[#30363D] rounded-lg shadow-xl overflow-hidden">
          {stations.map(station => (
            <button
              key={station.id}
              onClick={() => {
                setCurrentStation(station.id);
                setOpen(false);
              }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left
                hover:bg-[#21262D] transition-colors ${
                  station.id === currentStationId ? "bg-[#21262D] text-[#1F6FEB]" : "text-[#E6EDF3]"
                }`}
            >
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                station.status === "alarm" ? "bg-[#EF4444]" :
                station.status === "offline" ? "bg-[#6B7280]" : "bg-[#22C55E]"
              }`} />
              {station.name}
              {station.id === currentStationId && (
                <CheckIcon className="w-3.5 h-3.5 ml-auto text-[#1F6FEB]" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

### 34.3 切换站场时的数据联动

```typescript
// src/stores/twin.store.ts 中的 setCurrentStation
setCurrentStation: (stationId: number) => {
  set({ currentStationId: stationId, selectedEquipmentId: null });
  // 重置 SSE 连接 → useSSE hook 监听 currentStationId 变化自动重连
  // 所有 React Query 缓存自动失效 → queryClient.invalidateQueries
},
```

```typescript
// src/hooks/useSSE.ts — 站场切换时自动重连
export function useSSE() {
  const { currentStationId } = useTwinStore();

  useEffect(() => {
    if (!currentStationId) return;
    const es = new EventSource(`/v1/sse/station/${currentStationId}`);
    es.onmessage = (e) => {
      /* 更新 store */
    };
    return () => es.close(); // 切换站场时关闭旧连接
  }, [currentStationId]); // ← 依赖 currentStationId，切换自动重连
}
```

### 34.4 JWT 中需包含的站场信息

```typescript
// Nexus 登录 API 返回的 JWT payload
interface JWTPayload {
  sub: string; // user_id
  role: string;
  station_ids: number[];
  stations: Array<{
    // ← 新增：避免前端再次请求站场名称
    id: number;
    name: string;
    status: "normal" | "alarm" | "offline"; // 实时状态每次 login 刷新
  }>;
  exp: number;
}
```

_§34 新增（2026-05-11）：多站场切换器。补全多工作区 UI 入口缺失项。_
