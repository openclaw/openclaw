# FinClaw Commons 机制全景分析

> 基于 openFinclaw 源码深度探索
> 更新：2026-03-03

---

## 一、30 秒概览

Commons = **金融 Skill 的"应用商店"**，提供完整的生命周期管理：

```
发布（publish）→ 注册（index.json）→ 评分（FCS）→ 分发（install）→ 退化/归档
```

不只是简单的文件复制，而是带 **质量评分 + 生命周期管理 + 反作弊 + 仪表盘** 的完整生态系统。

---

## 二、目录结构

```
commons/
├── index.json                    ← 注册表（所有条目的清单）
├── skills/                       ← Skill 源文件
│   ├── fin-dca-strategy/
│   │   └── SKILL.md
│   ├── fin-backtest/
│   ├── fin-strategy-builder/
│   └── ...（20 个金融 Skills）
├── templates/                    ← Workspace 模板
│   └── finclaw-starter/
│       ├── README.md
│       ├── openclaw.json
│       └── skills.json
├── fcs/                          ← FCS 评分系统
│   ├── config.json               ← 评分权重 & 阈值配置
│   ├── scores.json               ← 当前所有条目的评分
│   ├── authors.json              ← 作者声誉数据
│   └── history/
│       └── 2026-02.jsonl         ← 月度评分变更日志（追加写入）
├── dashboard/                    ← 仪表盘生成器
│   ├── generator.ts
│   ├── template.html
│   └── assets/style.css
└── site/                         ← 生成的静态仪表盘
    ├── index.html
    └── data.json
```

---

## 三、Registry（注册表）

### 3.1 index.json 结构

```json
{
  "version": 1,
  "entries": [
    {
      "id": "fin-dca-strategy",
      "name": "DCA Strategy Assistant",
      "type": "skill",
      "description": "Dollar-cost averaging strategy...",
      "version": "1.0.0",
      "author": "finclaw-commons",
      "tags": ["finance", "investment", "dca", "strategy"],
      "path": "skills/fin-dca-strategy",
      "createdAt": "2026-02-24T00:00:00Z",
      "updatedAt": "2026-02-24T00:00:00Z"
    }
  ]
}
```

### 3.2 支持 7 种条目类型

| 类型 | 用途 |
|------|------|
| `skill` | AI 技能包（SKILL.md + 可选脚本） |
| `strategy` | 交易策略（FEP 包） |
| `connector` | 数据/交易所连接器 |
| `persona` | Agent 人设 |
| `workspace` | 工作空间模板 |
| `knowledge-pack` | 知识包 |
| `compliance-ruleset` | 合规规则集 |

### 3.3 注册表 API

```typescript
loadCommonsIndex()           // 加载 index.json
listEntries(index, type?)    // 按类型过滤
searchEntries(index, query)  // 模糊搜索（id, name, description, tags）
findEntry(index, id)         // 精确查找
loadCommonsIndexWithFcs()    // 加载注册表 + 合并 FCS 评分
```

---

## 四、Publish / Install（发布 / 安装）

### 4.1 发布流程

```
openfinclaw commons publish ./my-strategy --type strategy
  │
  ├─ 读取 SKILL.md frontmatter（name, description, tags）
  ├─ 构建 CommonsEntry 元数据
  ├─ 复制文件到 commons/<type>s/<id>/
  ├─ 更新 commons/index.json（新增或更新条目）
  ├─ 自动计算初始 FCS 评分
  │   └─ 初始分 ≈ 15（只有 freshness 有分）
  ├─ 创建生命周期：seedling / active
  └─ 追加历史记录到 fcs/history/YYYY-MM.jsonl
```

### 4.2 安装流程

```
openfinclaw commons install fin-strategy-builder
  │
  ├─ 从 index.json 查找条目
  ├─ 确认源路径存在（commons/skills/fin-strategy-builder/）
  ├─ 复制到目标目录
  │   ├─ skill → ./skills/<id>/
  │   └─ workspace → ./（直接展开模板）
  ├─ 检测是否已存在（alreadyExisted 标志）
  └─ 输出安装路径
```

安装后 Skill 变成 **openclaw-bundled** 来源，可在 `skills list` 中看到。

---

## 五、FCS 评分系统（核心机制）

### 5.1 什么是 FCS？

**FCS = FinClaw Commons Score**，一个 0-100 的综合质量分数，由四个维度加权计算：

```
FCS = Quality × 35% + Usage × 30% + Social × 20% + Freshness × 15%
```

### 5.2 四维评分详解

#### Quality（质量分，0-100）

**通用质量**（适用所有类型）：

| 指标 | 权重 | 说明 |
|------|------|------|
| hasTests | 25% | 有测试用例 |
| hasDocumentation | 25% | 有文档 |
| hasCIPassedRecently | 20% | CI 最近通过 |
| lintScore | 15% | Lint 评分 0-100 |
| typeCheckPasses | 15% | 类型检查通过 |

