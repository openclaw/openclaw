# Studio UI 架构设计（权威版）

**版本**：1.0，2026-05-11  
**目标**：为工业决策场景提供最快响应、最低认知负荷的 UI 架构  
**权威性**：与 MODULE-DESIGN-STUDIO.md 互补，本文档专注于架构（为什么这样做），MODULE-DESIGN-STUDIO 专注于实现（怎么做）

---

## 一、UI 架构核心原则

```
原则 1：决策优先（Decision First）
  用户打开 Studio 的首要目的：做决策，不是看数据。
  · 第一屏永远显示"最需要关注的事情"，而不是漂亮的图表
  · 每个页面都有且只有一个"主行动"（One Big Action）
  · 降低信息密度，增加行动密度

原则 2：状态驱动（State Driven）
  UI 是状态的"投影"，状态变化 = UI 自动变化，不依赖手动刷新。
  · 实时状态（设备读数/告警）通过 SSE 推送
  · 业务状态（工单/KB）通过 React Query 缓存管理
  · 不允许在组件内部维护"应该是全局的状态"

原则 3：延迟接受（Latency Tolerance）
  工业数据的延迟是客观存在的（传感器 → OT → 网络 → 数据库 → 前端）。
  · 明确告知用户数据的"年龄"（最后更新时间）
  · 区分"实时数据"和"历史数据"的视觉呈现
  · 离线时显示 OfflineBanner，不白屏

原则 4：权限感知渲染（Permission-Aware Rendering）
  不同角色看到不同界面，但不是隐藏元素，而是不渲染。
  · operator: 查看 + 提交工单
  · supervisor: 查看 + 审批工单 + 告警管理
  · engineer: 上述所有 + KB 管理 + AI 分析配置
  · sys_admin: 上述所有 + 用户/场站/设备管理
```

---

## 二、状态分层架构

```
Studio 的状态分为四层，每层有明确的所有者和生命周期：

Layer 1：持久化状态（Zustand + localStorage）
  · user session（JWT token + UserSchema）
  · UI preferences（侧边栏展开/折叠、当前选中场站）

  持有者：auth.store.ts, ui.store.ts
  更新时机：用户操作（手动）

Layer 2：服务器状态（TanStack Query = React Query）
  · 工单列表（/v1/workorders）
  · 知识库文档（/v1/kb/documents）
  · 设备列表（/v1/equipment）
  · 场站列表（/v1/stations）

  持有者：React Query cache（内存）
  更新时机：staleTime 过期后自动重新获取（TTL: 30s-5min）
  特点：后台自动刷新，窗口聚焦时重新验证

Layer 3：实时状态（SSE + Zustand）
  · 设备最新读数
  · 活跃告警列表
  · AI Job 执行状态
  · Decision Package（间接通过 SSE 更新）

  持有者：realtime.store.ts
  更新时机：SSE 事件推送（服务端主动）

Layer 4：本地 UI 状态（useState / useReducer）
  · 表单输入（工单草稿正在编辑）
  · 弹窗/折叠/加载状态
  · 未提交的变更

  持有者：组件本身
  更新时机：用户交互

关键规则：
  ❌ 不允许把 Layer 2/3 的数据下沉到 Layer 4（会导致状态撕裂）
  ❌ 不允许在子组件内部直接 fetch（所有请求通过 hooks）
  ✅ SSE 更新 → realtime.store → 组件订阅 store → 重渲染
```

---

## 三、状态 Store 定义（完整）

```typescript
// stores/auth.store.ts
interface AuthState {
  token: string | null;
  user: UserSchema | null;
  isAuthenticated: boolean;

  // Actions
  login(token: string, user: UserSchema): void;
  logout(): void;
  hasRole(role: string): boolean;
  hasStationAccess(stationId: number): boolean;
}

// stores/ui.store.ts
interface UIState {
  selectedStationId: number | null;
  selectedEquipmentId: number | null;
  centerViewTab: "twin" | "graph" | "trend" | "kanban" | "pid";
  intelPanelMode: "intel" | "alarm_queue"; // 无选中设备时显示告警
  sidebarCollapsed: boolean;

  // Actions
  selectStation(id: number): void;
  selectEquipment(id: number | null): void;
  setCenterTab(tab: CenterViewTab): void;
}

// stores/realtime.store.ts
interface RealtimeState {
  // 按 equipment_id 索引的最新读数
  readings: Record<number, Record<string, ReadingSchema>>;
  // 按 equipment_id 索引的健康分
  healthScores: Record<number, { score: number; status: string; updatedAt: string }>;
  // 活跃告警（按 alarm_id 索引）
  activeAlarms: Record<number, AlarmSchema>;
  // AI Job 状态
  aiJobs: Record<string, AIJobSchema>;

  // SSE Actions（内部用）
  updateReading(equipmentId: number, metric: string, reading: ReadingSchema): void;
  updateHealth(equipmentId: number, score: number, status: string): void;
  upsertAlarm(alarm: AlarmSchema): void;
  removeAlarm(alarmId: number): void;
  updateAIJob(taskId: string, job: Partial<AIJobSchema>): void;

  // Connection state
  connectionStatus: "connected" | "reconnecting" | "offline";
  lastSeenAt: string | null; // ISO8601
}
```

