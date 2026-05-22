# ClawTwin 物理基础：数字孪生的控制论框架

> **版本**：v1.0 · 2026-05-12  
> **地位**：ClawTwin 设计的科学基础。不是"应该做什么"，是"物理世界要求这个系统必须有什么"。  
> **关键命题**：数字孪生不是数据库，是物理系统在数字空间的**动态影像**。这个影像必须遵守与物理世界相同的科学规律。

---

## 一、数字孪生的物理本质

### 1.1 孪生方程

每一台设备在任意时刻 _t_ 有一个真实的物理状态向量：

```
x_physical(t) = [temperature, vibration_rms, pressure, flow_rate, ...]  ∈ ℝⁿ
```

数字孪生持有该向量的**估计**：

```
x_twin(t) = x_physical(t) + ε(t)
```

其中 **ε(t)** 是**对应误差**（Correspondence Error），由两部分构成：

```
ε(t) = ε_lag(t)    +    ε_noise(t)
        ↑                 ↑
    时滞误差（OPC-UA    测量噪声和传感器
    轮询延迟）          精度限制
```

**ClawTwin 的核心使命**，用数学表达，就是最小化 ε(t) 并使其保持有界。

当 ε(t) 超出阈值，孪生失去与物理世界的对应关系——这比任何业务逻辑错误都严重，因为整个系统的决策基础失效了。

### 1.2 健康状态空间

设备的"健康区域"是 ℝⁿ 中的一个凸集 **H**，由设备类型的正常运行包络定义：

```
H = { x ∈ ℝⁿ : x_i_min ≤ x_i ≤ x_i_max, ∀i }    （简化形式，实际是椭球体）
```

**健康分数** = 设备状态距离 H 中心的标准化 Mahalanobis 距离的倒数：

```
health_score = 1 / (1 + d_M(x_twin, μ_healthy))

其中 d_M = √[(x - μ)ᵀ Σ⁻¹ (x - μ)]
μ_healthy = 健康状态均值向量
Σ = 协方差矩阵（指标间的相关关系）
```

**意义**：

- health_score = 1.0：完美健康（位于中心）
- health_score = 0.5：处于正常包络边缘
- health_score < 0.3：需要关注
- health_score < 0.1：临界状态，需要立即行动

当前系统用的是**轴对齐阈值**（每个指标独立判断），相当于用 ℓ∞ 范数代替了 Mahalanobis 距离。这忽略了指标之间的相关性——比如，高温+高振动的组合比单独任何一个更危险，但现有阈值系统无法捕捉这一点。

---

## 二、控制论三定理（State Space Analysis）

控制理论告诉我们，任何反馈控制系统（ClawTwin 是一个反馈控制系统）必须满足三个条件才能正常工作：

### 定理 1：可观测性（Observability）

**定义**：能否从有限的传感器读数，完整重建系统的真实状态？

**对 ClawTwin 的含义**：

```
ObservabilityMatrix O = [C; CA; CA²; ...; CAⁿ⁻¹]
系统可观测 ⟺ rank(O) = n （状态维数）
```

**当前状态**：

- ✅ 有传感器数据（观测向量 C 非零）
- ❌ 没有设备动力学模型 A（无法做卡尔曼滤波）
- ❌ 没有"哪些传感器是必需的"的形式化定义

**实际影响**：当某个关键传感器离线时，系统不知道它变成了"部分可观测"状态。AI 诊断在信息不完整的情况下继续给出高置信度结论，这是危险的。

**修复方向**：`equipment_type_metric` 表已有"哪些指标属于这个设备类型"，利用它计算**指标覆盖率**（MetricCoverage）作为可观测性的代理指标。

### 定理 2：可控性（Controllability）

**定义**：能否通过可用的 Action Types，将设备从任意故障状态恢复到健康状态？

**对 ClawTwin 的含义**：每个故障模式都必须有对应的可执行处置方案。

```
可控 ⟺ 对任意故障模式 f，∃ Action Sequence A₁,A₂,...,Aₖ 使得 x_twin → H
```

**当前状态**：

- ❌ 没有"故障模式 → Action 映射"的形式化表达
- ❌ 没有"某些故障超出系统处置能力"的表达
- ✅ Action Types 存在，但没有与故障模式的系统对应关系

**实际影响**：AI 建议了一个维修动作，但没有机制验证这个动作对于这种故障是否有效。

**修复方向**：在 `equipment_type_action` 表（已存在）中添加 `applicable_fault_modes` 字段，将 Action 与故障模式关联。

### 定理 3：稳定性（Stability / Lyapunov Stability）

**定义**：反馈控制闭环是否收敛（系统趋向平衡态还是发散振荡）？

**对 ClawTwin 的含义**：执行了维修工单之后，设备健康分数是否真的恢复？

```
Lyapunov 函数 V(x) = health_score(t)

稳定条件：执行 Action 之后，dV/dt > 0（健康分数上升）

如果 dV/dt < 0（健康分数下降），说明：
  1. 诊断错了（选错了 Action）
  2. 故障根源没有消除（Action 不够）
  3. 新故障产生（工单执行时引入的）
```

**当前状态**：

- ❌ `OutcomeEvent` 刚刚建立，没有自动计算 `dV/dt`
- ❌ 没有"工单完成后健康分数改变量"的量化追踪

**OutcomeEvent** 本质上就是在测量这个 Lyapunov 函数的变化量——这正是它的物理意义。

---

## 三、信息论视角：孪生的信息熵

Shannon 信息熵定义了系统"不确定性"：

```
H(X) = -∑ p(xᵢ) log₂ p(xᵢ)
```

