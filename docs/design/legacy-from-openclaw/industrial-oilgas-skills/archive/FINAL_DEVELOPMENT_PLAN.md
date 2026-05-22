# 最终开发就绪方案

## 物理仿真数据 · 行业扩展 · 产品组合 · 开发路线图

**版本**：DEV-READY 1.0 · 2026-05-08  
**状态**：可以开始开发  
**核心结论**：架构已确定，物理仿真用 pandapipes（不需要 OpenFOAM），同一平台可覆盖 4 个工业垂直，产品组合清晰，从明天开始。

---

## 一、物理仿真数据：如何获得 10K 条训练数据

### 1.1 重要的认知修正：不需要 OpenFOAM

```
错误理解：
  管道仿真 → 需要 CFD（OpenFOAM/ANSYS Fluent）→ 需要 HPC 集群 → 很贵很复杂

正确理解：
  管道水力/气力仿真 = 1D 网络流 → 稳态几秒，瞬态几分钟 → 普通笔记本可跑

  3D CFD 适用于：叶轮流道、燃烧室、汽车外形
  1D 网络流适用于：管道网络压力/流量分布（我们的场景）

  完全不需要 OpenFOAM，专用工具更快更准。
```

### 1.2 核心工具：pandapipes（Apache 2.0，Python，专为管网设计）

```python
# pandapipes 是什么
# - 开源 Python 库（Fraunhofer IEE，Apache 2.0）
# - 支持：天然气、蒸汽、水、氢气管网
# - 功能：稳态流量/压力计算 + 瞬态仿真
# - 安装：pip install pandapipes

import pandapipes as pp
import numpy as np

# 创建一个输气站网络
net = pp.create_empty_network(fluid="lgas")  # 低热值天然气

# 添加节点（Junction = 管道连接点 / 设备接口）
j1 = pp.create_junction(net, pn_bar=70, tfluid_k=300, name="进站汇管")
j2 = pp.create_junction(net, pn_bar=70, tfluid_k=300, name="过滤器前")
j3 = pp.create_junction(net, pn_bar=68, tfluid_k=300, name="压缩机前")
j4 = pp.create_junction(net, pn_bar=80, tfluid_k=320, name="压缩机后")
j5 = pp.create_junction(net, pn_bar=80, tfluid_k=310, name="出站汇管")

# 添加管道（自动计算摩擦损失，Colebrook-White 方程）
pp.create_pipe_from_parameters(net, j1, j2, length_km=0.05, diameter_m=0.5,
                                k_mm=0.05, name="进站管")
pp.create_pipe_from_parameters(net, j2, j3, length_km=0.02, diameter_m=0.4,
                                k_mm=0.05, name="过滤后管")

# 添加压缩机（升压设备）
pp.create_compressor(net, j3, j4, pressure_ratio=1.2, name="C-001")

# 添加截断阀（关闭模拟）
pp.create_valve(net, j4, j5, diameter_m=0.5, opened=True, name="SDV-002")

# 添加边界条件
pp.create_ext_grid(net, j1, p_bar=70, t_k=293, name="进站压力源")  # 入口
pp.create_sink(net, j5, mdot_kg_per_s=100, name="出站流量需求")  # 出口负荷

# 运行稳态仿真（< 1 秒）
pp.pipeflow(net)

# 读取结果
print(net.res_junction)    # 各节点压力
print(net.res_pipe)        # 各管段流量/流速
print(net.res_compressor)  # 压缩机进出口状态
```

### 1.3 批量生成 10K 训练样本（参数化扫描）

