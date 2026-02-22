---
name: zread
description: Deep analysis of GitHub repositories using Zread MCP (GLM Coding Plan exclusive). Search docs/issues/PRs, analyze structure, and read source code in real-time.
metadata:
  openclaw:
    emoji: 📦
    priority: high
    triggers:
      - "分析仓库"
      - "查看仓库"
      - "了解项目"
      - "GitHub 仓库"
      - "repo structure"
      - "how does this repo work"
      - "源码分析"
      - "依赖库调研"
      - "Issue"
      - "PR"
---

# GitHub Repository Analyzer (Zread MCP)

**GLM Coding Plan 专属能力** - 为智能体工程（Agentic Engineering）量身定制

## 核心优势

- ✅ **实时调取真实代码和文档** - AI 不再"盲猜"
- ✅ **搜索 Issue/PR/贡献者** - 快速掌握项目背景
- ✅ **深度源码分析** - 读取完整代码实现
- ✅ **加速学习曲线** - 快速理解新库

## When to Use

**Trigger automatically when user says:**

- "分析 [某个] 仓库"
- "查看 [owner/repo] 的结构"
- "帮我了解 [project] 项目"
- "这个 GitHub 仓库怎么用"
- "Read the README of [repo]"
- "Explain how [repo] works"
- "源码分析 [repo]"
- "调研 [repo] 依赖库"
- "查看 [repo] 的 Issue/PR"

## Automatic Workflow

1. **Extract repo name** from user message (format: `owner/repo`)
2. **Choose appropriate tool:**
   - For structure/exploration → `zread.get_repo_structure`
   - For specific questions → `zread.search_doc`
   - For specific files → `zread.read_file`
3. **Call via mcporter** and present results

## Example Triggers

### Structure Analysis

```
User: "分析 facebook/react 仓库"
→ Call: zread.get_repo_structure repo_name="facebook/react"
→ Present: directory tree + key files
```

### Documentation Search

```
User: "vuejs/core 的响应式原理是什么"
→ Call: zread.search_doc repo_name="vuejs/core" query="reactivity principle" language="zh"
→ Present: relevant docs + code snippets
```

### File Reading

```
User: "读取 openclaw/openclaw 的 README.md"
→ Call: zread.read_file repo_name="openclaw/openclaw" file_path="README.md"
→ Present: file content
```

## Tool Reference

### zread.search_doc

**不只是搜索代码** - 全方位检索项目知识

- **参数**: `repo_name`, `query`, `language` (zh/en)
- **搜索范围**:
  - 📚 仓库知识文档
  - 🐛 近期 Issue
  - 🔀 Pull Request
  - 👥 贡献者信息
- **用途**: 快速掌握项目背景、查找解决方案、了解项目动态
- **示例**: `mcporter call zread.search_doc repo_name="owner/repo" query="installation" language="zh"`

### zread.get_repo_structure

**一键获取项目全貌**

- **参数**: `repo_name` (required), `dir_path` (optional)
- **返回**: 完整目录树 + 文件列表
- **用途**: 快速理解模块划分、逻辑布局、项目架构
- **示例**: `mcporter call zread.get_repo_structure repo_name="owner/repo"`

### zread.read_file

**深度源码分析**

- **参数**: `repo_name`, `file_path`
- **返回**: 完整代码内容
- **用途**: 理解实现逻辑、学习代码风格、调试问题
- **示例**: `mcporter call zread.read_file repo_name="owner/repo" file_path="src/index.js"`

## Notes

- **GLM Coding Plan 专属** - 需要 GLM Coding Plan 订阅
- Only works with **public** GitHub repositories
- Format must be `owner/repo`
- Timeout: up to 60 seconds
- Always provide Chinese response when user asks in Chinese

## Typical Use Cases

### 1. 学习新库

```
User: "我想学 React，帮我看看 facebook/react 的结构"
→ get_repo_structure → 展示项目布局
→ search_doc "getting started" → 查找入门文档
→ read_file "README.md" → 读取完整说明
```

### 2. 依赖库调研

```
User: "调研一下 vuejs/core 的响应式系统实现"
→ search_doc "reactivity implementation"
→ read_file "packages/reactivity/src/reactive.ts"
→ 解释核心实现逻辑
```

### 3. Bug 修复

```
User: "这个库有个问题，看看最近的 Issue"
→ search_doc "recent issues"
→ 分析 Issue 中的解决方案
→ read_file 相关代码文件
```

### 4. 贡献代码

```
User: "我想给 openclaw/openclaw 提 PR，看看贡献者指南"
→ search_doc "contributing"
→ read_file "CONTRIBUTING.md"
→ 展示贡献流程
```

## Error Handling

If repo not found or timeout:

1. Check if repo is public
2. Verify format is `owner/repo`
3. Suggest alternative: use `gh` CLI or `web_fetch`
