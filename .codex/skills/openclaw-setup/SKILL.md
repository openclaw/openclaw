---
name: openclaw-setup
description: 安装 OpenClaw 并配置 API 模型 provider。当用户说"帮我装 OpenClaw""配置 GLM/Ollama/OpenAI/OpenRouter 模型""换个模型 provider""openai-completions 自定义 provider""openclaw 跑不起来"时使用。覆盖安装、onboarding、provider 配置、gateway 启动、常见排障全流程。
---

# OpenClaw 安装 & API Provider 配置

## 适用场景

- 全新安装 OpenClaw（一键脚本 / npm / 从源码）
- 配置模型 provider（Anthropic、OpenAI、Z.AI/GLM、OpenRouter、Ollama、vLLM、任意 OpenAI-compatible 接口）
- 更换默认模型
- Gateway 无法启动、`openclaw` 命令找不到、provider 认证失败

---

## 一、安装

### 推荐：一键安装脚本

```bash
# macOS / Linux / WSL2
curl -fsSL https://openclaw.ai/install.sh | bash

# Windows PowerShell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

脚本自动检测 Node 版本、安装 CLI、并启动 onboarding 向导。

### 备选：npm / pnpm 手动安装

```bash
# npm
npm install -g openclaw@latest
openclaw onboard --install-daemon

# pnpm（需要额外 approve 构建脚本）
pnpm add -g openclaw@latest
pnpm approve-builds -g        # 选 openclaw, node-llama-cpp, sharp 等
openclaw onboard --install-daemon
```

> macOS 上若 sharp 报错：`SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest`

### 备选：从源码构建（开发用）

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build
pnpm build
pnpm link --global          # 全局注册 openclaw 命令
openclaw onboard --install-daemon
```

开发时不链接全局直接用：`pnpm openclaw <命令>`

---

## 二、Onboarding（首次配置）

安装后运行向导，配置 auth、gateway、可选 channel：

```bash
openclaw onboard --install-daemon
```

向导会引导选择 provider 和 API Key，也可以非交互式直接传参（见下方各 provider）。

---

## 三、验证安装

```bash
openclaw doctor          # 检查配置问题
openclaw gateway status  # gateway 状态
openclaw dashboard       # 在浏览器打开 Control UI（默认 http://127.0.0.1:18789）
```

---

## 四、API Provider 配置

配置文件：`~/.openclaw/openclaw.json`（JSON5 格式，支持注释和尾逗号）

模型引用格式：`provider/model`（例如 `anthropic/claude-opus-4-6`、`zai/glm-5`）

### 4.1 Anthropic（Claude）

```bash
# 交互式
openclaw onboard --auth-choice anthropic-api-key
```

```json5
// ~/.openclaw/openclaw.json
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

### 4.2 OpenAI

```bash
# API Key
openclaw onboard --auth-choice openai-api-key
# Codex 订阅 OAuth
openclaw onboard --auth-choice openai-codex
```

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.2" } } },
}
```

### 4.3 Z.AI / GLM

```bash
openclaw onboard --auth-choice zai-api-key
# 或非交互式
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

GLM 可用 model ID：`glm-5`、`glm-4.7`、`glm-4.6`

### 4.4 OpenRouter（一个 Key 访问众多模型）

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

```json5
{
  env: { OPENROUTER_API_KEY: "sk-or-..." },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-sonnet-4-5" },
    },
  },
}
```

模型 ID 格式：`openrouter/<上游provider>/<model>`

### 4.5 Ollama（本地模型）

```bash
ollama pull gpt-oss:20b      # 先拉模型（需支持 tool calling）
export OLLAMA_API_KEY="ollama-local"
# 或写入配置
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

```json5
{
  agents: {
    defaults: { model: { primary: "ollama/gpt-oss:20b" } },
  },
}
```

> **重要**：不要用 `/v1` URL。OpenClaw 使用 Ollama 原生 API（`http://127.0.0.1:11434`），`/v1` 模式 tool calling 不可靠。