---

## 四、数据获取架构（Smart Fetching）

```typescript
// lib/smart-fetcher.ts
// 统一的数据获取策略，避免 API 过载

export class SmartFetcher {
  // ① 决策包：最高优先级，立即获取，阻塞渲染
  static async getDecisionPackage(equipmentId: number): Promise<DecisionPackageSchema> {
    // React Query key: ['decision-package', equipmentId]
    // staleTime: 25s（略小于 Pulse Engine 30s 刷新周期）
    // cacheTime: 60s
  }

  // ② 历史趋势：懒加载，用户切换到"趋势"Tab 时才请求
  static async getHistory(
    equipmentId: number,
    period: "1h" | "24h" | "7d",
  ): Promise<HistorySchema> {
    // React Query key: ['history', equipmentId, period]
    // staleTime: 5min（历史数据变化慢）
  }

  // ③ KB 内容：按需获取，用户点击"查看知识"时
  static async getKBChunks(ids: number[]): Promise<KBChunkSchema[]> {
    // 直接按 ID 查询（从 Decision Package 预存的 relevant_kb_ids）
    // 不重新向量搜索，速度更快
    // React Query key: ['kb-chunks', ids.join(',')]
    // staleTime: 30min（KB 内容很少变化）
  }

  // ④ 设备列表：后台预获取，Station 选中时就开始
  static prefetchEquipmentList(stationId: number): void {
    // requestIdleCallback → queryClient.prefetchQuery
    // 不阻塞主线程
  }
}
```

---

## 五、SSE 连接管理

```typescript
// hooks/useSSEConnection.ts
// 管理 SSE 连接的生命周期（重连、心跳检测）

export function useSSEConnection(stationId: number | null) {
  const { updateReading, updateHealth, upsertAlarm, updateAIJob } = useRealtimeStore();

  useEffect(() => {
    if (!stationId) return;

    const sse = new EventSource(
      `${API_BASE}/v1/sse/station/${stationId}`,
      { withCredentials: true }, // 携带 Cookie（如果用 Cookie auth）
    );

    sse.addEventListener("reading_update", (e) => {
      const { equipment_id, metric, ...reading } = JSON.parse(e.data);
      updateReading(equipment_id, metric, reading);
    });

    sse.addEventListener("health_update", (e) => {
      const { equipment_id, health_score, health_status } = JSON.parse(e.data);
      updateHealth(equipment_id, health_score, health_status);
    });

    sse.addEventListener("alarm_triggered", (e) => {
      upsertAlarm(JSON.parse(e.data));
    });

    sse.addEventListener("ai_job_done", (e) => {
      const job = JSON.parse(e.data);
      updateAIJob(job.task_id, job);
      // 同时 invalidate React Query 缓存（触发 UI 刷新）
      queryClient.invalidateQueries(["ai-jobs", job.task_id]);
    });

    // 心跳检测（60s 无消息 → 视为断连）
    let lastPing = Date.now();
    sse.addEventListener("ping", () => {
      lastPing = Date.now();
    });
    const heartbeatCheck = setInterval(() => {
      if (Date.now() - lastPing > 65_000) {
        setConnectionStatus("reconnecting");
        sse.close(); // 触发 EventSource 自动重连
      }
    }, 10_000);

    sse.onerror = () => setConnectionStatus("reconnecting");
    sse.onopen = () => setConnectionStatus("connected");

    return () => {
      sse.close();
      clearInterval(heartbeatCheck);
    };
  }, [stationId]);
}
```

---

## 六、组件分层架构