```python
import pandas as pd
from itertools import product
import pandapipes as pp

def generate_training_dataset(n_samples=10000, output_file="training_data.parquet"):
    """
    参数化扫描生成仿真训练数据集
    用于训练 FNO 压力/流量代理模型
    """
    results = []

    # 参数范围（基于真实输气站工况）
    inlet_pressures = np.random.uniform(60, 85, n_samples)    # MPa → bar（60-85 bar）
    flow_demands    = np.random.uniform(50, 200, n_samples)   # kg/s
    valve_states    = np.random.choice([True, False], size=(n_samples, 3))  # 3 个阀门
    comp_ratios     = np.random.uniform(1.05, 1.4, n_samples) # 压缩比
    gas_densities   = np.random.uniform(0.68, 0.85, n_samples)  # 天然气密度变化

    for i in range(n_samples):
        try:
            net = build_station_network(
                inlet_pressure=inlet_pressures[i],
                flow_demand=flow_demands[i],
                valve_sdv001=valve_states[i, 0],
                valve_sdv002=valve_states[i, 1],
                valve_prv030=valve_states[i, 2],
                compressor_ratio=comp_ratios[i],
                gas_density=gas_densities[i]
            )
            pp.pipeflow(net, stop_condition="tol", delta_p=1e-4, max_iter=100)

            results.append({
                # 输入特征
                "inlet_pressure": inlet_pressures[i],
                "flow_demand": flow_demands[i],
                "valve_sdv001": valve_states[i, 0],
                "valve_sdv002": valve_states[i, 1],
                "valve_prv030": valve_states[i, 2],
                "compressor_ratio": comp_ratios[i],
                # 输出目标（要预测的物理量）
                "outlet_pressure": net.res_junction.loc[net.junction[net.junction.name=="出站汇管"].index[0], "p_bar"],
                "filter_dp": net.res_junction.loc[..., "p_bar"],  # 过滤器差压
                "compressor_power": net.res_compressor["p_kw"].values[0],
                "pipe_max_velocity": net.res_pipe["v_mean_m_per_s"].max(),
                "converged": True
            })
        except pp.pipeflow.PipeflowNotConverged:
            results.append({"converged": False})

    df = pd.DataFrame(results)
    df_clean = df[df.converged].drop(columns=["converged"])
    df_clean.to_parquet(output_file)
    print(f"生成 {len(df_clean)} 条有效样本，保存到 {output_file}")
    return df_clean

# 运行：在普通笔记本上，10K 样本约需 30-60 分钟
# dataset = generate_training_dataset(n_samples=10000)
```

### 1.4 训练神经代理模型

```python
# 方案 A：简单 MLP（足够处理稳态预测）
import torch
import torch.nn as nn

class StationSurrogate(nn.Module):
    """输气站快速仿真代理模型"""
    def __init__(self, n_inputs=7, n_outputs=5, hidden=256):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(n_inputs, hidden),
            nn.GELU(),
            nn.Linear(hidden, hidden),
            nn.GELU(),
            nn.LayerNorm(hidden),
            nn.Linear(hidden, hidden),
            nn.GELU(),
            nn.Linear(hidden, n_outputs)
        )

    def forward(self, x):
        return self.net(x)  # 推理时间 < 1ms（CPU）

# 方案 B：FNO（Fourier Neural Operator，适合瞬态场景）
# pip install neuraloperator（NVIDIA + MIT，MIT 许可）
from neuraloperator.models import FNO1d

# FNO 适合预测：压力波在管道时间维度上的传播
# 输入：初始压力分布（空间 × 时间步 0）
# 输出：未来 T 步的压力分布（空间 × 时间步 T）

# 方案 C：直接使用 PINN（物理信息神经网络，无需仿真数据）
# 将 Bernoulli 方程 / 动量守恒嵌入损失函数
# 优点：不需要生成仿真数据
# 缺点：训练更复杂，但可以用 PhysicsNeMo 框架
```

### 1.5 开源工具链总结

| 工具               | 用途                  | 许可          | 难度       | 何时用            |
| ------------------ | --------------------- | ------------- | ---------- | ----------------- |
| **pandapipes**     | 管网稳态/瞬态仿真     | Apache 2.0    | ⭐⭐       | Phase 2 ✅ 主用   |
| **neuraloperator** | FNO 时空代理模型      | MIT           | ⭐⭐⭐     | Phase 2 ✅        |
| **PhysicsNeMo**    | PINN 框架（NVIDIA）   | Apache 2.0    | ⭐⭐⭐⭐   | Phase 3           |
| **OpenFOAM**       | 3D CFD（叶轮/燃烧室） | GPL v3        | ⭐⭐⭐⭐⭐ | 暂不需要          |
| **OpenModelica**   | Modelica 系统仿真     | OSMC-PL       | ⭐⭐⭐⭐   | Phase 3（热力学） |
| **EPANET**         | 水网络仿真            | Public Domain | ⭐⭐       | 水务场景          |

