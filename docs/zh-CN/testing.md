---
read_when:
  - 在本地或 CI 中运行测试
  - 为模型/提供商缺陷添加回归测试
  - 调试 Gateway网关 + 智能体行为
summary: 测试工具包：单元/端到端/实时测试套件、Docker 运行器，以及每项测试的覆盖范围
title: 测试
x-i18n:
  generated_at: "2026-02-01T21:41:25Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 92a273d6103f6d40806c9393d69f66ebfb6ac7a418e2592312d8be6d89c79f6f
  source_path: testing.md
  workflow: 15
---

# 测试

OpenClaw 拥有三个 Vitest 测试套件（单元/集成、端到端、实时）和一小组 Docker 运行器。

本文档是一份"我们如何测试"指南：

- 每个套件覆盖的内容（以及它刻意*不*覆盖的内容）
- 常见工作流（本地、推送前、调试）应运行哪些命令
- 实时测试如何发现凭证并选择模型/提供商
- 如何为真实世界的模型/提供商问题添加回归测试

## 快速上手

日常使用：

- 完整门禁（推送前预期运行）：`pnpm lint && pnpm build && pnpm test`

当你修改了测试或想要额外的信心时：

- 覆盖率门禁：`pnpm test:coverage`
- 端到端套件：`pnpm test:e2e`

调试真实提供商/模型时（需要真实凭证）：

- 实时套件（模型 + Gateway网关工具/图像探测）：`pnpm test:live`

提示：当你只需要一个失败用例时，建议通过下文描述的允许列表环境变量来缩小实时测试范围。

## 测试套件（在哪里运行什么）

将这些套件视为"逐步增加的真实性"（同时也增加了不稳定性/成本）：

### 单元/集成测试（默认）

- 命令：`pnpm test`
- 配置：`vitest.config.ts`
- 文件：`src/**/*.test.ts`
- 范围：
  - 纯单元测试
  - 进程内集成测试（Gateway网关认证、路由、工具、解析、配置）
  - 已知缺陷的确定性回归测试
- 预期：
  - 在 CI 中运行
  - 不需要真实密钥
  - 应该快速且稳定

### 端到端测试（Gateway网关冒烟测试）

- 命令：`pnpm test:e2e`
- 配置：`vitest.e2e.config.ts`
- 文件：`src/**/*.e2e.test.ts`
- 范围：
  - 多实例 Gateway网关端到端行为
  - WebSocket/HTTP 接口、节点配对和更复杂的网络操作
- 预期：
  - 在 CI 中运行（当在流水线中启用时）
  - 不需要真实密钥
  - 比单元测试涉及更多组件（可能更慢）

### 实时测试（真实提供商 + 真实模型）

- 命令：`pnpm test:live`
- 配置：`vitest.live.config.ts`
- 文件：`src/**/*.live.test.ts`
- 默认：通过 `pnpm test:live` **启用**（设置 `OPENCLAW_LIVE_TEST=1`）
- 范围：
  - "这个提供商/模型*今天*在真实凭证下是否真正工作？"
  - 捕获提供商格式变更、工具调用异常、认证问题和速率限制行为
- 预期：
  - 设计上不保证 CI 稳定（真实网络、真实提供商策略、配额、中断）
  - 会花费金钱/消耗速率限制
  - 建议运行缩小范围的子集而不是"所有内容"
  - 实时运行会加载 `~/.profile` 以获取缺失的 API 密钥
  - Anthropic 密钥轮换：设置 `OPENCLAW_LIVE_ANTHROPIC_KEYS="sk-...,sk-..."`（或 `OPENCLAW_LIVE_ANTHROPIC_KEY=sk-...`）或多个 `ANTHROPIC_API_KEY*` 变量；测试会在遇到速率限制时重试

## 我应该运行哪个套件？

使用此决策表：

- 编辑逻辑/测试：运行 `pnpm test`（如果改动较多则加上 `pnpm test:coverage`）
- 涉及 Gateway网关网络/WS 协议/配对：加上 `pnpm test:e2e`
- 调试"我的机器人挂了"/提供商特定故障/工具调用：运行缩小范围的 `pnpm test:live`

## 实时测试：模型冒烟测试（profile 密钥）

实时测试分为两层，以便隔离故障：

- "直接模型"告诉我们提供商/模型在给定密钥下是否能正常响应。
- "Gateway网关冒烟测试"告诉我们完整的 Gateway网关 + 智能体管道对该模型是否工作（会话、历史、工具、沙箱策略等）。

### 第一层：直接模型补全（无 Gateway网关）

