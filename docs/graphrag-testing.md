# GraphRAG 功能测试方案

## 测试概览

```
测试层级：
┌─────────────────────────────────────────────────┐
│  L4: 真实场景 A/B 测试 (多跳问答准确率)           │ ← 需要真实用户流量
├─────────────────────────────────────────────────┤
│  L3: E2E 集成测试 (完整检索流程)                 │ ← 需要 LLM API key
├─────────────────────────────────────────────────┤
│  L2: 集成测试 (图谱存储 + 检索)                  │ ← ✅ 已完成
├─────────────────────────────────────────────────┤
│  L1: 单元测试 (基础功能)                         │ ← ✅ 已完成
└─────────────────────────────────────────────────┘
```

---

## L1: 单元测试 ✅

**文件**: `src/memory/graph.test.ts`

**运行**:
```bash
pnpm test src/memory/graph.test.ts
```

**覆盖**:
- ✅ 实体存储 (upsertEntities)
- ✅ 关系存储 (upsertRelationships)
- ✅ 实体检索 (getEntitiesByChunk)
- ✅ 关系检索 (getRelatedEntities)
- ✅ 名称模糊搜索 (findEntitiesByName)
- ✅ 实体删除清理 (deleteEntitiesForChunk)
- ✅ 状态查询 (getStatus)

**状态**: 11 passed | 5 skipped (FK 相关)

---

## L2: 集成测试 ✅

**文件**: `scripts/test-graphrag.ts`

**运行**:
```bash
node --import tsx scripts/test-graphrag.ts
```

**测试场景**:
1. ✅ 人物 - 组织关系抽取
2. ✅ 地点关系抽取
3. ✅ 时间线抽取

**状态**: 3 passed | 0 failed

---

## L3: E2E 集成测试 (需 LLM API)

**目的**: 测试完整流程（实体抽取 → 存储 → 检索 → 融合排序）

**创建测试文件**: `scripts/test-graphrag-e2e.ts`

```bash
# 运行条件：需要 OpenAI API key
export OPENAI_API_KEY=sk-xxx
node --import tsx scripts/test-graphrag-e2e.ts
```

**测试内容**:
1. LLM 实体抽取准确性
2. 图谱检索效果
3. 向量 + 图谱融合排序

**评估指标**:
- 实体抽取 F1 score > 0.8
- 检索召回率提升 > 20%
- 多跳问答准确率提升 > 15%

---

## L4: 真实场景 A/B 测试

**目的**: 对比 有/无 GraphRAG 的实际效果

### 测试设计

| 组别 | 配置 | 样本量 |
|------|------|--------|
| A 组 (对照) | 纯向量检索 | 100 queries |
| B 组 (实验) | 向量 + 图谱融合 | 100 queries |

### 测试 Query 类型

```yaml
多跳问答:
  - "Elon Musk 的公司的总部在哪里？"
    需要：Elon Musk → Tesla/SpaceX → 地点
  - "OpenClaw 的创始人之前在哪里工作？"
    需要：OpenClaw → 创始人 → 之前公司

实体关联:
  - "特斯拉的 CEO"
  - "上海的科技公司"

时间线:
  - "SpaceX 什么时候成立"
  - "2022 年发生了什么"
```

### 评估指标

```typescript
// 人工评分标准
interface EvaluationMetrics {
  relevance: number;      // 相关性 (1-5)
  accuracy: number;       // 准确性 (1-5)
  completeness: number;   // 完整性 (1-5)
  responseTime: number;   // 响应时间 (ms)
}

// 对比指标
const comparison = {
  retrievalRecall: "+20%",     // 检索召回率提升
  answerAccuracy: "+15%",      // 答案准确率提升
  multiHopSuccess: "+30%",     // 多跳问答成功率
  avgResponseTime: "+50ms",    // 平均响应时间增加
};
```

---

## 快速验证脚本

### 1. 检查图谱构建

```bash
node --import tsx -e "
import { MemoryGraphStore } from './src/memory/graph-store.js';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
const store = new MemoryGraphStore({ db });

store.upsertEntities(
  [{ name: 'Test Entity', type: 'PERSON', confidence: 0.9 }],
  'chunk1',
  'Test context'
);

console.log('Graph Status:', store.getStatus());
// 输出：{ entityCount: 1, relationshipCount: 0, mentionCount: 1 }
"
```

### 2. 手动测试检索

```typescript
// 在 OpenClaw 会话中
const session = await openclaw.session.create();
session.reasoningLevel = "high";

// 提问需要多跳推理的问题
await session.send("特斯拉的创始人还创办了哪些公司？");

// 查看返回结果中是否包含 SpaceX、Neuralink 等关联实体
```

---

## 性能基准测试

```bash
# 运行性能测试
node --import tsx scripts/test-graphrag-benchmark.ts
```

**测试项目**:

| 操作 | 目标延迟 | 实际测量 |
|------|----------|----------|
| 实体抽取 (100 字) | <2s | ___ ms |
| 单跳检索 | <100ms | ___ ms |
| 融合排序 | <50ms | ___ ms |
| 图谱状态查询 | <10ms | ___ ms |

---

## 验收标准

### Phase 1 (MVP) ✅
- [x] 单元测试通过 (>10 个)
- [x] 集成测试通过
- [x] 构建无错误

### Phase 2 (功能完整)
- [ ] E2E 测试通过 (需 API key)
- [ ] 实体抽取 F1 > 0.75
- [ ] 检索延迟 <200ms

### Phase 3 (生产就绪)
- [ ] A/B 测试显示准确率提升 >10%
- [ ] 性能基准达标
- [ ] 无内存泄漏

---

## 调试技巧

### 1. 查看图谱内容

```sql
-- 所有实体
SELECT * FROM entities ORDER BY mentions DESC LIMIT 20;

-- 所有关系
SELECT * FROM relationships LIMIT 20;

-- 实体提及分布
SELECT e.name, COUNT(em.chunk_id) as mentions
FROM entities e
JOIN entity_mentions em ON e.id = em.entity_id
GROUP BY e.id
ORDER BY mentions DESC;
```

### 2. 检索调试

```typescript
const results = await retriever.searchByEntities("query", {
  maxResults: 10,
  entityBoost: 1.5, // 调整此值观察效果
});

console.log("Entity matches:", results.filter(r => r.entityMatch));
console.log("Vector matches:", results.filter(r => !r.entityMatch));
```

### 3. 日志级别

```typescript
// 在 graph-retriever.ts 中添加调试日志
console.log("[GraphRAG] Extracted entities:", entities);
console.log("[GraphRAG] Search results:", results);
```

---

## 常见问题排查

| 问题 | 可能原因 | 解决方案 |
|------|----------|----------|
| 实体数为 0 | FK 约束失败 | 确保 chunks 表有对应记录 |
| 检索结果为空 | 实体 ID 不匹配 | 检查 generateEntityId 逻辑 |
| 关系无法创建 | 实体不存在 | 先创建实体再创建关系 |
| 性能慢 | 缺少索引 | 检查 schema 中的索引创建 |

---

## 总结

**当前状态**: Phase 1 完成 ✅
- L1 单元测试：✅
- L2 集成测试：✅
- L3 E2E 测试：待 API key
- L4 A/B 测试：待真实流量

**下一步**: 
1. 配置 LLM API key 运行 E2E 测试
2. 在真实会话中测试多跳问答
3. 收集用户反馈优化 entityBoost 参数
