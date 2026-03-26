# 类人记忆架构设计方案

**日期**: 2026-03-19
**作者**: Claude Code
**状态**: 设计阶段

---

## 第一部分：人类记忆体系核心特点回顾

### 1.1 多层级时间结构

```
┌─────────────────────────────────────────────────────────┐
│                    工作记忆 (Working Memory)            │
│         ~4 chunks, 前额叶皮层, 秒级保持, 主动操作      │
└─────────────────────────────────────────────────────────┘
                           │ 转化 (rehearsal/consolidation)
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    短时记忆 (Short-Term Memory)        │
│              ~7±2 items, 15-30秒, 被动存储             │
└─────────────────────────────────────────────────────────┘
                           │ 巩固 (consolidation)
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    长期记忆 (Long-Term Memory)          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐│
│  │ 情景记忆     │  │ 语义记忆     │  │ 程序记忆     ││
│  │ (Episodic)  │  │ (Semantic)   │  │ (Procedural) ││
│  │ 时空上下文   │  │ 事实概念     │  │ 技能习惯     ││
│  │ 海马体→皮层 │  │ 新皮层分布   │  │ 基底核/小脑  ││
│  └──────────────┘  └──────────────┘  └──────────────┘│
└─────────────────────────────────────────────────────────┘
```

**关键洞察**：人类记忆有明确的**时间层级**，信息从工作记忆流动到短时记忆再到长期记忆。

### 1.2 联想网络模型 (Associative Network)

```
                    ┌─────────┐
                    │  概念A   │───(语义关联)────┌─────────┐
                    └────┬────┘                  │  概念B   │
                         │                        └────┬────┘
                    ┌────┴────┐                      │
                    │ 事件节点 │◄──(时间接近)────┌────────┐
                    └────┬────┘                  │ 事件节点 │
                         │                        └────┬────┘
                    ┌────┴────┐                      │
                    │ 情感标签 │◄──(情感关联)────┐────────┐
                    └─────────┘                  │  概念C   │
                                                └─────────┘
```

**特点**：
- 记忆是**节点**，联想是**边**
- 激活一个节点会**扩散激活**相关节点（spreading activation）
- 边的权重代表关联强度，可以**动态调整**
- **举一反三**：通过共同的更高层抽象节点

### 1.3 互补学习系统 (Complementary Learning Systems)

```
┌─────────────────────────────────────────────────────────────┐
│                    新皮层 (Neocortex)                       │
│         慢速学习、语义知识、分层结构、泛化能力              │
└──────────────────────────┬────────────────────────────────┘
                           │ 系统巩固 (systems consolidation)
    快速学习、情景记忆、      │ (hippocampal replay during sleep)
    情境绑定、一次性学习       ▼
┌─────────────────────────────────────────────────────────────┐
│                    海马体 (Hippocampus)                      │
│         快速绑定、"索引"指向新皮层内容                      │
└─────────────────────────────────────────────────────────────┘
```

### 1.4 主动遗忘机制 (Active Forgetting)

遗忘不是缺陷，而是**自适应优化**：

| 机制 | 描述 | 类比 |
|------|------|------|
| **突触规模调整** | 睡眠期间整体突触减弱，但选择性保留强连接 | 定期清理缓存 |
| **检索诱发遗忘** | 回忆一个记忆时，相关竞争记忆被主动抑制 | 注意力焦点 |
| **重整合更新** | 提取的记忆不稳定，可被修改或削弱 | 原位编辑 |

### 1.5 睡眠期间的记忆优化

睡眠不是被动存储，而是**主动重处理**：
- NREM: 突触规模调整
- REM: 情景记忆整合、情感记忆处理
- 海马体 Replay: 压缩重现近期经历

### 1.6 Schema 驱动的快速泛化 (举一反三)

```
                    ┌─────────────┐
                    │  动物 SCHEMA │
                    └──────┬──────┘
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │     鸟       │ │     鸟       │ │    鸟       │
    └─────────────┘ └─────────────┘ └─────────────┘
                            ▲
                            │ 单一示例就能泛化
                            │
                     ┌─────────────┐
                     │  企鹅 (单次接触)│
                     └─────────────┘
```

---

## 第二部分：当前 OpenClaw 记忆架构的问题诊断

### 问题 1：缺乏记忆层级结构