### 1.6 仿真输入数据从哪里来（现实可行路径）

```
第一步：用公开资料建立基准场站模型
  · 《输气管道工程设计》（公开教材）提供典型参数范围
  · API 14E 管道流速推荐值（输气：5-15 m/s）
  · AGA 报告（美国天然气协会，部分公开）
  · 这些数据足够建立一个「物理正确」的基准网络模型

第二步：用 pandapipes 做参数化扫描（10K 样本，一台服务器一晚上）
  · 扫描：压力、流量、阀位、气质、温度
  · 输出：各节点压力/流量/温度的分布
  · 成本：¥0（计算）+ ¥0（工具）

第三步：用真实客户数据校准（上线后）
  · 客户提供历史 SCADA 数据（压力/流量时序）
  · 用历史数据对 pandapipes 模型做参数标定（管道粗糙度等）
  · 标定后的模型精度显著提升

第四步：用校准后的模型生成场站专属训练数据
  · 每个客户的场站有自己的专属代理模型
  · 「本站物理模型」= 工业大脑理解物理的证据
```

---

## 二、同一平台适用的其他行业垂直

### 2.1 架构通用性分析

```
我们的平台核心（与行业无关）：
  · equipment_id 主线（任何设备都有位号）
  · P&ID 语义解析（任何流程工业都有 P&ID）
  · OPC UA / IoT 数据接入（工业标准，跨行业）
  · RAG + 知识图谱（任何行业都有手册/规程/标准）
  · Babylon.js 3D 孪生（任何工厂都可以 3D 化）
  · TaskFlow HITL 工单（任何维修场景都需要工单）
  · MOIRAI 时序检测（任何传感器数据都适用）

需要按行业定制的部分：
  · L0/L1 知识库（行业标准不同）
  · 设备类型库（3D 模型和 AAS Schema）
  · 物理仿真网络（不同介质）
  · 报告模板（不同合规要求）
  · 销售话术和 ROI 计算器

结论：80% 复用，20% 行业定制
       = 「行业知识包（Industry Pack）」商业模式
```

### 2.2 四个高度适配的行业垂直

---

**垂直 1：化工流程（最优先扩展）**

```
市场规模：
  · 中国化工企业 > 30,000 家
  · 危化品重大危险源 > 40,000 处（政策强制监管）
  · 每年安全事故（爆炸/泄漏）直接损失 > ¥100 亿

与我们的相似度：★★★★★
  · P&ID 完全相同（同样的阀门/换热器/泵/仪表）
  · OPC UA 数据结构完全相同
  · 工单管理逻辑完全相同
  · 3D 数字孪生需求相同

差异（需要行业包）：
  · L0 知识：GB 50016（建规）、GB 50085（化工管道）、GBZ/T（职业卫生）
  · 设备类型：反应器、精馏塔、热交换器、搅拌器
  · 物理仿真：化学反应动力学（OpenFOAM + Cantera）
  · 特殊合规：HAZOP 分析报告（工艺危害分析）、SIS 系统完整性

AI 特殊价值：
  · HAZOP 辅助（AI 自动生成「偏差-后果-措施」分析）
  · 工艺参数异常 → AI 判断是否影响产品质量
  · 泄漏扩散预测（pandapipes 扩展 + 毒性模型）

切入时机：化工安全监管 2025 年强化，市场需求急迫
```

---

**垂直 2：电力（热电/燃气电厂）**

```
市场规模：
  · 中国燃气电厂 > 600 座（共约 1.1 亿千瓦）
  · 热电联产机组 > 4,000 台
  · 电力设备运维市场 > ¥3,000 亿/年

与我们的相似度：★★★★☆
  · OPC UA 数据接入（IEC 61850 还需额外适配）
  · 设备层面类似（汽轮机 ≈ 压缩机，锅炉 ≈ 换热器）
  · 工单管理完全相同
  · 3D 数字孪生需求更强（机组价值高）

差异（行业包）：
  · L0 知识：DL（电力行业标准）、GB/T 7064（透平机组）
  · 物理仿真：热力循环（效率优化）、汽轮机振动（叶片）
  · 特殊设备：锅炉（压力容器监检）、发电机（电气设备）
  · 数据接入：除 OPC UA 还需 IEC 61850（变电站）

AI 特殊价值：
  · 汽轮机热耗率优化（物理代理模型，节能 2-5%）
  · 锅炉燃烧优化（减少 NOx 排放，满足碳合规）
  · 机网协调（电力调度 → 机组响应优化）

合作路径：与电力设计院（如中国电力工程顾问集团）合作切入
```