- 测试：`src/agents/models.profiles.live.test.ts`
- 目标：
  - 枚举已发现的模型
  - 使用 `getApiKeyForModel` 选择你有凭证的模型
  - 对每个模型运行一个小型补全（以及需要时的定向回归测试）
- 如何启用：
  - `pnpm test:live`（或直接调用 Vitest 时设置 `OPENCLAW_LIVE_TEST=1`）
- 设置 `OPENCLAW_LIVE_MODELS=modern`（或 `all`，modern 的别名）来实际运行此套件；否则会跳过以保持 `pnpm test:live` 聚焦于 Gateway网关冒烟测试
- 如何选择模型：
  - `OPENCLAW_LIVE_MODELS=modern` 运行现代允许列表（Opus/Sonnet/Haiku 4.5、GPT-5.x + Codex、Gemini 3、GLM 4.7、MiniMax M2.1、Grok 4）
  - `OPENCLAW_LIVE_MODELS=all` 是现代允许列表的别名
  - 或 `OPENCLAW_LIVE_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-5,..."`（逗号分隔的允许列表）
- 如何选择提供商：
  - `OPENCLAW_LIVE_PROVIDERS="google,google-antigravity,google-gemini-cli"`（逗号分隔的允许列表）
- 密钥来源：
  - 默认：profile 存储和环境变量回退
  - 设置 `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` 以强制仅使用 **profile 存储**
- 为何存在：
  - 将"提供商 API 故障/密钥无效"与"Gateway网关智能体管道故障"分离
  - 包含小型、隔离的回归测试（示例：OpenAI Responses/Codex Responses 推理重放 + 工具调用流程）

### 第二层：Gateway网关 + 开发智能体冒烟测试（"@openclaw"实际做什么）

- 测试：`src/gateway/gateway-models.profiles.live.test.ts`
- 目标：
  - 启动一个进程内 Gateway网关
  - 创建/更新一个 `agent:dev:*` 会话（每次运行覆盖模型）
  - 迭代有密钥的模型并断言：
    - "有意义的"响应（无工具）
    - 真实工具调用可用（读取探测）
    - 可选的额外工具探测（执行+读取探测）
    - OpenAI 回归路径（仅工具调用 → 后续请求）保持正常
- 探测详情（便于快速解释故障）：
  - `read` 探测：测试在工作区写入一个随机数文件，要求智能体 `read` 它并回显随机数。
  - `exec+read` 探测：测试要求智能体通过 `exec` 将随机数写入临时文件，然后 `read` 回来。
  - image 探测：测试附加一个生成的 PNG（猫 + 随机代码），期望模型返回 `cat <CODE>`。
  - 实现参考：`src/gateway/gateway-models.profiles.live.test.ts` 和 `src/gateway/live-image-probe.ts`。
- 如何启用：
  - `pnpm test:live`（或直接调用 Vitest 时设置 `OPENCLAW_LIVE_TEST=1`）
- 如何选择模型：
  - 默认：现代允许列表（Opus/Sonnet/Haiku 4.5、GPT-5.x + Codex、Gemini 3、GLM 4.7、MiniMax M2.1、Grok 4）
  - `OPENCLAW_LIVE_GATEWAY_MODELS=all` 是现代允许列表的别名
  - 或设置 `OPENCLAW_LIVE_GATEWAY_MODELS="provider/model"`（或逗号分隔列表）来缩小范围
- 如何选择提供商（避免"OpenRouter 全部"）：
  - `OPENCLAW_LIVE_GATEWAY_PROVIDERS="google,google-antigravity,google-gemini-cli,openai,anthropic,zai,minimax"`（逗号分隔的允许列表）
- 工具 + 图像探测在此实时测试中始终开启：
  - `read` 探测 + `exec+read` 探测（工具压力测试）
  - 当模型声明支持图像输入时运行 image 探测
  - 流程（概要）：
    - 测试生成一个包含"CAT"+ 随机代码的小 PNG（`src/gateway/live-image-probe.ts`）
    - 通过 `agent` `attachments: [{ mimeType: "image/png", content: "<base64>" }]` 发送
    - Gateway网关将附件解析为 `images[]`（`src/gateway/server-methods/agent.ts` + `src/gateway/chat-attachments.ts`）
    - 内嵌智能体将多模态用户消息转发给模型
    - 断言：回复包含 `cat` + 代码（OCR 容差：允许轻微错误）

提示：要查看你的机器上可以测试哪些内容（以及确切的 `provider/model` ID），运行：

```bash
openclaw models list
openclaw models list --json
```