```
组件分四层，严格遵守依赖方向（下层不依赖上层）：

Layer 1：Primitive（原子组件）
  · 无业务逻辑，无 API 调用，无 Store 依赖
  · src/components/ui/（shadcn/ui 扩展）
  · 例：Button, Badge, Card, Spinner, Skeleton

Layer 2：Industrial（工业语义组件）
  · 有工业领域语义，无 API 调用
  · 接收 Props，纯展示
  · src/components/industrial/
  · 例：HealthBadge（健康状态颜色标签）
          AlarmLevelIcon（P1-P4 图标）
          MetricValueDisplay（值+单位+状态色）
          CitationBadge（可点击知识来源）

Layer 3：Feature（功能组件）
  · 包含业务逻辑，可能有 Store 订阅
  · 接收父组件传入的数据，自己处理交互
  · src/components/intel/, /alarm/, /workorder/
  · 例：DeviceIntelPanel（接收 equipmentId，内部订阅 Store）
          AlarmRow（单条告警，有 Ack/Shelve 操作）
          WorkOrderDraftInline（内嵌草稿，提交工单）

Layer 4：Page/View（页面）
  · 负责数据获取（通过 hooks）和布局
  · src/pages/
  · 例：StudioShell（整体布局）
          TwinView（3D 视图容器）
          KanbanView（工单看板）

严禁：
  ❌ Layer 2 组件内部调用 API 或访问 Store
  ❌ Layer 1 组件有任何业务语义（颜色应该由 Layer 2 处理）
  ❌ 同 Layer 组件互相导入（同层之间只能通过 Props 通信）
```

---

## 七、主布局架构（StudioShell）

```
┌─────────────────────────────────────────────────────────────────────┐
│  NavRail（左侧，64px 固定）                                           │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ StationHeatmap（热力图，8x8 格，点击选择设备）                 │    │
│  │ [UI 铁律 7：NavRail 顶部必须有 StationHeatmap]                │    │
│  │                                                              │    │
│  │ ──────────────────                                           │    │
│  │ [设备列表]（按健康分倒序）                                      │    │
│  │  ● C-101 ▰▰▰▰▰▰▰ 73（warning）                             │    │
│  │  ○ P-201 ▰▰▰▰▰▰▰▰ 91（good）                               │    │
│  │  ...                                                         │    │
│  │                                                              │    │
│  │ ──────────────────                                           │    │
│  │ [班次交接卡]（ShiftHandoverCard）                              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  CenterView（中央，弹性宽度）                                         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ [Tab Bar] 孪生🏭 | 关系图🕸 | 趋势📈 | 工单📋 | P&ID📐        │    │
│  │ [Tab Content]                                               │    │
│  │  twin: TwinSurface（Babylon.js 3D）                         │    │
│  │  trend: TrendView（TimescaleDB 时序图）                      │    │
│  │  kanban: KanbanView（工单看板）                               │    │
│  │  ...                                                        │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  IntelPanel（右侧，400px 固定）                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ [if selectedEquipment]                                       │    │
│  │   DeviceIntelPanel（设备智能面板）                             │    │
│  │ [else]                                                       │    │
│  │   AlarmQueuePanel（全局告警队列）                              │    │
│  │ [if P1 alarm]                                                │    │
│  │   InvestigationBanner（全宽置顶紫色横幅）                      │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 八、DeviceIntelPanel 布局架构（权威）

```
DeviceIntelPanel 布局（从上到下，顺序固定不可变）：

┌─────────────────────────────────────────────────────┐
│ 设备标题 + 健康状态 Badge                              │ ← Header
├─────────────────────────────────────────────────────┤
│ UrgencyCountdown（只在 primary_action.urgency=immediate 时显示）│
│  ⏰ 建议在 45 分钟内处理                               │
├─────────────────────────────────────────────────────┤
│ OneActionButton（必须显示，由 primary_action 驱动）    │
│  🔴 [紧急] 立即创建工单 → 震动轴承更换                 │
│  [展开后显示 WorkOrderDraftInline]                    │
├─────────────────────────────────────────────────────┤
│ AIInsightCard（如有 proactive_insight）               │
│  🤖 AI 分析 [置信度色块]                              │
│  [分析内容摘要 + Citations]                           │
│  [若无 insight：显示"AI 正在分析..."骨架屏]            │
├─────────────────────────────────────────────────────┤
│ MetricGrid（关键指标，默认折叠显示 4 个）              │
│  ↕ 点击展开显示全部                                    │
├─────────────────────────────────────────────────────┤
│ HealthScoreCard（环形进度 + 趋势箭头）                 │
│  ○ 73分  ↓ 下降中（最近 1h -12分）                    │
├─────────────────────────────────────────────────────┤
│ WorkOrderSection（该设备相关工单，最近 3 条）           │
│  📋 草稿中(2) / 待审批(1) / 进行中(0)                  │
│  [点击展开详情]                                        │
└─────────────────────────────────────────────────────┘