**Strategy 类型加权**（质量权重 45%）：

| 指标 | 权重 | 计算 |
|------|------|------|
| Sharpe Ratio | 40% | clamp(ratio/2.0, 0, 1) |
| Max Drawdown | 30% | clamp(1 - maxDD/50, 0, 1) |
| Win Rate | 15% | clamp(winRate/100, 0, 1) |
| 通用质量 | 15% | 上述通用公式 |

**Connector 类型加权**（质量权重 40%）：

| 指标 | 权重 | 计算 |
|------|------|------|
| Uptime | 40% | clamp(uptime/100, 0, 1) |
| Latency | 25% | clamp(1 - latency/2000, 0, 1) |
| Error Rate | 20% | clamp(1 - errorRate, 0, 1) |
| 通用质量 | 15% | 上述通用公式 |

#### Usage（使用量分，0-100）

| 指标 | 权重 | 满分条件 |
|------|------|---------|
| installCount | 40% | ≥ 100 次安装 |
| activeInstalls30d | 30% | ≥ 50 个活跃安装 |
| invocationCount30d | 30% | ≥ 500 次调用 |

#### Social（社区分，0-100）

| 指标 | 权重 | 满分条件 |
|------|------|---------|
| starCount | 30% | ≥ 50 颗星 |
| forkCount | 20% | ≥ 20 个 fork |
| reviewCount | 20% | ≥ 10 条评论 |
| averageRating | 30% | 5.0 分 |

#### Freshness（新鲜度分，0-100）

**指数衰减**：

```
decay = exp((-ln(2) × daysSinceUpdate) / halfLifeDays)
freshness = decay × 100
```

- 半衰期：90 天（可配置）
- 刚发布：100 分
- 90 天后：50 分
- 180 天后：25 分
- 360 天后：6 分

### 5.3 类型特化权重

| 维度 | 默认 | Strategy | Connector |
|------|------|----------|-----------|
| Quality | 35% | **45%** | **40%** |
| Usage | 30% | **20%** | 30% |
| Social | 20% | **15%** | **10%** |
| Freshness | 15% | **20%** | **20%** |

策略类型更看重质量（回测表现），连接器更看重可靠性。

### 5.4 反作弊机制

```json
{
  "antiGaming": {
    "maxDailyScoreChange": 5,     // 24h 内最多变化 ±5 分
    "installVelocityCap": 50,     // 日安装上限
    "minUniqueInstallers": 3      // 最少独立安装者
  }
}
```

- 24 小时内评分变化不超过 ±5 分（防止刷分）
- 超过 24 小时重新计算不受限制

---

## 六、Lifecycle 生命周期系统

### 6.1 状态机

```
               FCS ≥ 30          FCS ≥ 65
  seedling ──────────→ growing ──────────→ established
  (种子期)              (成长期)              (成熟期)
     │                    │                    │
     │  FCS < 20 或       │  FCS < 20 或       │  FCS < 20 或
     │  类型特定信号       │  类型特定信号       │  类型特定信号
     ▼                    ▼                    ▼
  degrading ←──────── degrading ←──────── degrading
  (退化中)              (退化中)              (退化中)
     │                                        ↑
     │  90天无恢复                    FCS ≥ 30 恢复
     ▼                              (回到 active)
  archived
  (已归档)

  手动操作:
  任意状态 ──delist──→ delisted (下架)
  delisted ──restore──→ seedling/active (恢复，需 FCS ≥ 30)
```

### 6.2 类型特定退化信号

| 类型 | 退化触发条件 |
|------|-------------|
| **Strategy** | Sharpe < 0 **或** 最大回撤 > 50% **或** 180天无回测更新 |
| **Connector** | 可用率 < 80% **或** 错误率 > 10% **或** 30天无健康检查 |
| **Skill** | 90天零调用 **或** 30天零活跃安装 |
| **Knowledge-Pack** | 365天未更新 |
| **Compliance-Ruleset** | 365天未更新 |
| **Persona/Workspace** | 180天无活跃安装且无使用 |

### 6.3 关键阈值

```json
{
  "lifecycle": {
    "seedlingToGrowingThreshold": 30,    // FCS ≥ 30 → 升级到 growing
    "growingToEstablishedThreshold": 65,  // FCS ≥ 65 → 升级到 established
    "degradationThreshold": 20,          // FCS < 20 → 触发退化
    "archivalGracePeriodDays": 90        // 退化 90 天无恢复 → 归档
  }
}
```

---

## 七、Author Reputation（作者声誉）

```typescript
AuthorReputation {
  authorId: string;
  totalEntries: number;        // 发布总数
  averageFcs: number;          // 平均 FCS 分数
  establishedCount: number;    // established 级条目数
  memberSince: string;         // 最早发布时间
  verified: boolean;           // 是否认证（当前默认 false）
}
```