**人类特点**：工作记忆(4chunks) → 短时 → 长期，三层分流

**当前实现**：
```typescript
// 所有结果等权重，无层级
score = vectorWeight * vectorScore + textWeight * textScore
```

**类比**：像一个只有硬盘、没有内存和 CPU cache 的计算机。

### 问题 2：联想网络薄弱

**人类特点**：记忆是节点+边的图，spreading activation 允许举一反三

**当前实现**：只有向量相似度，没有显式的关联图

**类比**：像一个只有向量数据库、没有图数据库的系统。

### 问题 3：没有主动遗忘机制

**人类特点**：睡眠期间突触规模调整，主动削弱噪音

**当前实现**：
- Temporal decay 是**被动**的（基于时间衰减）
- 没有"记忆强化/削弱"的主动机制
- 没有类比"睡眠整理"的定期优化过程

### 问题 4：缺乏睡眠重整合机制

**人类特点**：睡眠时海马体 replay，压缩重现近期经历

**当前实现**：
- `memory-flush.ts` 只是上下文耗尽前的紧急保存
- 没有"记忆整合"概念
- 没有 offline 优化周期

### 问题 5：没有 Schema 驱动的快速泛化

**人类特点**：Schema 激活后，单个示例快速归类到已有框架

**当前实现**：嵌入向量基于统计相似性，不是 schema 匹配

### 问题 6：冷启动问题

**人类特点**：人类有先天的认知框架（物体恒存、因果关系等）

**当前实现**：新 workspace 从零开始，无内嵌的初始 Schema

### 问题 7：检索即重建的缺失

**人类特点**：记忆提取是重建性的，不是回放

**当前实现**：`search()` 返回固定 snippet，是"读取"而非"重建"

---

## 第三部分：改进建议——类人记忆架构设计

### 架构愿景：从"向量数据库"到"记忆生命体"

```
┌──────────────────────────────────────────────────────────────────┐
│                      类人记忆系统 (Human-like Memory)              │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐│
│  │ Working  │  │ Episodic  │  │ Semantic │  │  Procedural     ││
│  │ Memory   │  │ Memory    │  │ Memory   │  │  Memory         ││
│  │(KV Cache)│  │ (Session) │  │ (Index)  │  │  (Patterns)     ││
│  └─────┬─────┘  └─────┬─────┘  └────┬─────┘  └────────┬────────┘│
│        │               │              │                 │          │
│        └───────────────┴──────────────┴─────────────────┘          │
│                              │                                     │
│                    ┌─────────┴─────────┐                          │
│                    │  Consolidation   │                          │
│                    │  (Sleep-like)     │                          │
│                    │  整合/遗忘/强化    │                          │
│                    └─────────┬─────────┘                          │
│                              │                                     │
│                    ┌─────────┴─────────┐                          │
│                    │  Associative Graph │                          │
│                    │  (跨领域关联网络)  │                          │
│                    └───────────────────┘                          │
└──────────────────────────────────────────────────────────────────┘
```

### 3.1 引入记忆层级 (Memory Hierarchy)

```typescript
// 新的记忆层级类型
type MemoryTier = 'working' | 'short_term' | 'long_term';

interface MemoryEntry {
  id: string;
  tier: MemoryTier;
  content: string;
  embedding: number[];
  salience: number;        // 显著性 (0-1)
  accessCount: number;
  lastAccessed: number;
  createdAt: number;
  // 层级决定保留策略
  // working: 自动淘汰 (token budget)
  // short_term: 基于访问频率
  // long_term: 基于重要性和关联度
}

interface MemoryTierConfig {
  working: {
    maxTokens: number;       // e.g., 128K tokens
    evictionPolicy: 'lru' | 'salience';
  };
  shortTerm: {
    maxEntries: number;      // e.g., 1000 entries
    ttlDays: number;         // e.g., 7 days
    promotionThreshold: number; // 提升到 long_term 的阈值
  };
  longTerm: {
    maxEntries: number;      // e.g., 10000 entries
    decayHalfLifeDays: number;
    consolidationIntervalHours: number;
  };
}
```

**工作流**：

```
Session 消息
    │
    ▼
Working Memory (KV Cache 风格)
    │
    ├─ 访问频繁 → Short-Term Memory
    │
    └─ 重要 + 关联强 → Long-Term Memory (经过 Consolidation)
```

