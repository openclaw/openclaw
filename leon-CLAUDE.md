# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库概览

OpenClaw 是一个多渠道 AI 网关（TypeScript / ESM / Node >= 22），将来自各种消息渠道（WhatsApp、Telegram、Slack、Discord 等）的消息路由到 LLM 提供商。本 fork (`mattheliu/openclaw`) 主要贡献 **ERNIE（百度文心）提供商** 的支持。

- 上游仓库: `upstream` → `https://github.com/openclaw/openclaw.git`
- Fork 仓库: `origin` → `https://github.com/mattheliu/openclaw.git`
- 当前分支: `feat/add-ernie-provider`（对应 PR #7798）

## 常用命令

```bash
# 安装依赖
pnpm install

# 类型检查（CI 使用 tsgo，比 tsc 快）
pnpm tsgo

# 完整检查（格式 + 类型 + 代码检查）
pnpm check

# 格式化检查 / 修复
pnpm format          # 仅检查（oxfmt --check）
pnpm format:fix      # 自动修复（oxfmt --write）

# 构建
pnpm build

# 测试（Vitest）
pnpm test                     # 全量测试
pnpm test -- --run <文件路径>  # 单个测试文件
pnpm test:coverage            # 带覆盖率
pnpm test:fast                # 仅单元测试

# 开发模式运行 CLI
pnpm dev
pnpm openclaw <command>

# 同步上游
git fetch upstream main
git merge upstream/main --no-edit
```

## 项目结构

```
src/
  agents/              # 模型配置、认证、provider 注册
    model-auth.ts             → 环境变量 → API key 映射
    models-config.providers.ts → 所有 provider 的构建函数 + 自动发现
  cli/                 # CLI 入口与命令注册
    program/register.onboard.ts → onboard 命令的 CLI 选项注册
  commands/            # 命令实现
    onboard-types.ts          → AuthChoice / OnboardOptions 类型定义
    onboard-provider-auth-flags.ts → CLI 标志数据驱动定义
    auth-choice-options.ts    → 交互式选择菜单定义
    auth-choice.apply.api-providers.ts → 认证选择的执行逻辑
    onboard-auth.config-core.ts → applyXxxConfig / applyXxxProviderConfig
    onboard-auth.credentials.ts → setXxxApiKey 函数
    onboard-auth.models.ts    → 模型常量 / buildXxxModelDefinition
    onboard-auth.ts           → 统一 re-export 入口
    onboard-non-interactive/local/auth-choice.ts → 非交互式 onboard 流程
  config/              # 配置类型与解析
    types.models.ts           → ModelApi / ModelProviderConfig / ModelDefinitionConfig
  infra/               # 基础设施（网络、安全、存储）
  media/               # 媒体处理管道
  provider-web.ts      # Web 提供商
extensions/            # 插件/扩展（workspace 子包，OAuth 提供商等）
docs/                  # Mintlify 文档
  providers/           # 各 provider 文档（含 ernie.md）
test/                  # 测试工具和 setup
```

## 添加新 API Key 提供商的检查清单

以 ERNIE 为模板，添加一个简单的 API Key 提供商需修改以下文件：

| 步骤 | 文件 | 添加内容 |
|------|------|----------|
| 1 | `src/agents/model-auth.ts` | 环境变量映射 `ernie: "ERNIE_API_KEY"` |
| 2 | `src/agents/models-config.providers.ts` | 常量 + `buildXxxProvider()` + `resolveImplicitProviders()` 注册 |
| 3 | `src/commands/onboard-types.ts` | `AuthChoice` 联合类型 + `AuthChoiceGroupId` + `OnboardOptions` 字段 |
| 4 | `src/commands/onboard-provider-auth-flags.ts` | `ONBOARD_PROVIDER_AUTH_FLAGS` 数组条目 |
| 5 | `src/commands/onboard-auth.models.ts` | 模型常量 + `buildXxxModelDefinition()` |
| 6 | `src/commands/onboard-auth.credentials.ts` | `setXxxApiKey()` 函数 |
| 7 | `src/commands/onboard-auth.config-core.ts` | `applyXxxProviderConfig()` + `applyXxxConfig()` |
| 8 | `src/commands/onboard-auth.ts` | Re-export 新函数 |
| 9 | `src/commands/auth-choice-options.ts` | `AUTH_CHOICE_GROUP_DEFS` 分组 + 可选的 hint/label |
| 10 | `src/commands/auth-choice.preferred-provider.ts` | `"ernie-api-key": "ernie"` 映射 |
| 11 | `src/commands/auth-choice.apply.api-providers.ts` | `SIMPLE_API_KEY_PROVIDER_FLOWS` 条目 |
| 12 | `src/commands/onboard-non-interactive/local/auth-choice.ts` | 非交互式处理分支 |
| 13 | `src/commands/onboard-non-interactive/local/auth-choice-inference.ts` | `AuthChoiceFlagOptions` 类型 |
| 14 | 测试文件（与源码同目录） | 如 `models-config.providers.ernie.test.ts` |
| 15 | `docs/providers/xxx.md` + `docs/providers/index.md` | 文档页面 |

## 关键类型

```typescript
// 模型 API 类型
type ModelApi = "openai-completions" | "anthropic-messages" | "google-generative-ai"
  | "github-copilot" | "bedrock-converse-stream" | "ollama" | "openai-responses";

// Provider 配置
type ProviderConfig = {
  baseUrl: string;
  apiKey?: string;
  api: ModelApi;
  models: ModelDefinitionConfig[];
};

// 模型定义
type ModelDefinitionConfig = {
  id: string; name: string; reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number; maxTokens: number;
};
```

## 合并上游时的注意事项

上游更新频繁，合并 `upstream/main` 时经常出现冲突。核心要点：

1. **上游可能重构 provider 系统**：例如从手动 `.option()` 改为数据驱动的 `ONBOARD_PROVIDER_AUTH_FLAGS` 循环，从手动 if-else 改为 `SIMPLE_API_KEY_PROVIDER_FLOWS` 查找表。合并时需将 ERNIE 适配到新模式。
2. **上游可能将模型折叠到已有 provider**：例如 ERNIE 模型被加入 Qianfan 的 catalog 中，但我们仍需保留独立的 ERNIE provider 入口（`buildErnieProvider`、`setErnieApiKey` 等）。
3. **合并后务必运行 `pnpm tsgo`** 验证类型正确，因为 `tsc --noEmit` 可能因堆内存不足失败。
4. **CI 模拟**：GitHub CI 合并 PR 分支和 base 分支后运行检查。本地可用 `git merge --no-commit upstream/main` 模拟后运行 `pnpm tsgo` 验证。

## 代码风格

- TypeScript (ESM)，严格类型，避免 `any`
- 格式化/检查: `oxfmt` + `oxlint`（不是 Prettier/ESLint）
- 测试与源码同目录，命名为 `*.test.ts`
- 文件控制在 ~500-700 行以内
- 提交前运行 `pnpm check`
- 使用 `scripts/committer "<msg>" <file...>` 创建提交（保持 staging 范围明确）
- 产品名用 **OpenClaw**，CLI/包名/路径用 `openclaw`