设置 `OLLAMA_API_KEY` 后未显式配置 `models.providers.ollama` 时，自动发现本地 tool-capable 模型。

远程 Ollama（手动指定 host）：

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434",
        apiKey: "ollama-local",
        api: "ollama",
      },
    },
  },
}
```

### 4.6 vLLM（本地 OpenAI-compatible 服务）

```bash
export VLLM_API_KEY="vllm-local"
```

```json5
{
  agents: {
    defaults: { model: { primary: "vllm/your-model-id" } },
  },
}
```

显式配置（vLLM 跑在其他 host 或需要指定 context window）：

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "Local vLLM Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### 4.7 任意 OpenAI-compatible 自定义 Provider

适用于阿里云 DashScope、百度千帆、MiniMax、自建 LLM 网关等任何暴露 `/v1/chat/completions` 接口的服务：

```json5
{
  models: {
    providers: {
      "my-provider": {
        // 自定义 provider 名（任意小写）
        baseUrl: "https://your-endpoint/v1",
        apiKey: "your-api-key",
        api: "openai-completions",
        models: [
          {
            id: "your-model-id",
            name: "My Model",
            reasoning: false, // 若模型有 reasoning_content 输出可设为 true
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "my-provider/your-model-id" },
    },
  },
}
```

**GLM-5 via Aliyun Coding Plan（OpenAI-compat 接入示例）**：

```json5
{
  models: {
    providers: {
      openai: {
        baseUrl: "https://your-aliyun-endpoint/v1",
        apiKey: "your-key",
        api: "openai-completions",
        models: [
          {
            id: "glm-5",
            name: "GLM-5",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: { model: { primary: "openai/glm-5" } },
  },
}
```

---

## 五、更改默认模型（不重新 onboard）

```bash
# CLI 一行命令
openclaw config set agents.defaults.model.primary "zai/glm-5"

# 或直接编辑 ~/.openclaw/openclaw.json
```

Config UI：浏览器打开 `http://127.0.0.1:18789` → Config 标签页 → 修改 → 保存（Gateway 会热重载）

---

## 六、Gateway 启动 / 重启

```bash
# 全局安装时
openclaw gateway run --bind loopback --port 18789 --force

# 从源码开发时（非全局安装）
pnpm openclaw gateway run --bind loopback --port 18789 --force

# 后台运行（写日志到 /tmp）
nohup pnpm openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &

# 重启（先 kill 再启动）
pkill -9 -f openclaw-gateway || true
nohup pnpm openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &

# 验证
tail -n 20 /tmp/openclaw-gateway.log
openclaw channels status --probe
```

macOS 用 menu bar app 启动/停止 Gateway，不要用 tmux/ad-hoc 进程。

---

## 七、常见问题

### `openclaw: command not found`

```bash
node -v && npm -v
npm prefix -g          # 查全局 bin 路径
echo $PATH             # 确认是否包含上面的路径
# 修复：
export PATH="$(npm prefix -g)/bin:$PATH"
# 写入 ~/.bashrc 或 ~/.zshrc 后重开终端
```

### Gateway 不起来 / `nohup: failed to run command 'openclaw'`

说明 `openclaw` 不在 PATH。从源码运行时改用 `pnpm openclaw`：

```bash
nohup pnpm openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

### Config 验证失败 / Gateway 拒绝启动

```bash
openclaw doctor        # 定位问题
openclaw doctor --fix  # 自动修复
```

### Control UI 显示"assets not found"

UI 资源未构建。从源码运行时执行：

```bash
pnpm ui:build
```

然后重启 Gateway。

### Provider 认证失败（401/403）

1. 确认 API Key 正确写入 config（`openclaw config get env`）
2. 确认 `baseUrl` 与 Key 类型匹配（常见于阿里云百炼 `sk-` vs Coding Plan `sk-sp-`）
3. 运行 `openclaw doctor` 查配置问题
4. 检查是否有旧 OAuth token 优先级覆盖（`openclaw auth status`）