### 3.2 构建联想图谱 (Associative Graph)

```typescript
// 核心关联接口
interface MemoryNode {
  id: string;
  content: string;           // 原始文本
  embedding: number[];       // 向量表示
  schemaType?: string;       // 所属 schema 类型
  salience: number;          // 显著性评分 (0-1)
  accessCount: number;
  lastAccessed: number;
  tier: MemoryTier;
  links: Association[];       // 显式关联边
}

interface Association {
  id: string;
  sourceId: string;
  targetId: string;
  strength: number;          // 关联强度 (0-1)
  type: AssociationType;
  context?: string;          // 为什么关联
  createdAt: number;
}

type AssociationType =
  | 'temporal'      // 时间接近
  | 'semantic'      // 语义相似
  | 'causal'        // 因果关系
  | 'episodic'      // 共同经历
  | 'schema';       // 图式关联

// 传播激活检索
class AssociativeGraph {
  private nodes: Map<string, MemoryNode> = new Map();
  private edges: Map<string, Association> = new Map();
  private adjacencyList: Map<string, Set<string>> = new Map();

  async addNode(node: MemoryNode): Promise<void> { ... }
  async addEdge(edge: Association): Promise<void> { ... }

  async spreadingActivation(
    queryEmbedding: number[],
    options: {
      depth?: number;           // 默认 2
      threshold?: number;       // 默认 0.3
      maxResults?: number;      // 默认 20
    }
  ): Promise<Array<{ node: MemoryNode; activation: number; path: string[] }>> {
    // 1. 找到初始激活节点 (query 嵌入匹配 top-K)
    // 2. 激活沿边扩散
    // 3. 累积激活值 = 初始激活 + 邻居贡献 * 边强度
    // 4. 递归直到深度耗尽或阈值过滤
    // 5. 返回所有节点的最终激活值排序
  }

  async findCrossDomainLinks(
    domainA: string,
    domainB: string
  ): Promise<Array<{ source: MemoryNode; target: MemoryNode; sharedFeatures: string[] }>> {
    // 跨领域关联发现
    // 用于"举一反三"场景
  }
}
```

**跨领域关联示例**：

```
用户问"为什么我总是拖延"
    │
    ├─→ 关联到"习惯养成"(procedural domain)
    │       └─→ "21天习惯" 模式
    │
    ├─→ 关联到"动机心理学"(semantic domain)
    │       └─→ "即时奖励 vs 延迟满足"
    │
    └─→ 关联到"过去的失败经历"(episodic domain)
            └─→ 3个月前说要做但没做的事
```

### 3.3 实现主动遗忘机制

```typescript
// 遗忘策略
interface ForgettingPolicy {
  // 1. 突触规模调整 (类比)
  // 睡眠期间调用，整体削弱所有连接，保留强连接
  synapticScaling(factor?: number): Promise<ForgettingResult>;

  // 2. 检索诱发遗忘
  // 回忆 targetId 时，主动抑制 competitors
  retrievalInducedForgetting(
    targetId: string,
    competitors: string[]
  ): Promise<void>;

  // 3. 噪音过滤
  // 删除: 低 salience + 低 accessCount + 无关联边
  noiseFiltering(options: {
    minSalience?: number;
    minAccessCount?: number;
    maxAgeDays?: number;
  }): Promise<DeletedEntries>;

  // 4. 重整合更新
  // 记忆被提取时，检查是否需要更新关联
  reconsolidate(memoryId: string, updatedContent: string): Promise<void>;
}

interface ForgettingResult {
  deletedCount: number;
  degradedCount: number;
  preservedCount: number;
  duration: number;
}

enum ForgettingTrigger {
  OnSleep = 'sleep',           // 每日睡眠后
  OnThreshold = 'threshold',   // 容量超限时
  OnReconsolidation = 'reconsolidation', // 记忆被提取时
}
```

### 3.4 睡眠重整合 (Sleep Consolidation)