## 实时测试：Anthropic setup-token 冒烟测试

- 测试：`src/agents/anthropic.setup-token.live.test.ts`
- 目标：验证 Claude Code CLI setup-token（或粘贴的 setup-token profile）能否完成 Anthropic 提示。
- 启用：
  - `pnpm test:live`（或直接调用 Vitest 时设置 `OPENCLAW_LIVE_TEST=1`）
  - `OPENCLAW_LIVE_SETUP_TOKEN=1`
- 令牌来源（选一个）：
  - Profile：`OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test`
  - 原始令牌：`OPENCLAW_LIVE_SETUP_TOKEN_VALUE=sk-ant-oat01-...`
- 模型覆盖（可选）：
  - `OPENCLAW_LIVE_SETUP_TOKEN_MODEL=anthropic/claude-opus-4-5`

设置示例：

```bash
openclaw models auth paste-token --provider anthropic --profile-id anthropic:setup-token-test
OPENCLAW_LIVE_SETUP_TOKEN=1 OPENCLAW_LIVE_SETUP_TOKEN_PROFILE=anthropic:setup-token-test pnpm test:live src/agents/anthropic.setup-token.live.test.ts
```

## 实时测试：CLI 后端冒烟测试（Claude Code CLI 或其他本地 CLI）

- 测试：`src/gateway/gateway-cli-backend.live.test.ts`
- 目标：使用本地 CLI 后端验证 Gateway网关 + 智能体管道，不影响你的默认配置。
- 启用：
  - `pnpm test:live`（或直接调用 Vitest 时设置 `OPENCLAW_LIVE_TEST=1`）
  - `OPENCLAW_LIVE_CLI_BACKEND=1`
- 默认值：
  - 模型：`claude-cli/claude-sonnet-4-5`
  - 命令：`claude`
  - 参数：`["-p","--output-format","json","--dangerously-skip-permissions"]`
- 覆盖（可选）：
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-opus-4-5"`
  - `OPENCLAW_LIVE_CLI_BACKEND_MODEL="codex-cli/gpt-5.2-codex"`
  - `OPENCLAW_LIVE_CLI_BACKEND_COMMAND="/full/path/to/claude"`
  - `OPENCLAW_LIVE_CLI_BACKEND_ARGS='["-p","--output-format","json","--permission-mode","bypassPermissions"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_CLEAR_ENV='["ANTHROPIC_API_KEY","ANTHROPIC_API_KEY_OLD"]'`
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_PROBE=1` 发送真实图像附件（路径注入到提示中）。
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_ARG="--image"` 将图像文件路径作为 CLI 参数传递而非提示注入。
  - `OPENCLAW_LIVE_CLI_BACKEND_IMAGE_MODE="repeat"`（或 `"list"`）控制设置 `IMAGE_ARG` 时图像参数的传递方式。
  - `OPENCLAW_LIVE_CLI_BACKEND_RESUME_PROBE=1` 发送第二轮并验证恢复流程。
- `OPENCLAW_LIVE_CLI_BACKEND_DISABLE_MCP_CONFIG=0` 保持 Claude Code CLI MCP 配置启用（默认使用临时空文件禁用 MCP 配置）。

示例：

```bash
OPENCLAW_LIVE_CLI_BACKEND=1 \
  OPENCLAW_LIVE_CLI_BACKEND_MODEL="claude-cli/claude-sonnet-4-5" \
  pnpm test:live src/gateway/gateway-cli-backend.live.test.ts
```

### 推荐的实时测试配方

缩小范围的、明确的允许列表最快且最不容易出问题：

- 单个模型，直接测试（无 Gateway网关）：
  - `OPENCLAW_LIVE_MODELS="openai/gpt-5.2" pnpm test:live src/agents/models.profiles.live.test.ts`

- 单个模型，Gateway网关冒烟测试：
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- 跨多个提供商的工具调用：
  - `OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,anthropic/claude-opus-4-5,google/gemini-3-flash-preview,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

- Google 专项（Gemini API 密钥 + Antigravity）：
  - Gemini（API 密钥）：`OPENCLAW_LIVE_GATEWAY_MODELS="google/gemini-3-flash-preview" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`
  - Antigravity（OAuth）：`OPENCLAW_LIVE_GATEWAY_MODELS="google-antigravity/claude-opus-4-5-thinking,google-antigravity/gemini-3-pro-high" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

注意：