布局原则（来自认知科学 SA-RPD 模型）：
  · 最上层 = 最紧急 + 最需要行动
  · 向下滚动 = 更多细节 + 历史信息
  · 用户大多数时间只看前 3 块（倒计时+Action+AI）
```

---

## 九、3D 渲染架构（Babylon.js 集成）

```typescript
// surfaces/TwinSurface.tsx

/**
 * Babylon.js 集成的设计原则：
 * 1. 渲染循环与 React 完全解耦（不在 useEffect 里操作 Babylon 对象）
 * 2. 场景状态通过 Babylon.js Observable 同步到 React（单向）
 * 3. 用户交互通过 React 事件 → Babylon 命令（单向）
 * 4. 设备状态更新通过 Babylon metadata 而非重新创建网格
 */

class TwinSceneManager {
  private engine: Engine;
  private scene: Scene;
  private meshMap: Map<number, Mesh>;  // equipmentId → Mesh

  // React → Babylon 的命令接口（单向）
  highlightEquipment(equipmentId: number): void {
    const mesh = this.meshMap.get(equipmentId);
    if (mesh) HighlightLayer.addMesh(mesh, Color3.Yellow());
  }

  updateHealthStatus(equipmentId: number, status: HealthStatus): void {
    const mesh = this.meshMap.get(equipmentId);
    if (mesh) {
      const mat = mesh.material as StandardMaterial;
      mat.diffuseColor = HEALTH_COLORS[status];
    }
  }

  // Babylon → React 的事件接口（通过 Observable）
  onEquipmentClick = new Observable<number>();  // 发出 equipmentId
}

// React 组件只做：
// 1. 接收 Store 状态 → 调用 TwinSceneManager 命令
// 2. 监听 TwinSceneManager 事件 → 更新 Store
function TwinSurface() {
  const manager = useRef(new TwinSceneManager());
  const selectedId = useUIStore(s => s.selectedEquipmentId);
  const healthScores = useRealtimeStore(s => s.healthScores);

  // React → Babylon：选中高亮
  useEffect(() => {
    manager.current.highlightEquipment(selectedId);
  }, [selectedId]);

  // React → Babylon：健康状态颜色更新
  useEffect(() => {
    Object.entries(healthScores).forEach(([id, { status }]) => {
      manager.current.updateHealthStatus(Number(id), status);
    });
  }, [healthScores]);

  // Babylon → React：点击事件
  useEffect(() => {
    const sub = manager.current.onEquipmentClick.add((id) => {
      useUIStore.getState().selectEquipment(id);
    });
    return () => sub.unregister();
  }, []);

  return <canvas ref={canvasRef} />;
}
```

---

## 十、权限感知渲染架构

```typescript
// components/RequirePermission.tsx

/**
 * 权限控制原则：
 * · 角色控制：显示什么功能（role-based rendering）
 * · 场站控制：显示哪些数据（station-based filtering）
 * · 许可证控制：显示哪些高级功能（license-based rendering）
 */

// 用法示例：
<RequireRole role="supervisor">
  <ApproveButton workOrderId={id} />
</RequireRole>

<RequireRole role={["engineer", "sys_admin"]}>
  <KBUploadButton />
</RequireRole>

// 许可证控制（Phase B 后启用）
<RequireLicense feature="fleet_intelligence">
  <FleetView />
  <UpgradePrompt feature="fleet_intelligence" />  {/* 未授权时显示升级提示 */}
</RequireLicense>

// 实现
function RequireRole({ role, children }: { role: string | string[], children: ReactNode }) {
  const { user } = useAuthStore();
  const roles = Array.isArray(role) ? role : [role];

  // 不渲染而不是隐藏（隐藏会泄露 DOM 结构）
  if (!user || !roles.includes(user.role)) return null;
  return <>{children}</>;
}
```

---

## 十一、表单架构（工单草稿）

```typescript
// components/workorder/WorkOrderDraftInline.tsx
// 工单草稿必须内嵌（UI 铁律 8），不跳页面

/**
 * 表单状态管理：
 * · 未提交的草稿 → useState（组件本地，不进 Store）
 * · 提交中 → React Query mutation
 * · 提交成功 → 关闭表单，invalidate 工单列表缓存
 * · 提交失败 → 保留用户输入 + 显示错误
 */