```typescript
// 每日 consolidation 任务
interface ConsolidationTask {
  id: string;
  scheduledAt: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

interface ConsolidationResult {
  // Phase 1: 海马体 Replay
  replayedMemories: string[];

  // Phase 2: 关联建立
  newAssociations: Association[];
  strengthenedAssociations: Array<{ id: string; oldStrength: number; newStrength: number }>;

  // Phase 3: 整合与遗忘
  promotedToLongTerm: string[];    // short_term → long_term
  demotedToDiscard: string[];      // 删除的低价值记忆
  strengthened: string[];          // 强化的高价值记忆

  // Phase 4: Schema 更新
  updatedSchemas: SchemaNode[];
  newPatternsDiscovered: Pattern[];
}

class SleepConsolidationService {
  private graph: AssociativeGraph;
  private config: ConsolidationConfig;

  async run(): Promise<ConsolidationResult> {
    // Phase 1: 海马体 Replay
    // - 选取近期高 salience 的记忆
    // - 按时间顺序重放，发现关联
    const candidates = await this.selectCandidates();

    // Phase 2: 关联建立
    // - 新记忆与已有 semantic memory 匹配
    // - 建立新的 Association 边
    const newLinks = await this.establishLinks(candidates);

    // Phase 3: 整合与遗忘
    // - 高价值记忆强化
    // - 低价值记忆遗忘
    // - 相关 episodic → semantic 转化
    const { promoted, demoted, strengthened } = await this.consolidate(candidates);

    // Phase 4: Schema 更新
    // - 发现新模式，更新 Schema
    // - 跨领域关联建立
    const schemaUpdates = await this.updateSchemas(candidates);

    return {
      replayedMemories: candidates.map(c => c.id),
      newAssociations: newLinks,
      promotedToLongTerm: promoted,
      demotedToDiscard: demoted,
      strengthened,
      updatedSchemas: schemaUpdates,
      newPatternsDiscovered: [],
    };
  }

  private async selectCandidates(): Promise<MemoryNode[]> {
    // 选择近期的高显著性记忆用于 replay
    // 优先选择: 高 salience + 有关联潜力 + 较新
  }

  private async establishLinks(candidates: MemoryNode[]): Promise<Association[]> {
    // 对每对候选记忆检查关联强度
    // 类型: temporal, semantic, causal, schema
  }
}

// 触发时机
enum ConsolidationSchedule {
  Daily = 'daily',           // 每日一次 (建议凌晨 3-4 AM)
  OnIdle = 'on_idle',        // Gateway 空闲时
  OnThreshold = 'on_threshold', // 记忆数量超阈值时
}
```

### 3.5 Schema 驱动的快速泛化

```typescript
// 基础 Schema 定义
const BASE_SCHEMAS: SchemaNode[] = [
  {
    name: 'temporal',
    features: ['时间', '日期', '持续', '频率', '顺序'],
    children: ['event', 'deadline', 'schedule'],
  },
  {
    name: 'spatial',
    features: ['位置', '方向', '距离', '容器', '空间关系'],
    children: ['location', 'navigation'],
  },
  {
    name: 'causal',
    features: ['原因', '结果', '目的', '方式', '手段'],
    children: ['goal', 'method', 'explanation'],
  },
  {
    name: 'social',
    features: ['人', '组织', '关系', '沟通', '互动'],
    children: ['person', 'group', 'conversation'],
  },
  {
    name: 'evaluation',
    features: ['好坏', '重要', '紧急', '难度', '价值'],
    children: ['preference', 'priority', 'quality'],
  },
  {
    name: 'entity',
    features: ['物体', '概念', '实体', '实例'],
    children: ['concept', 'instance', 'category'],
  },
];

interface SchemaNode {
  name: string;
  features: string[];
  parent?: string;       // 层级继承
  children: string[];
  embedding?: number[];  // Schema 级别的嵌入
}

// 编码时自动打 Schema 标签
class SchemaTagger {
  private schemas: Map<string, SchemaNode>;

  async inferSchemas(content: string): Promise<SchemaMatch[]> {
    // 1. 提取 content 的 embedding
    // 2. 与所有 Schema features 计算相似度
    // 3. 返回最相关的 1-3 个 Schema 及匹配度
  }

  async tagMemory(memory: MemoryNode): Promise<MemoryNode> {
    const matches = await this.inferSchemas(memory.content);
    return {
      ...memory,
      schemaType: matches[0]?.schema.name,
      schemaMatches: matches,
    };
  }
}

// 检索时利用 Schema 做抽象推理
class SchemaBased检索 {
  async retrieveWithSchema(
    query: string,
    options: {
      schemaFilter?: string[];   // 只检索特定 schema
      abstractLevel?: 'specific' | 'schema';
    }
  ): Promise<RetrievalResult[]> {
    // 1. 查询 → Schema
    const querySchemas = await this.schemaTagger.inferSchemas(query);

    // 2. Schema → 相关联的所有 episodic 记忆
    const candidates = await this.graph.findBySchema(querySchemas.map(s => s.schema.name));

    // 3. 按关联强度排序返回
    // 允许"找所有和因果关系相关的记忆"
  }
}
```

