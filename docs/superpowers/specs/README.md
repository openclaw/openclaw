# 类人记忆系统设计文档

**项目**: OpenClaw Memory Architecture Redesign
**日期**: 2026-03-19
**状态**: 设计阶段

---

## 文档索引

### 1. 现状调查报告
📄 **[2026-03-19-memory-architecture-survey.md](./2026-03-19-memory-architecture-survey.md)**

对 OpenClaw 当前记忆架构的全面分析，包括：
- 核心组件详解（MemoryIndexManager, Hybrid Search, Embedding Providers, QMD Backend）
- 记忆分类与生命周期
- 架构优势（★★★★☆ 功能完整性，★★★★★ 可用性/降级）
- 架构不足与改进建议（9个问题点）
- 总结评分

### 2. 人类脑科学研究报告
📄 **[2026-03-19-human-brain-memory-science.md](./2026-03-19-human-brain-memory-science.md)**

人类脑科学记忆体系的综合研究，包括：
- 记忆类型体系（工作/短时/长期，情景/语义/程序）
- 记忆形成机制（Hebbian Theory, LTP/LTD, Engrams）
- 联想网络模型与 Schema 理论
- 主动遗忘机制（适应性的遗忘优化）
- 睡眠期间的记忆优化（海马体重放）
- 类人记忆关键特征（举一反三、跨领域关联、主动遗忘）

### 3. 类人记忆架构设计方案
📄 **[2026-03-19-human-inspired-memory-architecture.md](./2026-03-19-human-inspired-memory-architecture.md)**

基于神经科学启发的记忆系统重新设计，包括：
- **架构愿景**：从"向量数据库"到"记忆生命体"
- **3.1 记忆层级**：Working → Short-term → Long-term 三层分流
- **3.2 联想图谱**：节点+边的显式关联图，spreading activation
- **3.3 主动遗忘**：突触规模调整、检索诱发遗忘、噪音过滤
- **3.4 睡眠重整合**：每日 consolidation 任务
- **3.5 Schema 驱动**：举一反三的快速泛化
- **3.6 跨领域关联**：意外关联发现机制
- **3.7 重建性检索**：检索即重建
- 实施路线图（Phase 1/2/3）

---

## 快速参考

### 核心问题诊断

| 问题 | 人类特点 | 当前实现 | 改进方向 |
|------|----------|----------|----------|
| 缺乏层级 | 工作→短时→长期分层 | 扁平向量 | 引入 MemoryTier |
| 联想薄弱 | 节点+边+扩散激活 | 向量相似度 | AssociativeGraph |
| 无主动遗忘 | 睡眠突触调整 | 被动时间衰减 | ForgettingPolicy |
| 无睡眠整合 | 海马体重放 | 无 | SleepConsolidation |
| 无Schema泛化 | 单样本归类 | 统计相似性 | SchemaTagger |
| 冷启动 | 先天认知框架 | 从零开始 | 基础Schema库 |
| 检索即读取 | 重建性检索 | 返回snippet | ReconstructiveSearch |

### 架构对比

| 维度 | 当前 | 类人 |
|------|------|------|
| 存储模型 | 平面向量空间 | 层级 + 图结构 |
| 遗忘机制 | 被动衰减 | 主动多机制 |
| 学习方式 | 批量索引 | 在线 + 离线 |
| 知识组织 | 无结构 | Schema层级 |
| 关联能力 | 向量相似度 | Spreading Activation |
| 整合周期 | 无 | 每日睡眠 |

---

## 阅读顺序建议

1. **入门**: 先读本索引文档了解全貌
2. **现状理解**: 阅读文档1了解当前架构和问题
3. **科学基础**: 阅读文档2理解人类记忆原理
4. **解决方案**: 阅读文档3了解设计改进方案
5. **深入**: 根据兴趣深入特定章节

---

## 下一步

- [ ] 评审设计文档
- [ ] 细化 Phase 1 实现计划
- [ ] 开始 Phase 1 开发（联想图 + 遗忘机制）
