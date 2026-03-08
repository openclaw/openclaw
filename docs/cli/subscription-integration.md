# CLI 订阅账户集成指南

**版本**: 1.0  
**更新日期**: 2026-03-03  
**亲测有效**: ✅ 合法合规，不违反 Anthropic/Google/OpenAI 规定

---

## 🎯 核心原理

通过官方 CLI 工具作为桥梁，将个人订阅额度 (Pro/Max) 共享到 OpenClaw 使用。

**优势**:
- ✅ 不用走 API（省 API 费用）
- ✅ 不用单独在 OpenClaw 配置 auth
- ✅ 合法合规，不违反服务条款
- ✅ 共享现有订阅额度

---

## 🔧 支持的 CLI 工具

| 平台 | CLI 工具 | 订阅类型 | 状态 |
|------|---------|---------|------|
| **Anthropic** | `claude` | Claude Pro/Max | ✅ 已验证 |
| **Google** | `gemini` | Gemini Advanced | ✅ 支持 |
| **OpenAI** | `codex` | Codex/ChatGPT Plus | ✅ 支持 |

---

## 📋 集成步骤

### 方法一：自然语言指令（推荐）

**1. 安装官方 CLI 工具**

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code

# Gemini CLI
npm install -g @google/gemini-cli

# Codex CLI
npm install -g @openai/codex
```

**2. 登录 CLI 工具**

```bash
# Claude
claude login

# Gemini
gemini login

# Codex
codex login
```

**3. 在 OpenClaw 中执行自然语言指令**

打开 OpenClaw（小龙虾），直接说：

```
接入 Claude CLI
```

或

```
接入 Gemini CLI
```

或

```
接入 Codex CLI
```

**4. 设置默认模型**

```
设置 anthropic/cli:claude 为默认模型
```

或

```
设置 google/cli:gemini 为默认模型
```

或

```
设置 openai/cli:codex 为默认模型
```

---

### 方法二：手动配置

**1. 验证 CLI 工具可用**

```bash
claude --version
gemini --version
codex --version
```

**2. 测试 CLI 调用**

```bash
claude "Hello, test connection"
gemini "Hello, test connection"
codex "Hello, test connection"
```

**3. 在 OpenClaw 中配置模型路由**

编辑 `~/.openclaw/config.json` 或对应 Agent 配置：

```json5
{
  "agents": {
    "main": {
      "model": "anthropic/cli:claude"
    },
    "aiboss": {
      "model": "google/cli:gemini"
    },
    "aicode": {
      "model": "openai/cli:codex"
    }
  }
}
```

---

## 🔍 模型标识符

| CLI 工具 | 模型标识符 | 说明 |
|---------|-----------|------|
| Claude | `anthropic/cli:claude` | 使用 Claude Code CLI |
| Gemini | `google/cli:gemini` | 使用 Gemini CLI |
| Codex | `openai/cli:codex` | 使用 Codex CLI |

---

## 📊 额度共享说明

### Claude Pro/Max

| 订阅类型 | 额度 | 共享方式 |
|---------|------|---------|
| **Claude Pro** | 5x 使用量/8 小时 | CLI 调用计入总使用量 |
| **Claude Max** | 更高额度 | CLI 调用计入总使用量 |

**注意**: OpenClaw 通过 CLI 调用会消耗你的订阅额度，请合理规划使用。

### Gemini Advanced

| 订阅类型 | 额度 | 说明 |
|---------|------|------|
| **Gemini Advanced** | 1000 次/天 | 通过 Google One AI Premium 订阅 |

### ChatGPT Plus

| 订阅类型 | 额度 | 说明 |
|---------|------|------|
| **ChatGPT Plus** | 80 次/3 小时 (GPT-4) | GPT-4 使用限制 |

---

## ✅ 验证集成

**测试命令**:

```bash
# 在 OpenClaw 中执行
openclaw status
```

检查模型配置：

```
默认模型：anthropic/cli:claude
状态：✅ 已连接
```

**发送测试消息**:

```
你好，请用 Claude 回复我
```

如果收到 Claude 的回复，说明集成成功！

---

## ⚠️ 注意事项

### 合规性

- ✅ **允许**: 通过官方 CLI 工具调用
- ✅ **允许**: 个人订阅额度自用
- ❌ **禁止**: 转售或商业分发
- ❌ **禁止**: 多用户共享同一订阅

### 使用限制

| 平台 | 限制 | 建议 |
|------|------|------|
| Claude | 5x/8 小时 (Pro) | 用于高优先级任务 |
| Gemini | 1000 次/天 | 用于日常任务 |
| OpenAI | 80 次/3 小时 | 用于代码任务 |

### 故障排除

**问题**: CLI 工具未找到

```bash
# 检查安装
which claude
which gemini
which codex

# 重新安装
npm install -g @anthropic-ai/claude-code
```

**问题**: 登录状态失效

```bash
# 重新登录
claude login
gemini login
codex login
```

**问题**: OpenClaw 无法调用 CLI

```bash
# 检查 PATH
echo $PATH

# 确保 CLI 工具在 PATH 中
ls -la $(which claude)
```

---

## 🎯 最佳实践

### 模型选择策略

| 任务类型 | 推荐模型 | 原因 |
|---------|---------|------|
| **复杂推理** | Claude Max | 最强推理能力 |
| **代码开发** | Codex/GPT-4 | 代码理解优秀 |
| **日常对话** | Gemini | 额度充足，响应快 |
| **长文本处理** | Claude | 200k 上下文窗口 |

### 额度管理

```markdown
## 每日额度检查

- [ ] Claude: 剩余 X/5 次
- [ ] Gemini: 剩余 X/1000 次
- [ ] OpenAI: 剩余 X/80 次

## 任务优先级

P0: Claude Max (高价值任务)
P1: GPT-4 (代码/技术)
P2: Gemini (日常/研究)
```

---

## 📚 相关资源

- **Claude Code**: https://github.com/anthropics/claude-code
- **Gemini CLI**: https://github.com/google/gemini-cli
- **Codex CLI**: https://github.com/openai/codex
- **OpenClaw 文档**: https://docs.openclaw.ai/

---

*最后更新：2026-03-03*  
*亲测有效：✅*
