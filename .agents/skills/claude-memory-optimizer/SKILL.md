# claude-memory-optimizer 技能

**功能：** 基于 Claude Code 泄露代码的记忆机制优化 OpenClaw 记忆系统

**触发词：** 记忆优化、memory optimizer、claude memory、记忆机制

---

## 核心设计

### 记忆类型分类（4 类）

```markdown
## Types of memory

### user - 用户信息

- 用户角色、偏好、责任、知识
- 示例："数据科学家，专注可观测性/日志"

### feedback - 行为指导

- 用户纠正或确认的行为模式
- 格式：规则 + **Why:** + **How to apply:**
- 示例："不要 mock 数据库 — 上次 mock 测试通过但 prod 迁移失败"

### project - 项目上下文

- 正在进行的工作、目标、事件、决策
- 相对日期转绝对日期（"周四" → "2026-03-05"）
- 格式：事实 + **Why:** + **How to apply:**

### reference - 外部系统指针

- 外部资源位置（Linear、Slack、Grafana 等）
- 示例："管道 bug 追踪在 Linear 项目 INGEST"
```

### 什么 NOT 保存到记忆

- ❌ 代码模式、架构、文件路径（可从代码推导）
- ❌ Git 历史、最近变更（git log 是权威）
- ❌ 调试解决方案（修复在代码中）
- ❌ CLAUDE.md 已记录的内容
- ❌ 临时任务细节（仅当前会话有用）

---

## 记忆文件结构

### MEMORY.md（索引文件）

```markdown
# MEMORY.md - 长期记忆

_最后更新：2026-04-02_

## 用户信息

- [数据科学背景](memory/user/background.md) — 数据科学家，专注可观测性
- [通信偏好](memory/user/preferences.md) — 简洁回复，不要总结

## 行为指导

- [数据库测试规范](memory/feedback/db-testing.md) — 不要 mock，用真实数据库
- [回复风格](memory/feedback/reply-style.md) — 不要 trailing summary

## 项目上下文

- [董哥论文研究](memory/project/dong-thesis.md) — UQ+CIL+XAI，2026 毕业
- [商机雷达](memory/project/opportunity-radar.md) — GitHub/微博/知乎监控

## 外部引用

- [Kaggle Profile](memory/reference/kaggle.md) — https://kaggle.com/chenziong
- [Upwork Profile](memory/reference/upwork.md) — 待完善
```

### 主题记忆文件（带 frontmatter）

```markdown
---
name: 数据科学背景
description: 用户是数据科学家，专注可观测性和日志分析
type: user
---

用户在北京工业大学 & 都柏林大学就读，GPA 3.95/4.2，排名 1/87。
研究方向：LLM、AI Agents、MCP 协议。

**技能栈：**

- Python, PyTorch, Transformers, LLM
- Web Scraping, BERT, NLP

**如何应用：**

- 解释概念时用数据科学术语
- 假设熟悉统计和机器学习基础
```

### 日志模式（可选 KAIROS）

```
memory/logs/2026/04/2026-04-02.md
```

```markdown
# 2026-04-02

- 04:30 商机雷达检查：GitHub Trending 7 条，无新增
- 09:00 推送日报：Top 10 项目
- 用户请求优化记忆机制，参考 Claude Code 泄露代码
```

---

## 语义检索机制

### 检索流程

```
1. 用户查询 → 提取关键词
2. 扫描所有记忆文件的 header（name + description）
3. 用轻量 LLM（如 Sonnet）选择最相关的 5 个记忆
4. 排除已展示过的记忆
5. 返回完整内容
```

### 实现建议

```typescript
async function findRelevantMemories(query: string, memoryDir: string) {
  const memories = await scanMemoryFiles(memoryDir);

  // 用 LLM 选择相关记忆
  const selected = await selectRelevantMemories(query, memories, {
    recentTools: ["Bash", "FileRead"], // 排除工具文档类记忆
    alreadySurfaced: new Set(["user/background.md"]), // 排除已展示
  });

  return selected.slice(0, 5); // 最多 5 个
}
```