---

**垂直 3：LNG 接收站（最高价值单客户）**

```
市场规模：
  · 中国 LNG 接收站 > 25 座（仍在快速增长）
  · 单座接收站投资 > ¥100 亿
  · 运维复杂度极高（低温 / 高压 / 多种设备）

与我们的相似度：★★★★★
  · 完全属于油气行业（知识体系直接复用）
  · P&ID 类型相同（阀门/泵/仪表/换热器）
  · 同样需要无人值守/少人值守

差异（行业包）：
  · L0 知识：GB 51156（LNG 接收站技术规范）
  · 设备特殊：BOG 压缩机（低温）、LNG 储罐（大型低温容器）
  · 物理仿真：LNG 气化过程、BOG 产生量预测（需要热力学）
  · 温度范围：-162°C（储罐）→ 常温，需要特殊材质处理

AI 特殊价值：
  · BOG 量预测（减少 BOG 放散，直接节能）
  · 气化外输优化（匹配下游需求，减少库存积压）
  · 储罐液位管理（多储罐协调调度）

战略价值：单客户年费可达 ¥150-300 万，只需 5 个客户就是千万 ARR
```

---

**垂直 4：市政供排水（最大市场体量）**

```
市场规模：
  · 中国城市供水管网总长 > 100 万公里
  · 污水处理厂 > 7,000 座
  · 供水厂 > 5,000 座

与我们的相似度：★★★☆☆
  · 设备层面类似（泵/阀门/仪表）
  · OPC UA 数据接入相同
  · 工单管理相同
  · 3D 数字孪生需求增长（城市 GIS 整合）

核心差异：
  · 介质：液体（水），物理仿真用 EPANET（EPA 开源，专为水网络）
  · L0 知识：GB 50013（室外给水规范）、CJ（城镇供水行业标准）
  · 特殊需求：GIS 集成（管网空间数据）、水质监测
  · 客户类型：地方政府/国有水务公司（采购逻辑不同）

AI 特殊价值：
  · 供水管网漏损检测（无人机 + MOIRAI 分析夜间最小流量）
  · 泵站调度优化（低谷电价 + 供水需求预测）
  · 水质预警（多参数监测 → 污染源溯源）

进入时机：第 3 垂直，在油气/化工稳定后扩展
          需要 GIS（Mapbox/高德）集成模块
```

---

### 2.3 行业扩展的「知识包」产品模式

```
产品架构（最终形态）：

ClawTwin Platform（核心平台，一次开发）
  ├── Industry Pack: Oil & Gas Pipeline（已开发）
  │     ├── L0-L1 知识库（GB 50251/50253/SY/T 标准集）
  │     ├── 设备类型库（压缩机/调压阀/计量仪表 3D 模型）
  │     ├── pandapipes 天然气管网仿真包
  │     └── GB 32167 合规报告模板
  │
  ├── Industry Pack: Chemical Process（优先开发）
  │     ├── L0-L1 知识库（GB 50016/50085/GBZ 标准集）
  │     ├── 设备类型库（反应器/精馏塔/换热器 3D 模型）
  │     ├── Cantera 化学反应仿真包
  │     └── HAZOP 报告模板
  │
  ├── Industry Pack: Power Generation（第三开发）
  │     ├── L0-L1 知识库（DL 标准集）
  │     ├── 设备类型库（汽轮机/锅炉/发电机）
  │     ├── 热力循环仿真包（OpenModelica）
  │     └── 电力设备预防性试验报告模板
  │
  └── Industry Pack: Water Utilities（未来）
        ├── L0-L1 知识库（GB 50013/CJ 标准集）
        ├── 设备类型库（水泵/调节阀/水质仪表）
        ├── EPANET 水网络仿真包
        └── 供水漏损报告模板

定价策略：
  Platform 授权：¥ 15 万/年（基础）
  Industry Pack：¥ 5-10 万/年（每个垂直）
  → 深度客户：Platform + 2 个 Pack = ¥25 万/年起
```