### 3.6 跨领域关联增强

```typescript
// 意外关联发现
class CrossDomainLinkDiscoverer {
  async discoverLinks(): Promise<CrossDomainLink[]> {
    // 1. 选取两个低关联的 Schema
    const schemaPairs = this.selectLow关联SchemaPairs();

    const links: CrossDomainLink[] = [];

    for (const [domainA, domainB] of schemaPairs) {
      // 2. 在各自域内找高激活记忆
      const memoriesA = await this.graph.findHighActivation(domainA);
      const memoriesB = await this.graph.findHighActivation(domainB);

      // 3. 检查潜在共享特征
      for (const memA of memoriesA) {
        for (const memB of memoriesB) {
          const shared = await this.findSharedFeatures(memA, memB);
          if (shared.length > 0) {
            // 4. 强于阈值则建立新关联
            links.push({
              source: memA,
              target: memB,
              sharedFeatures: shared,
              strength: this.calculateLinkStrength(shared),
            });
          }
        }
      }
    }

    return links;
  }
}

// 使用场景
async function handleDeepQuestion(question: string): Promise<Response> {
  // 用户问"为什么我总是拖延"
  const relatedMemories = await associativeGraph.spreadingActivation(
    embed(question),
    { depth: 3, threshold: 0.2 }
  );

  // 分解关联
  const procedural = relatedMemories.filter(m => m.node.schemaType === 'causal');
  const semantic = relatedMemories.filter(m => m.node.schemaType === 'evaluation');
  const episodic = relatedMemories.filter(m => m.node.schemaType === 'episodic');

  // 构建综合回答
  return {
    answer: buildFromLinks(procedural, semantic, episodic),
    confidence: calculateConfidence(relatedMemories),
    supportingMemories: relatedMemories.slice(0, 5),
  };
}
```

### 3.7 改进的检索为重建

```typescript
// 检索返回记忆重建，而非静态 snippet
interface MemoryRetrieval {
  memory: MemoryNode;
  reconstruction: string;     // 基于上下文的补全
  confidence: number;         // 重建置信度
  sourceSnippet: string;       // 原始参考
  links: Array<{              // 举一反三的关联记忆
    memory: MemoryNode;
    relationship: string;     // "都和因果关系有关"
  }>;
}

class ReconstructiveSearch {
  async search(
    query: string,
    options: { maxResults?: number }
  ): Promise<MemoryRetrieval[]> {
    // 1. 找到候选记忆 (spreading activation)
    const candidates = await this.associativeGraph.spreadingActivation(
      embed(query),
      { maxResults: options.maxResults ?? 10 }
    );

    // 2. 对每个候选，生成上下文感知的重建
    const reconstructions = await Promise.all(
      candidates.map(async ({ node, activation }) => {
        const context = await this.buildContext(node);
        const reconstruction = await this.languageModel.generate(
          `Based on: ${context}\n\nDescribe: ${node.content}`
        );

        return {
          memory: node,
          reconstruction,
          confidence: activation * node.salience,
          sourceSnippet: node.content,
          links: await this.findRelatedLinks(node),
        };
      })
    );

    // 3. 返回重建结果
    return reconstructions.sort((a, b) => b.confidence - a.confidence);
  }

  private async buildContext(node: MemoryNode): Promise<string> {
    // 构建围绕记忆的上下文
    // 包括: 相关联的记忆、前序对话、schema 信息
  }
}
```

---

## 第四部分：实施路线图

### Phase 1: 基础改进（低风险）