---

## 验证机制

### 回忆时验证

```markdown
## Before recommending from memory

记忆是"写入时的快照"，可能已过时。推荐前验证：

1. 如果记忆命名了文件路径 → `ls` 检查文件是否存在
2. 如果记忆命名了函数/标志 → `grep` 确认
3. 如果用户要基于记忆行动 → 先验证当前状态
4. 如果记忆与当前信息冲突 → 信任当前观察，更新/删除记忆

"记忆说 X 存在" ≠ "X 现在存在"
```

---

## 记忆维护流程

### 每日（Heartbeat）

- 追加到 `memory/YYYY-MM-DD.md`
- 记录决策、对话、学到的东西

### 每周（回顾）

- 阅读 daily notes
- 提炼重要信息到 `MEMORY.md`
- 清理过期内容

### 每月（整理）

- 审查项目进展
- 更新长期目标
- 回顾 `.learnings/` 记录

---

## 使用示例

### 保存记忆

```
用户：记住，我更喜欢简洁的回复，不要 trailing summary

AI: [保存 feedback 记忆]
→ memory/feedback/reply-style.md

---
name: 回复风格偏好
description: 用户喜欢简洁回复，不要 trailing summary
type: feedback
---

**规则：** 回复要简洁，不要在结尾总结刚做的事情

**Why:** 用户说"我可以自己读 diff"

**How to apply:** 所有会话中，完成工作后直接结束，不要加"完成了 X、Y、Z"的总结
```

### 检索记忆

```
用户：我之前说过什么关于数据库测试的？

AI: [调用 memory_search query="数据库测试"]
→ 返回 memory/feedback/db-testing.md

根据记忆，你说过："不要 mock 数据库 — 上次 mock 测试通过但 prod 迁移失败"
```

### 验证记忆

```
用户：memory/project/dong-thesis.md 说的实验设计还在用吗？

AI: [grep 当前代码库确认实验配置]
→ 发现已更新

记忆中的实验设计已过时。当前代码使用新的对比方案（DER, iCaRL, LwF, TSBN）。
已更新记忆文件。
```

---

## 迁移指南

### 从现有系统迁移

1. **保留** `MEMORY.md` 作为索引
2. **创建** `memory/user/`, `memory/feedback/`, `memory/project/`, `memory/reference/`
3. **移动** 现有记忆到对应分类
4. **添加** frontmatter（name, description, type）
5. **更新** `MEMORY.md` 索引指向新位置

### 配置 OpenClaw

```json5
{
  agents: {
    defaults: {
      compaction: {
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
        },
      },
    },
  },
  plugins: {
    entries: {
      memory: {
        id: "memory-core",
        config: {
          memoryDir: "./memory",
          indexPath: "./MEMORY.md",
          types: ["user", "feedback", "project", "reference"],
        },
      },
    },
  },
}
```

---

## 高级功能

### 快照同步（团队项目）

```bash
# 创建项目快照
claude-memory snapshot create --project dong-thesis

# 同步到团队成员
claude-memory snapshot sync --to ~/.openclaw/team-memory/

# 从快照初始化
claude-memory snapshot init --from snapshot-2026-04-02/
```

### 日志模式（KAIROS）

适用于长期运行的助手会话：

- 每日追加到 `logs/YYYY/MM/DD.md`
- 夜间 `/dream` 技能提炼到 `MEMORY.md`
- 避免频繁重写索引文件

---

## 参考

- Claude Code 泄露代码：`/home/ang/claude-code-leak-original/src/memdir/`
- OpenClaw 记忆文档：`/home/ang/openclaw/docs/concepts/memory.md`
- 记忆类型定义：`memoryTypes.ts`
- 语义检索：`findRelevantMemories.ts`
- 快照同步：`agentMemorySnapshot.ts`