- `google/...` 使用 Gemini API（API 密钥）。
- `google-antigravity/...` 使用 Antigravity OAuth 桥接（Cloud Code Assist 风格的智能体端点）。
- `google-gemini-cli/...` 使用你机器上的本地 Gemini CLI（独立的认证 + 工具调用特性）。
- Gemini API 与 Gemini CLI：
  - API：OpenClaw 通过 HTTP 调用 Google 的托管 Gemini API（API 密钥/profile 认证）；这是大多数用户所说的"Gemini"。
  - CLI：OpenClaw 调用本地 `gemini` 二进制文件；它有自己的认证，行为可能不同（流式传输/工具支持/版本差异）。

## 实时测试：模型矩阵（我们覆盖的内容）

没有固定的"CI 模型列表"（实时测试是可选的），但以下是在有密钥的开发机器上建议定期覆盖的**推荐**模型。

### 现代冒烟测试集（工具调用 + 图像）

这是我们期望保持正常工作的"常用模型"运行：

- OpenAI（非 Codex）：`openai/gpt-5.2`（可选：`openai/gpt-5.1`）
- OpenAI Codex：`openai-codex/gpt-5.2`（可选：`openai-codex/gpt-5.2-codex`）
- Anthropic：`anthropic/claude-opus-4-5`（或 `anthropic/claude-sonnet-4-5`）
- Google（Gemini API）：`google/gemini-3-pro-preview` 和 `google/gemini-3-flash-preview`（避免使用较旧的 Gemini 2.x 模型）
- Google（Antigravity）：`google-antigravity/claude-opus-4-5-thinking` 和 `google-antigravity/gemini-3-flash`
- Z.AI（GLM）：`zai/glm-4.7`
- MiniMax：`minimax/minimax-m2.1`

运行带工具 + 图像的 Gateway网关冒烟测试：
`OPENCLAW_LIVE_GATEWAY_MODELS="openai/gpt-5.2,openai-codex/gpt-5.2,anthropic/claude-opus-4-5,google/gemini-3-pro-preview,google/gemini-3-flash-preview,google-antigravity/claude-opus-4-5-thinking,google-antigravity/gemini-3-flash,zai/glm-4.7,minimax/minimax-m2.1" pnpm test:live src/gateway/gateway-models.profiles.live.test.ts`

### 基线：工具调用（Read + 可选 Exec）

每个提供商系列至少选择一个：

- OpenAI：`openai/gpt-5.2`（或 `openai/gpt-5-mini`）
- Anthropic：`anthropic/claude-opus-4-5`（或 `anthropic/claude-sonnet-4-5`）
- Google：`google/gemini-3-flash-preview`（或 `google/gemini-3-pro-preview`）
- Z.AI（GLM）：`zai/glm-4.7`
- MiniMax：`minimax/minimax-m2.1`

可选的额外覆盖（锦上添花）：

- xAI：`xai/grok-4`（或最新可用版本）
- Mistral：`mistral/`…（选择一个你启用的支持工具的模型）
- Cerebras：`cerebras/`…（如果你有访问权限）
- LM Studio：`lmstudio/`…（本地；工具调用取决于 API 模式）

### 视觉：图像发送（附件 → 多模态消息）

在 `OPENCLAW_LIVE_GATEWAY_MODELS` 中至少包含一个支持图像的模型（Claude/Gemini/OpenAI 视觉能力变体等）以测试图像探测。

### 聚合器/替代网关

如果你启用了密钥，我们还支持通过以下方式测试：

- OpenRouter：`openrouter/...`（数百个模型；使用 `openclaw models scan` 查找支持工具+图像的候选模型）
- OpenCode Zen：`opencode/...`（通过 `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY` 认证）

如果你有凭证/配置，可以在实时矩阵中包含更多提供商：

- 内置：`openai`、`openai-codex`、`anthropic`、`google`、`google-vertex`、`google-antigravity`、`google-gemini-cli`、`zai`、`openrouter`、`opencode`、`xai`、`groq`、`cerebras`、`mistral`、`github-copilot`
- 通过 `models.providers`（自定义端点）：`minimax`（云/API），以及任何 OpenAI/Anthropic 兼容代理（LM Studio、vLLM、LiteLLM 等）

提示：不要试图在文档中硬编码"所有模型"。权威列表是你机器上 `discoverModels(...)` 返回的内容 + 可用的密钥。

## 凭证（切勿提交）

实时测试以与 CLI 相同的方式发现凭证。实际影响：

- 如果 CLI 能工作，实时测试应该能找到相同的密钥。
- 如果实时测试提示"无凭证"，按照调试 `openclaw models list`/模型选择的方式来调试。