---

## 三、最终产品组合（可以卖的东西）

### 3.1 产品全景图

```
┌─────────────────────────────────────────────────────────────────────┐
│                       ClawTwin 产品家族                              │
├──────────────────┬──────────────────┬───────────────────────────────┤
│   终端产品        │   平台产品        │         服务产品              │
├──────────────────┼──────────────────┼───────────────────────────────┤
│ Studio（运维台）  │ Platform Core    │ S1 知识工程（建库）            │
│ Command（大屏）  │ Industry Packs   │ S2 数字样机（建模）            │
│ Mobile（飞书）   │ API Gateway      │ S3 OPC UA 接入                │
│ Edge（离网版）   │ Sim Engine       │ S4 系统集成（CMMS/SAP）        │
│                  │                  │ S5 领域模型微调                │
└──────────────────┴──────────────────┴───────────────────────────────┘
```

### 3.2 产品详细定义

**① ClawTwin Platform Core（基础平台）**

```
本质：所有产品的底层基础设施
技术：11 个 Docker 服务（详见 FINAL_ARCHITECTURE.md）
内容：
  · 知识图谱引擎（GraphRAG + Milvus L0-L3）
  · 数字孪生运行时（Eclipse Ditto）
  · AI 推理编排（OpenClaw + Qwen3.6 vLLM）
  · 时序异常检测（MOIRAI 2.0）
  · 数据总线（Kafka + OPC UA bridge）
  · 对象存储（MinIO）
  · 统一数据库（PostgreSQL + TimescaleDB）

交付：Docker Compose + 配置向导 + 运维文档
定价：¥12 万/年（含基础运维支持）
适用：所有行业（行业无关层）
```

**② ClawTwin Studio（PC 运维控制台）**

```
本质：工程师的日常作战室
界面：三列布局（AI 对话 + 3D 视口 + 数据面板）
核心功能：
  · Babylon.js 8 WebGPU 3D 场景（HDRI + OpenPBR + 粒子流）
  · 实时 Ditto 状态叠加（颜色 + 测点标签）
  · LOD 0-3 视图切换（全站 → 螺栓级）
  · P&ID / 3D 联动视图
  · AI 对话（RAG + citations + 工单生成）
  · 时间轴回放（历史状态）
  · What-if 仿真面板（Phase 2）
  · 设备数字护照（AAS Shell 展示）

适用：运维工程师、设备工程师
定价：¥3 万/用户/年 或 ¥15 万/场站/年（不限用户）
平台：Web（Chrome/Edge，WebGPU 必需）
```

**③ ClawTwin Command（指挥大屏）**

```
本质：场站/调度中心的可视化墙
界面：全屏 3D + 实时 KPI + AI 摘要栏
核心功能：
  · 最高质量 3D 渲染（路径追踪模式，适合 RTX 显卡）
  · 天然气/介质流动粒子可视化
  · 温度/压力热场叠加
  · 告警 → 3D 自动飞行 + 特效标注
  · AI 24h 值班日志（右侧滚动）
  · 一键跳转 Studio 深链
  · 触摸屏/鼠标交互

适用：调度指挥中心、客户汇报演示
定价：¥18 万/套（一次性硬件 + 软件授权 + 安装）
平台：Web（RTX 显卡推荐，否则降级渲染）
```

**④ ClawTwin Mobile（飞书 AI 助手）**

```
本质：工程师的掌上 AI 同事
界面：飞书卡片 + 对话 + 审批
核心功能：
  · 每天 06:00 AI 晨报（自动生成推送）
  · 异常实时推送（含 3D 截图缩略图 + 深链）
  · 工单审批卡片（一键批准/修改/拒绝）
  · 语音/文字查询（「SDV-001 上次检修什么时候？」）
  · 铭牌拍照 → AI 自动识别录入台账
  · 现场手册查询（「这台阀门怎么手动操作？」）

适用：场站主管、值班工程师、维修班组
定价：包含在 Platform 或 Studio 订阅中
平台：飞书（手机 App + 电脑 App）
```

