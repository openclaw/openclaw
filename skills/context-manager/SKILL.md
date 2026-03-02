---
name: context-manager
description: Manage conversation context efficiently. Use when conversation gets long, switching models, or starting new sessions. Provides context summarization, key info indexing, and on-demand data loading patterns.
---

# Context Manager

高效管理对话上下文，避免超出模型输入限制。

## 核心原则

1. **关键信息索引** - 小文件 (~1KB) 始终在上下文
2. **完整数据** - 大文件按需读取
3. **脚本查询** - 替代粘贴大量数据

## 文件结构

```
workspace/
├── CONTEXT.md              # 关键信息索引（始终加载）
├── memory/
│   └── session-state.json  # 会话状态（按需读取）
└── data/
    └── <topic>.json        # 完整数据（按需读取）
```

## CONTEXT.md 模板

```markdown
# 上下文索引

## 当前任务

- 主要任务：[简短描述]
- 状态：[进行中/已完成]

## 关键数据

| 项目       | 摘要               | 完整数据位置           |
| ---------- | ------------------ | ---------------------- |
| 明胜供应商 | 56 笔未交，¥116 万 | data/orders/B0069.json |

## 最近查询

- 2026-02-25: 明胜供应商未交订单

## 快捷命令

- `node quick-query.cjs supplier B0069` - 查供应商
- `read data/orders/B0069.json` - 读取完整数据
```

## 使用模式

### 模式 1：会话开始前

```bash
# 读取 CONTEXT.md
read CONTEXT.md

# 需要详细数据时再读取
read data/orders/B0069.json
```

### 模式 2：切换模型时

```bash
# 1. 先压缩上下文
"请总结当前对话的关键信息，控制在 500 字内"

# 2. 新会话只发送摘要 + CONTEXT.md
# 3. 需要时再读取完整数据
```

### 模式 3：长对话后

```bash
# 定期总结
"请总结到目前为止的关键决策和待办事项"

# 更新 CONTEXT.md
# 归档完整数据到 data/
```

## 压缩技巧

| 原内容            | 压缩后                             |
| ----------------- | ---------------------------------- |
| 56 笔订单完整表格 | "明胜：56 笔，¥116 万，26 笔>1 年" |
| 完整 SQL 查询历史 | "用 quick-query.cjs 查询"          |
| 多次查询结果      | "见 data/orders/B0069.json"        |

## 模型切换最佳实践

```
❌ 避免：发送完整对话历史（易超限）
✅ 推荐：CONTEXT.md + 摘要 + 按需读取
```

### 切换流程

1. **切换前**：总结关键信息（<500 字）
2. **切换后**：发送摘要 + CONTEXT.md
3. **需要详情**：`read data/xxx.json`

## 快捷命令

```bash
# 创建 CONTEXT.md
echo "# 上下文索引\n\n## 当前任务\n- \n\n## 关键数据\n| 项目 | 摘要 | 位置 |\n|------|------|------|\n" > CONTEXT.md

# 更新会话状态
node -e "console.log(JSON.stringify({lastQuery: 'supplier B0069', timestamp: Date.now()}))" > memory/session-state.json

# 归档查询结果
node quick-query.cjs supplier B0069 --json > data/orders/B0069.json
```

## 触发条件

立即使用本技能当：

- 对话超过 20 轮
- 需要切换模型
- 收到"上下文太长"错误
- 开始新会话

---

_基于 skill-creator 最佳实践设计_
