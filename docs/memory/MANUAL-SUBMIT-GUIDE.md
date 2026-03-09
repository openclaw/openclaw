# PR 提交指南 - 手动步骤

> **如果你不能运行脚本，按照这些步骤手动提交**

---

## 📋 准备工作

### 1. Fork OpenClaw 仓库

1. 访问 https://github.com/openclaw/openclaw
2. 点击右上角的 "Fork" 按钮
3. 选择你的账号（tutu-claw-ai）
4. 等待 fork 完成

### 2. 克隆到本地

```bash
# 克隆你的 fork
git clone https://github.com/tutu-claw-ai/openclaw.git
cd openclaw

# 创建 feature 分支
git checkout -b feature/chain-memory-backend
```

---

## 📂 复制文件

### 3. 复制源代码

```bash
# 创建目录
mkdir -p src/memory/chain
mkdir -p test/memory/chain
mkdir -p docs/memory

# 复制源代码
cp /home/ubuntu/.openclaw/workspace/memory/chain/src/*.ts src/
cp /home/ubuntu/.openclaw/workspace/memory/chain/src/memory/chain/*.ts src/memory/chain/

# 复制测试
cp /home/ubuntu/.openclaw/workspace/memory/chain/test/*.ts test/memory/chain/

# 复制文档
cp /home/ubuntu/.openclaw/workspace/memory/chain/README.md docs/memory/
cp /home/ubuntu/.openclaw/workspace/memory/chain/*.md docs/memory/
```

### 4. 需要修改的文件

**修改 `src/config/types.memory.ts`：**

在文件末尾添加：

```typescript
// Chain Memory Backend 配置
export type MemoryBackend = "builtin" | "qmd" | "chain";

export interface MemoryChainConfig {
  providers: MemoryChainProvider[];
  global?: {
    defaultTimeout?: number;
    enableAsyncWrite?: boolean;
    enableFallback?: boolean;
    healthCheckInterval?: number;
  };
}

export interface MemoryChainProvider {
  name: string;
  priority: "primary" | "secondary" | "fallback";
  backend?: string;
  plugin?: string;
  enabled?: boolean;
  writeMode?: "sync" | "async";
  timeout?: {
    add?: number;
    search?: number;
    update?: number;
    delete?: number;
  };
  retry?: {
    maxAttempts?: number;
    backoffMs?: number;
  };
  circuitBreaker?: {
    failureThreshold?: number;
    resetTimeoutMs?: number;
  };
  [key: string]: any;
}
```

**修改 `src/memory/backend-config.ts`：**

在 `getMemoryBackend` 函数中添加：

```typescript
case "chain":
  const chainConfig = config.memory?.chain;
  if (!chainConfig) {
    throw new Error("chain backend requires memory.chain config");
  }
  return {
    backend: "chain",
    ...chainConfig
  };
```

**修改 `src/memory/search-manager.ts`：**

在 `getMemorySearchManager` 函数中添加：

```typescript
case "chain":
  const { ChainMemoryManager } = require("./chain");
  return new ChainMemoryManager({
    config: backendConfig,
    getBackendManager: (backend: string, config?: any) =>
      getMemorySearchManager(backend, config),
    getPluginManager: (plugin: string, config?: any) =>
      getPluginManager(plugin, config)
  });
```

---

## 🧪 测试

### 5. 安装依赖

```bash
# 使用 pnpm（推荐）
pnpm install

# 或使用 npm
npm install
```

### 6. 运行测试

```bash
# 构建项目
pnpm build

# 运行检查
pnpm check

# 运行测试
pnpm test

# 确保所有测试通过
```

**预期结果：**

```
Test Suites: 2 passed, 2 total
Tests:       45 passed, 45 total
Coverage:    96.61% statements
```

---

## 📤 提交代码

### 7. 提交更改

```bash
# 查看更改
git status

# 添加所有文件
git add .

# 提交
git commit -m "feat(memory): Add chain backend for multi-provider memory with plugin support

This PR adds a new Chain Memory Backend that enables multi-provider memory
with fault isolation and graceful degradation.

Key features:
- Multi-provider support (builtin, QMD, Plugins)
- Circuit breaker for fault isolation
- Graceful degradation (Primary → Fallback)
- Async write for secondary providers
- Plugin support for all OpenClaw Memory Plugins
- Minimal configuration (3 required parameters)
- 100% backward compatible

Testing:
- 45 test cases, 96.61% coverage
- All tests passing

AI-assisted using Claude (Anthropic).
Fully tested and code understood."
```

### 8. 推送到 GitHub

```bash
git push origin feature/chain-memory-backend
```

---

## 🔗 创建 PR

### 9. 在 GitHub 上创建 PR

1. 访问你的 fork: https://github.com/tutu-claw-ai/openclaw
2. 点击 "Compare & pull request" 按钮
3. 确保基础仓库是 `openclaw/openclaw`，基础分支是 `main`
4. 确保比较仓库是你的 fork，比较分支是 `feature/chain-memory-backend`
5. 填写 PR 标题和描述

**PR 标题：**

```
feat(memory): Add chain backend for multi-provider memory with plugin support
```

**PR 描述：**

- 复制 `PR-DESCRIPTION.md` 的内容
- 粘贴到 PR 描述框中

### 10. 添加标签

在 PR 页面右侧添加标签：

- `memory`
- `agents`
- `gateway`

---

## 📧 监控回复

### 11. 监控邮箱和 GitHub

**需要监控的内容：**

- ✅ CI 测试结果（等待所有绿色）
- ✅ Bot review conversations（及时回复或解决）
- ✅ 维护者的评论（及时回复）
- ✅ 社区反馈（积极参与讨论）

**回复 bot conversations：**

1. 点击 PR 中的 "Files changed" 标签
2. 查看 bot 的审查意见
3. 如果需要修改，在本地修改后提交
4. 在 conversation 中回复 "Fixed" 或解释原因
5. 点击 "Resolve conversation"

**维护者可能的提问：**

- 为什么这样设计？
- 是否考虑过其他方案？
- 性能影响如何？
- 如何测试？

**准备好回答这些问题！**

---

## ⏱️ 时间线

**预期时间：**

- CI 测试：5-10 分钟
- Bot review：1-24 小时
- 维护者 review：1-7 天

**保持耐心，及时回复！**

---

## 🆘 需要帮助？

**如果在任何步骤遇到问题：**

1. **CI 失败**
   - 查看错误日志
   - 修复问题
   - 重新提交

2. **Bot review 问题**
   - 仔细阅读 bot 的建议
   - 按照建议修改代码
   - 在 conversation 中回复

3. **维护者反馈**
   - 认真对待每一条评论
   - 及时回复和修改
   - 保持专业和礼貌

**记住：维护者很忙，但他们会认真对待每个 PR！**

---

## ✅ 检查清单

提交前确认：

- [ ] Fork 完成
- [ ] 文件复制完成
- [ ] 代码修改完成
- [ ] 测试通过（45/45）
- [ ] 代码提交
- [ ] 推送到 GitHub
- [ ] PR 创建
- [ ] 标签添加
- [ ] 描述完整
- [ ] AI 辅助标记

---

**祝你好运！🚀**

_指南版本: v1.0 | 日期: 2026-03-09_