**⑤ ClawTwin Sim（物理仿真引擎，Phase 2）**

```
本质：工业大脑的「想象力」——能预演后果
技术：pandapipes 代理训练 + FNO + 嵌入推理引擎
核心功能：
  · What-if 操作仿真（关阀/开阀/调压 → 后果预测）
  · 压力瞬变预测（水锤/气锤风险评估）
  · 管网流量分配优化（多线路调度建议）
  · 压缩机运行点可视化（效率 + 喘振余度）
  · 设备 RUL 预测（结合物理 + MOIRAI 时序）

适用：高级用户（生产计划部门、工艺工程师）
定价：¥10 万/年（附加模块）
价值：「在数字世界操作，不用担心真实设备」
```

**⑥ ClawTwin Edge（离网版，Phase 3）**

```
本质：边远场站的完整 AI 大脑
技术：7B 领域小模型（Qwen 微调）+ 轻量 Ditto + SQLite
部署：NVIDIA Jetson Orin NX（16GB）或 RTX 4090 工控机
核心功能（离网运行）：
  · 本地 LLM 推理（无需公网）
  · 本地知识库检索（Milvus lite）
  · 本地 OPC UA 接入（asyncua 直连）
  · 本地 MOIRAI 检测
  · 定期与 Command Center 同步（有网时）

适用：山区/海岛/沙漠等无公网场站
定价：¥8 万/年 + 硬件（一次性 ¥3-8 万）
```

**⑦ ClawTwin API（数据接口平台）**

```
本质：让第三方系统调用我们的 AI 能力
接口：
  GET  /v1/assets/{id}          设备数字档案（含 AAS）
  GET  /v1/twins/{id}/state     实时 Ditto 状态
  POST /v1/ai/analyze           AI 分析（返回 citations）
  POST /v1/ai/simulate          物理仿真（Phase 2）
  POST /v1/workorders           工单创建
  WS   /v1/events               告警实时推流

适用：SAP/Maximo 集成、SCADA 集成、第三方开发
定价：¥20 万/年（含 API 调用量）
```

### 3.3 产品边界（我们不做什么）

```
❌ 我们不做 SCADA / DCS（自控系统，这是西门子/罗克韦尔的领地）
   我们是 SCADA 的「AI 大脑」，SCADA 是我们的数据源

❌ 我们不做 ERP / SAP（企业资源管理，这是 SAP 的领地）
   我们生成工单草案，工单执行在 SAP/Maximo 里

❌ 我们不做 OT 安全产品（防火墙/IDS，这是工控安全公司的领地）
   我们通过标准的单向数据接入，不进入 OT 安全范畴

❌ 我们不做工程设计工具（P&ID 绘图，这是 AVEVA/Bentley 的领地）
   我们消费 P&ID，不创建 P&ID

❌ 我们不自研 LLM 基础模型（太贵，Qwen3.6 已经够好）
   我们做领域微调（LoRA），不做预训练

✅ 我们做的核心：
   AI 推理编排 + 工业知识图谱 + 3D 数字孪生可视化 + 工单 HITL 闭环
   = 工业场站的「AI 大脑 + 数字眼睛 + 执行助手」
```

---

## 四、开发路线图（准备开始！）

### 4.1 总体时间线

```
2026 Q2（12周）· Phase A：点火
  里程碑：1 个真实客户看到「AI 晨报 + 3D 场景 + 工单审批」

2026 Q3-Q4（16周）· Phase B：起飞
  里程碑：3 个付费客户，真实 OPC UA，视觉旗舰，物理仿真

2027 Q1-Q2（12周）· Phase C：垂直扩展
  里程碑：化工行业包上线，ARR ¥300 万+

2027 Q3-Q4 · Phase D：智能跃升
  里程碑：领域模型微调，AR 眼镜 MVP，数据飞轮验证

2028 · Phase E：平台化
  里程碑：API 平台开放，3 个行业垂直，ARR ¥1000 万+
```

### 4.2 Phase A 详细任务（接下来 12 周）

