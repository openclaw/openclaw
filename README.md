# Memory 持久化指南

## 📂 文件结构

```
memory/
├── README.md              # 本文件 - 持久化指南
├── MEMORY.md              # 核心记忆索引 (手动维护)
├── 2026-03-28.md          # 每日记忆 (自动创建)
├── 2026-03-27.md
├── ...
└── archive/               # 月度归档
    └── 2026-03.md
```

## 🔄 持久化流程

### 每日 (自动)

- 每天 23:59 自动创建 `memory/YYYY-MM-DD.md`
- 记录当天重要事件、修复、决策

### 每周 (手动)

```bash
# 1. 查看本周记忆
git log --since="7 days ago" -- memory/

# 2. 汇总到 MEMORY.md
# 编辑 MEMORY.md，添加本周摘要

# 3. 提交到 git
git add memory/
git commit -m "memory: week 2026-W13 summary"
git push origin main
```

### 每月 (手动)

```bash
# 1. 归档本月记忆
cat memory/2026-03-*.md > memory/archive/2026-03.md

# 2. 提交归档
git add memory/archive/2026-03.md
git commit -m "archive: 2026-03 memory"
git push origin main
```

## 🔒 防删除策略

### 1. Git 版本控制

```bash
# 每次重要更新后提交
git add memory/YYYY-MM-DD.md
git commit -m "memory: 重要事件记录"
git push origin main
```

**查看历史：**

```bash
git log --oneline -- memory/
git show <commit-hash>
```

### 2. 远程备份

```bash
# 推送到远程仓库
git push origin main

# 或推送到专门的 memory 分支
git push origin main:memory-backup
```

### 3. 本地备份

```bash
# 备份到外部存储
cp -r memory/ /path/to/backup/memory-$(date +%Y%m%d)/
```

## 📖 随时阅读

### 查看最新记忆

```bash
cat memory/$(date +%Y-%m-%d).md
```

### 查看历史记忆

```bash
cat memory/2026-03-27.md
```

### 搜索特定内容

```bash
grep -r "PR 流程" memory/
grep -r "微信渠道" memory/
```

### 查看 git 历史

```bash
git log --oneline -- memory/
git log -p -- memory/2026-03-28.md
```

## ⚠️ 注意事项

1. **不要删除 memory/ 目录** - 包含所有历史记忆
2. **定期 git push** - 确保远程有备份
3. **重要事件立即提交** - 不要等到周末
4. **MEMORY.md 手动维护** - 核心索引，不要自动覆盖

## 🛠️ 自动化脚本

### 每日记忆创建

```bash
#!/bin/bash
# scripts/create-daily-memory.sh
DATE=$(date +%Y-%m-%d)
FILE="/home/w/.openclaw/workspace/memory/$DATE.md"

if [ ! -f "$FILE" ]; then
  echo "# $DATE Memory" > "$FILE"
  echo "" >> "$FILE"
  echo "## Session Summary" >> "$FILE"
  echo "" >> "$FILE"
fi
```

### 每周汇总

```bash
#!/bin/bash
# scripts/weekly-memory-summary.sh
# 将本周 memory 文件汇总到 MEMORY.md
```

---

_Last updated: 2026-03-28_