function WorkOrderDraftInline({ equipmentId, aiDraft }: Props) {
  // aiDraft 来自 Decision Package 的 primary_action（AI 预填内容）
  const [form, setForm] = useState<WorkOrderDraftForm>({
    title: aiDraft?.title ?? "",
    symptom: aiDraft?.symptom ?? "",
    suggested_action: aiDraft?.suggested_action ?? "",
    equipment_id: equipmentId,
  });

  const createMutation = useMutation({
    mutationFn: (data: WorkOrderCreateSchema) =>
      apiFetch("POST", "/v1/workorders/", data),
    onSuccess: (workOrder) => {
      queryClient.invalidateQueries(["workorders"]);
      toast.success(`工单 ${workOrder.wo_id} 已创建`);
      onClose();  // 折叠表单
    },
  });

  return (
    <form onSubmit={handleSubmit}>
      <Textarea label="症状描述" value={form.symptom} onChange={...} />
      <Textarea label="建议操作" value={form.suggested_action} onChange={...} />
      <Button type="submit" loading={createMutation.isPending}>
        提交工单
      </Button>
    </form>
  );
}
```

---

## 十二、错误边界架构

```typescript
// 每个主要区域有独立的 Error Boundary
// 一个区域崩溃不影响其他区域

<ErrorBoundary fallback={<NavRailError />}>
  <NavRail />
</ErrorBoundary>

<ErrorBoundary fallback={<CenterViewError />}>
  <CenterView />
</ErrorBoundary>

<ErrorBoundary fallback={<IntelPanelError />}>
  <IntelPanel />
</ErrorBoundary>

// 错误 Fallback 设计原则：
// · 显示哪个区域崩溃了（不是通用的"出错了"）
// · 提供"刷新这个区域"按钮（只重置该 Error Boundary）
// · 不影响其他区域继续工作
```

---

## 十三：离线架构（Service Worker）

```typescript
// public/sw.js（Service Worker）

// 缓存策略：
// · Shell（HTML/JS/CSS）→ Cache First（离线可用）
// · API 读请求 → Stale While Revalidate（先返回缓存，后台刷新）
// · SSE → 不缓存，断线时 offline banner

// OfflineBanner 触发条件：
// 1. SSE 连接断开超过 30s
// 2. API 请求失败超过 3 次
// 显示：橙色横幅 "⚡ 数据连接中断 · 最后更新 2 分钟前"
// 数据：继续显示 Service Worker 缓存的最后已知状态

// Phase A 实现：仅缓存 Shell（最小实现）
// Phase B 实现：完整 Stale While Revalidate + 离线工单草稿缓存
```

---

## 十四：性能基准

```
目标（P95，正常网络，M1 MacBook 基准）：
  · 首屏加载（FCP）：< 1.5 秒
  · 设备页面就绪（打开 Decision Package 后）：< 500 毫秒
  · SSE 读数更新到 UI 刷新：< 100 毫秒
  · 工单提交到列表刷新：< 300 毫秒
  · 3D 场景初始化：< 3 秒（使用占位几何体）

Bundle 大小控制（gzip）：
  · Initial chunk：< 200KB（只加载 Shell + Auth）
  · Babylon.js 单独 chunk：< 500KB（懒加载，只有访问 twin tab 才加载）
  · 总 bundle：< 2MB（不含 3D 模型资产）

代码分割策略：
  · 每个 Tab 的视图组件懒加载
  · Babylon.js：dynamic import（TwinView 进入时才加载）
  · Admin 模块：dynamic import（sys_admin 才需要）
```

---

## 十五：UI 技术栈决策（锁定，不可更改）

```
框架：React 18 + TypeScript（strict mode）
路由：React Router v6（基于 Data API）
状态：Zustand（全局 Store）+ TanStack Query（服务器状态）
样式：Tailwind CSS（utility first）+ shadcn/ui（组件库）
表单：React Hook Form + Zod（表单验证）
3D：Babylon.js 8（WebGPU first，WebGL fallback）
实时：原生 EventSource（SSE）
Mock：MSW（开发环境 API Mock）
测试：Vitest + React Testing Library
Storybook：组件文档和视觉测试
构建：Vite + TypeScript
HTTP：axios（拦截器 + retry）

不引入：
❌ Redux / MobX（Zustand 已够）
❌ Next.js（Studio 是 SPA，不需要 SSR）
❌ Three.js（统一用 Babylon.js）
❌ Apollo / SWR（TanStack Query 已够）
❌ Emotion/Styled Components（Tailwind 已够）
❌ jQuery / Lodash（现代 JS 内置功能已够）
```

---

_本文档是 Studio UI 架构的权威设计，与 MODULE-DESIGN-STUDIO.md 互补。_  
_架构原则（本文）优先于实现细节（MODULE-DESIGN-STUDIO）。_