```
Week 1-2：基础设施搭建
─────────────────────────────────────
□ 服务器准备
  · 1×H100 80G GPU 服务器（或 A100）
  · 32GB RAM，1TB NVMe SSD
  · 安装 Docker + NVIDIA Container Toolkit

□ Docker Compose 11 服务启动
  · 参考 FINAL_ARCHITECTURE.md 的服务清单
  · 启动 profiles: mock（mock OPC UA）
  · 验证：所有服务健康，端口可访问

□ Qwen3.6-35B-A3B vLLM 服务
  · 下载模型权重（modelscope.cn）
  · 配置 INT4 量化（约 20GB VRAM）
  · 验证：OpenAI 兼容 API，响应时间 < 3s

Week 3-4：3D 场景搭建
─────────────────────────────────────
□ Babylon.js 8 WebGPU 基础场景
  · 安装 polyhaven HDRI：industrial_workshop_foundry_4k
  · 实现 LOD 0（全站概览，发光图标）
  · 实现 LOD 2（设备 PBR 材质，ambientCG Metal047）
  · 实现 LOD 3（法兰爆炸视图，8 颗螺栓动画）
  · 实现天然气粒子流动（ParticleSystem）
  · 实现设备状态光晕（GlowLayer）

□ station-data.json 加载
  · 解析 equipment_id → 3D 位置映射
  · 实现 3D 点击 → 侧边栏信息联动
  · 实现 deep link（URL hash → 3D 飞行）

Week 5-6：知识库建立
─────────────────────────────────────
□ L0-L2 知识摄入（管道场站）
  · 下载并整理标准 PDF（GB 50251, SY/T 6883 等）
  · 批量 pymupdf 提取文本 + 分块（LlamaIndex）
  · 向量化存入 Milvus（按层级标注 L0/L1/L2）
  · 下载 Emerson/E+H OEM 手册 → L2 知识库
  · GraphRAG 摄入（提取设备关系知识图谱）

□ RAG 测试（黄金测试集）
  · 准备 20 个问答对（已知答案）
  · 测试命中率和 citations 准确度
  · 目标：Top-3 召回率 > 85%

Week 7-8：OpenClaw 技能配置
─────────────────────────────────────
□ 工业 AI 工具注册（白名单）
  · twin_read → Ditto REST API
  · kb_search → Milvus + GraphRAG
  · asset_read → station-data.json API
  · history_read → PostgreSQL TimescaleDB
  · wo_draft → 工单草案 JSON 生成器

□ 三个常驻 Agent 配置
  · 感知 Agent（Cron: */30min）
  · 分析 Agent（Webhook 触发）
  · 工单 Agent（TaskFlow HITL）

□ MOIRAI 2.0 服务部署
  · 安装 uni2ts（pip install）
  · 封装 FastAPI 服务
  · 接入 Kafka 消费（异常分数 → 感知 Agent）

Week 9-10：飞书集成
─────────────────────────────────────
□ AI 晨报（06:00 CST）
  · OpenClaw Cron 配置（每天 06:00）
  · 晨报 Prompt 模板（含今日异常 + 待处理工单 + 健康建议）
  · 飞书群推送（含 3D 场站状态截图）
  · 测试：连续 3 天自动推送

□ 工单 HITL 飞书卡片
  · 审批卡片模板（设备/症状/步骤/citations/按钮）
  · TaskFlow setWaiting → 飞书 webhook → resume
  · 一键批准/修改/拒绝流程测试

Week 11-12：集成测试 + 客户演示准备
─────────────────────────────────────
□ 端到端流程测试
  · 模拟异常数据 → MOIRAI 检测 → 分析 Agent → 飞书推送 → 工单审批
  · 全链路时间 < 60s（从异常注入到飞书卡片）
  · 3D 场景实时响应（异常 → 颜色变化 + 自动飞行）

□ Demo 视频录制（5 分钟）
  · 五个震撼时刻（见 VISION_METAVERSE_INDUSTRY40.md）
  · 旁白脚本 + 字幕
  · 客户演示 PPT（10 页）

□ 第一个 POC 客户启动
  · 目标：城燃公司或地方管网（非三大央企）
  · 交付：2 周内 mock 版 Studio 上线
  · 里程碑：客户亲口说「想要这个」
```

### 4.3 关键技术决策（已锁定，不再改变）

