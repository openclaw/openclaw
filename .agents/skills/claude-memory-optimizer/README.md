# Claude Memory Optimizer

基于 Claude Code 泄露代码的记忆机制优化 OpenClaw 记忆系统。

## 核心特性

- **4 类记忆分类**：user / feedback / project / reference
- **结构化 Frontmatter**：name / description / type
- **语义检索机制**：LLM 选择 Top 5 相关记忆
- **验证机制**：回忆时验证文件/函数是否存在
- **日志模式**：可选 KAIROS 日志（追加式）

## 安装

```bash
# 从 clawhub 安装（待发布）
clawhub install claude-memory-optimizer

# 或手动复制
cp -r .agents/skills/claude-memory-optimizer ~/.openclaw/skills/
```

## 使用

### 1. 运行迁移脚本

```bash
node .agents/skills/claude-memory-optimizer/scripts/refactor-memory.js
```

### 2. 检查迁移结果

```bash
# 查看新的目录结构
ls -la ~/.openclaw/workspace/memory/

# 查看 MEMORY.md 索引
cat ~/.openclaw/workspace/MEMORY.md
```

### 3. 清理旧文件

确认无误后删除旧的 memory/\*.md 文件：

```bash
# 备份
cp -r ~/.openclaw/workspace/memory ~/.openclaw/workspace/memory.backup

# 删除旧文件（保留 daily logs）
rm ~/.openclaw/workspace/memory/*.md
```

## 记忆类型

| 类型      | 用途       | 示例             |
| --------- | ---------- | ---------------- |
| user      | 用户信息   | 角色、偏好、技能 |
| feedback  | 行为指导   | 纠正、确认       |
| project   | 项目上下文 | 决策、截止时间   |
| reference | 外部引用   | 链接、Dashboard  |

## 记忆文件结构

```
memory/
├── user/          # 用户信息
├── feedback/      # 行为指导
├── project/       # 项目上下文
├── reference/     # 外部引用
└── logs/          # 日志模式（可选）
    └── YYYY/
        └── MM/
            └── YYYY-MM-DD.md
```

### Frontmatter 格式

```markdown
---
name: 数据科学背景
description: 用户是数据科学家，专注可观测性和日志分析
type: user
---

用户在北京工业大学 & 都柏林大学就读...
```

## 配置示例

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

## 高级功能

### 语义检索（待实现）

```typescript
async function findRelevantMemories(query, memoryDir) {
  const memories = await scanMemoryFiles(memoryDir);
  const selected = await selectRelevantMemories(query, memories);
  return selected.slice(0, 5);
}
```

### 快照同步（待实现）

```bash
# 创建项目快照
claude-memory snapshot create --project dong-thesis

# 同步到团队成员
claude-memory snapshot sync --to ~/.openclaw/team-memory/
```

## 参考资料

- Claude Code 泄露代码：`src/memdir/`
- OpenClaw 记忆文档：`docs/concepts/memory.md`
- 记忆类型定义：`memoryTypes.ts`
- 语义检索：`findRelevantMemories.ts`

## 许可证

MIT