| 改动 | 工作量 | 影响 | 风险 |
|------|--------|------|------|
| 显式关联图（基于现有 embedding 扩展） | ★★☆☆☆ | 增量 | 低 |
| 记忆重要性评分（利用现有 usage 数据） | ★★☆☆☆ | 中等 | 低 |
| 主动遗忘触发器（基于容量阈值） | ★★☆☆☆ | 中等 | 低 |

### Phase 2: 核心重构（中风险）

| 改动 | 工作量 | 风险 |
|------|--------|------|
| 记忆层级抽象（working/short/long） | ★★★☆☆ | 中 |
| 睡眠 consolidation 任务 | ★★★☆☆ | 中 |
| Schema 标签系统 | ★★★☆☆ | 中 |
| 联想图替代纯向量检索 | ★★★★☆ | 高 |

### Phase 3: 高级特性（高风险/高回报）

| 改动 | 工作量 | 风险 |
|------|--------|------|
| 跨领域关联发现 | ★★★★☆ | 高 |
| 重建性检索 | ★★★★☆ | 高 |
| 主动遗忘的神经科学模型 | ★★★★★ | 高 |

### Phase 1 详细设计

```typescript
// Phase 1: 在现有 MemoryIndexManager 基础上扩展

// 1. 添加关联边表
ALTER TABLE chunks ADD COLUMN associations TEXT; // JSON array of association objects

// 2. 添加 salience 字段
ALTER TABLE chunks ADD COLUMN salience REAL DEFAULT 0.5;
ALTER TABLE chunks ADD COLUMN access_count INTEGER DEFAULT 0;

// 3. 实现 spreading activation (可选，初期可简化为双向遍历)
class Phase1AssociativeSearch {
  async search(query: string, options: { maxResults?: number; depth?: number }) {
    // 1. 向量搜索找到初始候选
    const candidates = await this.vectorSearch(query, { maxResults: 100 });

    // 2. 提取候选的关联边
    // 3. 收集二级候选
    // 4. 融合分数 = 向量分 * (1 + salience) * log(access_count + 1)

    return this.rankAndReturn(candidates, options.maxResults ?? 10);
  }
}

// 4. 实现基于阈值的遗忘
class Phase1Forgetting {
  async triggerForgetting(): Promise<ForgettingResult> {
    const threshold = this.config.get('forgetting.salienceThreshold', 0.2);
    const oldMemories = await this.db.query(`
      SELECT id FROM chunks
      WHERE salience < ? AND access_count < 3
      AND created_at < ?
    `, [threshold, Date.now() - 30 * 24 * 60 * 60 * 1000]);

    return this.delete(oldMemories);
  }
}
```

---

## 第五部分：总结对比

| 维度 | 当前设计 | 类人设计 |
|------|---------|---------|
| **存储模型** | 平面向量空间 | 层级 + 图结构 |
| **遗忘机制** | 被动时间衰减 | 主动多机制遗忘 |
| **学习方式** | 批量索引 + 查询 | 在线快速 + 离线巩固 |
| **知识组织** | 无结构 | Schema 层级 |
| **关联能力** | 向量相似度 | 显式联想图 + spreading activation |
| **泛化能力** | 统计相似性 | Schema 驱动的举一反三 |
| **整合周期** | 无 | 睡眠周期 |
| **检索本质** | 读取/匹配 | 重建 + 关联 |

**核心转变**：

> 当前 OpenClaw 记忆是一个**向量数据库** —— 高效但冰冷。
>
> 类人记忆应该是一个**会成长、会遗忘、会联想的生命体**。

这不是简单的功能增加，而是范式转变：从"搜索"到"记忆"，从"存储"到"认知"。

---

## 附录：相关文件索引

| 新组件 | 文件路径 | 依赖 |
|--------|----------|------|
| MemoryTier | `src/memory/tier.ts` | existing MemoryIndexManager |
| AssociativeGraph | `src/memory/associative-graph.ts` | MemoryNode types |
| SpreadingActivation | `src/memory/spreading-activation.ts` | AssociativeGraph |
| ForgettingPolicy | `src/memory/forgetting-policy.ts` | MemoryIndexManager |
| SleepConsolidation | `src/memory/consolidation.ts` | ForgettingPolicy, AssociativeGraph |
| SchemaTagger | `src/memory/schema-tagger.ts` | embeddings |
| ReconstructiveSearch | `src/memory/reconstructive-search.ts` | AssociativeGraph, LM |