- Profile 存储：`~/.openclaw/credentials/`（首选；测试中"profile 密钥"的含义）
- 配置：`~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）

如果你想依赖环境变量密钥（例如在 `~/.profile` 中导出的），在 `source ~/.profile` 之后运行本地测试，或使用下面的 Docker 运行器（它们可以将 `~/.profile` 挂载到容器中）。

## Deepgram 实时测试（音频转录）

- 测试：`src/media-understanding/providers/deepgram/audio.live.test.ts`
- 启用：`DEEPGRAM_API_KEY=... DEEPGRAM_LIVE_TEST=1 pnpm test:live src/media-understanding/providers/deepgram/audio.live.test.ts`

## Docker 运行器（可选的"在 Linux 中工作"检查）

这些在仓库 Docker 镜像中运行 `pnpm test:live`，挂载你的本地配置目录和工作区（如果挂载了 `~/.profile` 则会加载）：

- 直接模型：`pnpm test:docker:live-models`（脚本：`scripts/test-live-models-docker.sh`）
- Gateway网关 + 开发智能体：`pnpm test:docker:live-gateway`（脚本：`scripts/test-live-gateway-models-docker.sh`）
- 新手引导向导（TTY，完整脚手架）：`pnpm test:docker:onboard`（脚本：`scripts/e2e/onboard-docker.sh`）
- Gateway网关网络（两个容器，WS 认证 + 健康检查）：`pnpm test:docker:gateway-network`（脚本：`scripts/e2e/gateway-network-docker.sh`）
- 插件（自定义扩展加载 + 注册表冒烟测试）：`pnpm test:docker:plugins`（脚本：`scripts/e2e/plugins-docker.sh`）

常用环境变量：

- `OPENCLAW_CONFIG_DIR=...`（默认：`~/.openclaw`）挂载到 `/home/node/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=...`（默认：`~/.openclaw/workspace`）挂载到 `/home/node/.openclaw/workspace`
- `OPENCLAW_PROFILE_FILE=...`（默认：`~/.profile`）挂载到 `/home/node/.profile` 并在运行测试前加载
- `OPENCLAW_LIVE_GATEWAY_MODELS=...` / `OPENCLAW_LIVE_MODELS=...` 缩小运行范围
- `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1` 确保凭证来自 profile 存储（而非环境变量）

## 文档完整性检查

文档编辑后运行文档检查：`pnpm docs:list`。

## 离线回归测试（CI 安全）

这些是不需要真实提供商的"真实管道"回归测试：

- Gateway网关工具调用（模拟 OpenAI，真实 Gateway网关 + 智能体循环）：`src/gateway/gateway.tool-calling.mock-openai.test.ts`
- Gateway网关向导（WS `wizard.start`/`wizard.next`，写入配置 + 认证强制执行）：`src/gateway/gateway.wizard.e2e.test.ts`

## 智能体可靠性评估（Skills）

我们已经有一些 CI 安全的测试，其行为类似于"智能体可靠性评估"：

- 通过真实 Gateway网关 + 智能体循环进行的模拟工具调用（`src/gateway/gateway.tool-calling.mock-openai.test.ts`）。
- 验证会话连接和配置效果的端到端向导流程（`src/gateway/gateway.wizard.e2e.test.ts`）。

Skills 方面仍然缺少的内容（参见[Skills](/tools/skills)）：

- **决策：** 当 Skills 列在提示中时，智能体是否选择了正确的 Skills（或避免了不相关的 Skills）？
- **合规：** 智能体是否在使用前阅读了 `SKILL.md` 并遵循了必需的步骤/参数？
- **工作流契约：** 多轮场景，断言工具顺序、会话历史延续和沙箱边界。

未来的评估应优先保持确定性：

- 使用模拟提供商的场景运行器，断言工具调用 + 顺序、Skills 文件读取和会话连接。
- 一小组以 Skills 为重点的场景（使用与避免、门控、提示注入）。
- 可选的实时评估（可选启用，通过环境变量控制）仅在 CI 安全套件就位后进行。

## 添加回归测试（指南）

当你修复了在实时测试中发现的提供商/模型问题时：

- 如果可能，添加 CI 安全的回归测试（模拟/存根提供商，或捕获确切的请求形状转换）
- 如果本质上只能进行实时测试（速率限制、认证策略），保持实时测试范围小且通过环境变量可选启用
- 优先针对能捕获缺陷的最小层：
  - 提供商请求转换/重放缺陷 → 直接模型测试
  - Gateway网关会话/历史/工具管道缺陷 → Gateway网关实时冒烟测试或 CI 安全的 Gateway网关模拟测试