存储在 `commons/fcs/authors.json`。

---

## 八、Dashboard（仪表盘）

### 8.1 CLI Dashboard

```bash
openfinclaw commons dashboard
```

输出：
- 七维度条形图（skill, strategy, connector 等条目数）
- 生命周期分布（seedling / growing / established 计数）
- 贡献者排行榜（排名、条目数、平均 FCS、主力维度）
- 近期活动（最新 10 个条目）

### 8.2 静态网站 Dashboard

```bash
openfinclaw commons build-site --open
```

生成 `commons/site/index.html`：
- 自包含 HTML（内联 CSS，Chart.js CDN）
- 雷达图（7 个维度）
- 维度卡片（含 tier 计数）
- 贡献者排行表
- 条目浏览器（类型/tier/搜索过滤）
- 增长时间线
- 策略绩效表（条件显示）

### 8.3 Markdown 报告

```bash
openfinclaw commons generate-report --output report.md --badges
```

生成完整 Markdown 文档，含 shields.io 徽章、表格、统计数据。

---

## 九、完整 CLI 命令矩阵

| 命令 | 功能 | 关键选项 |
|------|------|---------|
| `commons list` | 列出所有条目 | `--type`, `--sort fcs`, `--tier`, `--json` |
| `commons search <query>` | 模糊搜索 | `--json` |
| `commons info <id>` | 条目详情 | `--json` |
| `commons install <id>` | 安装到本地 | `--dir`, `--json` |
| `commons publish <path>` | 发布到注册表 | `--type`, `--id`, `--author`, `--json` |
| `commons score <id>` | FCS 评分详情 | `--history`, `--json` |
| `commons lifecycle <id>` | 生命周期状态 | `--json` |
| `commons fcs recalculate` | 重算 FCS 分数 | `--entry <id>`, `--dry-run` |
| `commons delist <id>` | 紧急下架 | `--reason`, `--restore` |
| `commons dashboard` | CLI 仪表盘 | `--compact`, `--json` |
| `commons generate-report` | Markdown 报告 | `--output`, `--badges` |
| `commons build-site` | 静态网站 | `--output`, `--open` |

---

## 十、数据流全景

### 10.1 发布 → 评分 → 分发 → 退化 闭环

```
开发者
  │
  │ commons publish ./my-skill
  ▼
index.json 注册
  │
  ├─ 初始 FCS ≈ 15（只有 freshness）
  ├─ 生命周期：seedling / active
  └─ 追加 history/YYYY-MM.jsonl
  │
  │ 时间推移 + 用户使用
  ▼
FCS 重算（手动或定时）
  │
  ├─ Quality: 有测试? 有文档? 回测 Sharpe?
  ├─ Usage: 安装量? 活跃安装? 调用量?
  ├─ Social: Star? Fork? 评论? 评分?
  ├─ Freshness: 最后更新距今多久?
  ├─ 反作弊: 24h 变化 ≤ ±5 分
  └─ 合成 FCS = Σ(dimension × weight)
  │
  ├─ FCS ≥ 30 → 升级 growing
  ├─ FCS ≥ 65 → 升级 established
  ├─ FCS < 20 → 触发 degrading
  └─ degrading 90天 → archived
  │
  │ 用户
  ▼
commons install <id>
  │
  └─ 复制到 skills/<id>/ → 出现在 skills list
```

### 10.2 FCS 评分可视化

```
                    FCS Score: 72.3 ████████████████████████████████████░░░░░░░░░░░

                    Breakdown:
                    Quality:   85.0 ██████████████████████████████████████████████░░░░
                    Usage:     65.2 █████████████████████████████████░░░░░░░░░░░░░░░░░
                    Social:    55.0 ████████████████████████████░░░░░░░░░░░░░░░░░░░░░░
                    Freshness: 92.1 ██████████████████████████████████████████████████░

                    Lifecycle: 🌿 established / active
```

---

## 十一、设计哲学

| 原则 | 体现 |
|------|------|
| **CLI-First** | 所有操作通过命令行，支持 `--json` 机器消费 |
| **类型感知** | Strategy 看 Sharpe，Connector 看 Uptime，不一刀切 |
| **时间衰减** | 90 天半衰期，鼓励持续维护 |
| **反作弊** | 日变化上限 ±5 分，防止刷分 |
| **追加写入** | history/ 月度 JSONL 不可变，完整审计 |
| **优雅降级** | scores.json 不存在时返回空结构，不崩溃 |
| **Zod 校验** | 所有文件 I/O 严格 Schema 验证 |
| **手动兜底** | delist/restore 人工介入，覆盖自动化 |
| **自包含** | 生成的仪表盘网站零外部依赖（除 Chart.js CDN） |
