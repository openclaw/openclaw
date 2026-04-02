# Pull Request: Claude Memory Optimizer

## 🎯 概述

基于 Claude Code 泄露代码的记忆机制，为 OpenClaw 带来更结构化的记忆系统。

## 📋 变更内容

### 新增文件

```
.agents/skills/claude-memory-optimizer/
├── README.md                 # 技能文档
├── SKILL.md                  # OpenClaw 技能定义
├── scripts/
│   └── refactor-memory.js    # 记忆迁移脚本
└── examples/
    ├── memory-frontmatter-example.md  # user 类型示例
    ├── feedback-example.md            # feedback 类型示例
    ├── project-example.md             # project 类型示例
    └── reference-example.md           # reference 类型示例
```

### 核心特性

1. **4 类记忆分类**
   - `user` - 用户信息（角色、偏好、技能）
   - `feedback` - 行为指导（纠正、确认）
   - `project` - 项目上下文（决策、截止时间）
   - `reference` - 外部引用（链接、Dashboard）

2. **结构化 Frontmatter**
   ```markdown
   ---
   name: 数据科学背景
   description: 用户是数据科学家，专注可观测性
   type: user
   ---
   ```

3. **自动迁移脚本**
   - 分析现有 memory/*.md 文件
   - 自动检测类型并分类
   - 生成 frontmatter
   - 更新 MEMORY.md 索引

4. **日志模式支持**
   - 可选 KAIROS 日志（`logs/YYYY/MM/DD.md`）
   - 追加式记录，夜间提炼

## 🔬 技术细节

### 记忆类型检测算法

```javascript
const TYPE_KEYWORDS = {
  user: ['用户', '偏好', '背景', 'skill', 'preference'],
  feedback: ['反馈', '纠正', '不要', 'stop', 'avoid'],
  project: ['项目', '研究', '论文', 'project', 'thesis'],
  reference: ['链接', 'http', 'profile', 'dashboard']
}
```

### 语义检索（未来扩展）

参考 Claude Code 的 `findRelevantMemories.ts`：
- 用 Sonnet 选择 Top 5 相关记忆
- 排除已展示过的记忆
- 支持"最近使用工具"过滤

### 验证机制（未来扩展）

回忆时验证：
- 文件路径 → `ls` 检查
- 函数/标志 → `grep` 确认
- 与当前信息冲突 → 更新/删除记忆

## 📊 对比

| 特性 | 当前 OpenClaw | 优化后 |
|------|--------------|--------|
| 记忆类型 | 无分类 | 4 类分类 |
| 索引文件 | MEMORY.md | MEMORY.md + frontmatter |
| 主题文件 | memory/*.md | memory/{type}/*.md |
| 语义检索 | 基础 keyword | LLM 选择 Top 5（待实现） |
| 验证机制 | 无 | 回忆时验证（待实现） |

## 🧪 测试

### 本地测试

```bash
# 1. 安装技能
cp -r .agents/skills/claude-memory-optimizer ~/.openclaw/skills/

# 2. 运行迁移脚本
node ~/.openclaw/skills/claude-memory-optimizer/scripts/refactor-memory.js

# 3. 检查结果
ls -la ~/.openclaw/workspace/memory/
cat ~/.openclaw/workspace/MEMORY.md
```

### 测试用例

1. **记忆分类准确性**
   - 输入：包含"用户"关键词的文件 → 预期：user 类型
   - 输入：包含"不要"关键词的文件 → 预期：feedback 类型

2. **Frontmatter 生成**
   - 从标题提取 name
   - 从第一段提取 description
   - 自动检测 type

3. **索引更新**
   - MEMORY.md 正确指向新位置
   - 分类展示清晰

## 📚 参考资料

- Claude Code 泄露代码：`src/memdir/`
  - `memdir.ts` - 记忆系统核心
  - `memoryTypes.ts` - 类型定义
  - `findRelevantMemories.ts` - 语义检索
  - `agentMemorySnapshot.ts` - 快照同步

- OpenClaw 文档：`docs/concepts/memory.md`

## ⚠️ 注意事项

1. **向后兼容**
   - 保留现有 `memory/YYYY-MM-DD.md` 日志格式
   - MEMORY.md 索引格式保持可读性
   - 迁移脚本可选运行

2. **安全边界**
   - MEMORY.md 只在主会话加载
   - 不在群聊中泄露个人记忆

3. **性能影响**
   - 迁移脚本一次性运行
   - 日常使用无额外开销

## 🚀 后续计划

### Phase 1 (本 PR)
- [x] 4 类分类系统
- [x] Frontmatter 支持
- [x] 迁移脚本
- [x] 示例文件

### Phase 2 (未来 PR)
- [ ] 语义检索（LLM 选择）
- [ ] 验证机制（回忆时检查）
- [ ] 快照同步（团队协作）
- [ ] KAIROS 日志模式

## 📸 截图

### 迁移前
```
memory/
├── 2026-03-21.md
├── 2026-03-28.md
├── research-memory.md
└── video-memory.md
```

### 迁移后
```
memory/
├── project/
│   ├── 2026-03-21-.md
│   ├── 2026-03-28-.md
│   └── research-memory.md
├── reference/
│   └── video-memory.md
└── logs/
    └── 2026/
        └── 04/
            └── 2026-04-02.md
```

---

## ✅ 检查清单

- [x] 代码格式符合项目规范
- [x] 包含必要的文档
- [x] 提供示例文件
- [x] 向后兼容
- [ ] 通过 CI 测试（待推送后运行）
- [ ] 更新 CHANGELOG（待合并前）

---

**关联 Issue:** （如有）  
**Breaking Changes:** 无  
**迁移指南:** 见 README.md