应用到数字孪生：

### 3.1 告警熵（Alarm Entropy）

```
H_alarm(t) = -∑ p(alarmᵢ) log₂ p(alarmᵢ)
```

- **H_alarm → 0**：告警高度可预测（慢性问题，系统了解该设备的故障模式）
- **H_alarm → max**：告警完全随机（新型故障，或传感器噪声），此时 AI 诊断最不可靠

**意义**：AI 在低熵（可预测）告警上应该给出高置信度，在高熵（随机）告警上应该降低置信度并要求人工介入。

### 3.2 知识基互信息（KB Mutual Information）

```
I(Alarm; KB) = 告警类型与知识库内容之间的互信息
```

- **I 高**：知识库对这类告警有丰富覆盖，RAG 会有高质量结果
- **I 低**：知识库对这类告警没有覆盖，这是知识飞轮需要填补的空白

**这是知识飞轮优先级的数学依据**：优先为 `I(Alarm; KB)` 最低的告警类型补充知识。

---

## 四、动力系统视角：设备的相变

物理系统有**相变**（phase transition）：水在 100°C 时从液态变为气态。工业设备也有类似的相变：

```
正常运行 → 早期退化 → 加速退化 → 故障
  (Healthy)   (Degrading)  (Critical)   (Failed)
```

相变的特征是**连续量的非线性响应**：小的变化可能触发大的状态转变。

当前系统的问题：

- 只有两个状态：正常（无告警）和故障（有告警）
- 没有"早期退化"状态的检测机制
- 错过了预测性维护的最佳时机（相变之前）

**修复方向**：健康趋势（health_trend: improving/stable/degrading）+ 预测到达临界状态的时间（`estimated_hours_to_critical`）。

---

## 五、图论视角：工厂是一个网络

设备不是孤立存在的。工厂是一个**有向图**：

```
图 G = (V, E)
V = 设备集合 {Equipment Objects}
E = 物理连接 {Link Types: feeds_into, controlled_by, parallel_with, ...}
```

图的拓扑性质直接影响故障传播：

### 5.1 关键路径（Critical Path）

去掉某个节点后图变得不连通，该节点是**关键节点**（Critical Node / Bridge）。关键设备的故障影响比普通设备大一个数量级。

### 5.2 因果传播（Causal Propagation）

当设备 A 发生告警，受影响的设备是图中从 A 可达的所有节点：

```
Affected(A) = { B : ∃ path A → B in G }
              × { 只有 Link 类型为"故障传播"方向时 }
```

**实际意义**：压缩机故障 → 下游所有使用压缩空气的设备都应该被提醒检查。

### 5.3 图的自愈能力

如果存在冗余路径（parallel_with 链接），单点故障可以被绕过。系统应该知道当前拓扑是否存在冗余，以及冗余是否完好。

---

## 六、从物理规律推导出的四条新工程要求

综合以上分析，数字孪生系统**物理上必须**具备以下能力（不是可选的扩展，而是基础正确性的要求）：

| #   | 要求                                           | 物理依据                             | 当前状态                         | 实现模块                 |
| --- | ---------------------------------------------- | ------------------------------------ | -------------------------------- | ------------------------ |
| R1  | **孪生新鲜度**：每个设备状态必须标注数据年龄   | 不确定性原理：无法知道你不观测的东西 | ❌ 未实现                        | `twin_correspondence.py` |
| R2  | **健康向量**：多维状态到标量健康分数的映射     | 状态空间理论 + Mahalanobis 距离      | ⚠️ 只有简单阈值                  | `twin_correspondence.py` |
| R3  | **因果传播**：告警沿 LinkType 图传播到下游     | 图论 + 物理因果律                    | ❌ 未实现                        | `causal_graph.py`        |
| R4  | **稳定性度量**：工单完成后 Lyapunov 函数变化量 | 控制系统稳定性                       | ⚠️ OutcomeEvent 已建，计算未实现 | 更新 `OutcomeEvent`      |

---

## 七、孪生忠实度仪表盘（新 API 字段）

每个设备的 `GET /v1/equipment/{id}/decision-package` 应该包含：

```json
{
  "twin_fidelity": {
    "freshness_seconds": 12, // 最近一次读数距今秒数
    "metric_coverage": 0.87, // 已收到的指标 / 期望指标数
    "correspondence_quality": 0.82, // 综合孪生忠实度 (freshness × coverage)
    "is_stale": false, // freshness > staleness_threshold
    "is_partial": false // metric_coverage < completeness_threshold
  },
  "health_vector": {
    "health_score": 0.73, // Mahalanobis 归一化健康分数
    "state_vector": {
      // 归一化后的各指标偏离量
      "vibration_rms": 0.45, // 0=中心健康值, 1=到达告警阈值
      "temperature": 0.12,
      "bearing_temp": 0.67
    },
    "trend": "degrading", // improving / stable / degrading
    "trend_rate_per_hour": -0.02, // 每小时健康分数变化量
    "estimated_hours_to_critical": 8 // 预计多少小时后进入临界状态
  },
  "causal_context": {
    "upstream_count": 2, // 上游设备数量
    "downstream_count": 5, // 下游设备数量（故障影响范围）
    "is_critical_node": true, // 是否是工厂网络的关键节点
    "active_upstream_alarms": 1 // 上游正在告警的设备数
  }
}
```

---

_本文档是 ClawTwin 物理基础的权威定义，与 `CLAWTWIN-AUTONOMY-PHILOSOPHY.md` 互补——哲学定义为什么，本文定义是什么的数学意义。_