```
3D 引擎：       Babylon.js 8 WebGPU（所有端统一，不用 Three.js/UE）
LLM：           Qwen3.6-35B-A3B（vLLM INT4，本地）
时序模型：       MOIRAI 2.0（Salesforce，零样本，Apache 2.0）
向量数据库：     Milvus 2.5（不用 pgvector，直接用最终选型）
孪生运行时：     Eclipse Ditto 3.7（Day 1 就部署）
消息总线：       Apache Kafka 3.7
RAG 框架：       LlamaIndex 0.12（orchestration）+ GraphRAG v3.0.9（知识图谱）
管网仿真：       pandapipes（Phase 2，不用 OpenFOAM）
代理模型：       FNO（neuraloperator，MIT）
工作流：         OpenClaw Cron + TaskFlow（不用 LangGraph）
数据库：         PostgreSQL 16 + TimescaleDB
移动端：         飞书（不另开发 App）
部署：           Docker Compose（11 服务，profiles 切换 mock/real）
```

---

## 五、核心价值资产的积累路径

```
现在建立（0-12 个月）：
  ✅ equipment_id 主线（所有系统的灵魂）
  ✅ 工业知识图谱（L0-L3 分层，oil & gas 行业包）
  ✅ 3D 场景参数化生成能力（P&ID → 3D 自动化）
  ✅ AI 工单标注格式（数据飞轮的原材料格式）
  ✅ pandapipes 管网仿真基准模型（物理正确的数字孪生）

12-24 个月积累：
  ⏳ 50,000 条工业工单标注数据（10 客户 × 18 个月）
  ⏳ Qwen3.6 LoRA 领域微调 v1（油气场站版）
  ⏳ 设备健康预测数据集（实测 + 仿真结合）
  ⏳ 化工行业知识包（第二垂直）
  ⏳ pandapipes 客户校准模型（每个客户场站专属）

3 年积累（护城河形成）：
  🔒 100,000 条高质量工业标注数据（无法复制）
  🔒 Qwen3.6 垂直领域精调版（比通用强 30%+）
  🔒 覆盖 3 个行业垂直的知识图谱
  🔒 20 个客户场站的数字孪生资产（不可迁移）
  🔒 AR 眼镜 + 机器人接入能力（硬件入口）
```

---

## 六、这个方案是否理想？自我批判

```
确认「理想」的标准：

✅ 技术路线清晰：每个组件都有成熟开源实现，无需发明
✅ 架构一次决定：11 个 Docker 服务，phases 只改配置
✅ 物理仿真有路：pandapipes → FNO，不需要 HPC 集群
✅ 垂直扩展有路：80% 复用，20% 行业包，可快速复制
✅ 护城河清晰：数据 > 知识图谱 > 垂直模型 > 迁移成本
✅ 用户价值可量化：防损 ¥ / 工时节省 / 合规证据
✅ 面向未来：AR/机器人接口预留，equipment_id 贯穿

确认「可落地」的标准：

✅ 第 1 天就能 docker compose up（11 服务，mock 数据）
✅ 第 2 周就能给客户看到 3D 场景 + AI 晨报
✅ 第 12 周就能走完完整 HITL 工单闭环
✅ 预算估算合理：服务器 ¥60 万 + 12 个月人力 ¥120 万 = ¥180 万
   = 2 个付费客户就能回收

未解决的风险（正视，不回避）：

⚠️ 销售周期：油气 B2B 客户决策慢，需要提前建关系
   应对：先免费 POC，用数据说话

⚠️ OT 接入：第一个真实 OPC UA 桥接可能遇到意外
   应对：Phase A 全用 mock，Phase B 才接真实 OPC UA

⚠️ AI 幻觉风险：在安全关键场景，AI 说错可能危险
   应对：citations 强制 + HITL 永不绕过 + 低置信度不推送

结论：这是目前技术条件下最优的方案。
     不是最完美的，但是最可执行的。
     从明天开始。
```

---

_本文档整合了：物理仿真开源工具链分析 + 行业垂直扩展评估 + 最终产品组合定义 + Phase A 12 周详细任务 + 核心价值资产积累路径_  
_上游文档：INDUSTRIAL_BRAIN_MASTER · FINAL_ARCHITECTURE · TECH_DECISIONS · STRATEGIC_REVIEW_INVESTOR_USER · VISION_METAVERSE_INDUSTRY40_
