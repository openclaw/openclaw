/**
 * Anthropic 提供者插件的运行时注册模块
 * 负责注册 Anthropic 模型提供者、CLI 后端和媒体理解提供者
 */

// 从 openclaw 插件 SDK 导入 CLI 运行时工具函数
import { formatCliCommand, parseDurationMs } from "openclaw/plugin-sdk/cli-runtime";

// 从 openclaw 插件 SDK 导入插件 API 类型定义
import type {
  //  OpenClaw 插件 API 接口类型
  OpenClawPluginApi,
  // 提供者认证上下文类型，用于认证流程
  ProviderAuthContext,
  // 提供者非交互式认证上下文类型，用于无人值守认证
  ProviderAuthMethodNonInteractiveContext,
  // 提供者解析动态模型上下文类型
  ProviderResolveDynamicModelContext,
  // 提供者规范化已解析模型上下文类型
  ProviderNormalizeResolvedModelContext,
  // 提供者运行时模型类型
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";

// 从认证配置文件导入认证相关的工具函数和类型
import {
  // 应用认证配置文件
  applyAuthProfileConfig,
  // 认证配置文件存储类型
  type AuthProfileStore,
  // 构建令牌配置文件 ID
  buildTokenProfileId,
  // 创建提供者 API 密钥认证方法
  createProviderApiKeyAuthMethod,
  // 列出提供者关联的认证配置文件
  listProfilesForProvider,
  // OpenClaw 配置类型别名
  type OpenClawConfig as ProviderAuthConfig,
  // 提供者认证结果类型
  type ProviderAuthResult,
  // 为旧版默认配置建议 OAuth 配置文件 ID
  suggestOAuthProfileIdForLegacyDefault,
  // 更新或插入认证配置文件
  upsertAuthProfile,
  // 验证 Anthropic 设置令牌
  validateAnthropicSetupToken,
} from "openclaw/plugin-sdk/provider-auth";

// 从提供者模型共享模块导入模型相关的工具函数和类型
import {
  // 克隆第一个模板模型
  cloneFirstTemplateModel,
  // 检查是否是 Claude Opus 4.7 模型 ID
  isClaudeOpus47ModelId,
  // 提供者插件类型
  type ProviderPlugin,
  // 解析 Claude 思考配置文件
  resolveClaudeThinkingProfile,
} from "openclaw/plugin-sdk/provider-model-shared";

// 从提供者用量模块导入获取 Claude 用量的函数
import { fetchClaudeUsage } from "openclaw/plugin-sdk/provider-usage";

// 从文本运行时模块导入规范化小写字符串的函数
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

// 从当前目录的 cli-auth-seam.js 导入 Claude CLI 认证相关功能
import * as claudeCliAuth from "./cli-auth-seam.js";

// 从当前目录的 cli-backend.js 导入构建 Anthropic CLI 后端的函数
import { buildAnthropicCliBackend } from "./cli-backend.js";

// 从当前目录的 cli-migration.js 导入构建 Anthropic CLI 迁移结果的函数
import { buildAnthropicCliMigrationResult } from "./cli-migration.js";

// 从当前目录的 cli-shared.js 导入共享的 CLI 常量
import {
  // Claude CLI 后端 ID
  CLAUDE_CLI_BACKEND_ID,
  // Claude CLI 默认允许列表引用
  CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS,
  // Claude CLI 默认模型引用
  CLAUDE_CLI_DEFAULT_MODEL_REF,
} from "./cli-shared.js";

// 从当前目录的 config-defaults.js 导入配置相关的函数
import {
  // 应用 Anthropic 配置默认值
  applyAnthropicConfigDefaults,
  // 规范化 Anthropic 提供者配置
  normalizeAnthropicProviderConfigForProvider,
} from "./config-defaults.js";

// 从当前目录的 media-understanding-provider.js 导入媒体理解提供者
import { anthropicMediaUnderstandingProvider } from "./media-understanding-provider.js";

// 从当前目录的 replay-policy.js 导入构建 Anthropic 回放策略的函数
import { buildAnthropicReplayPolicy } from "./replay-policy.js";

// 从当前目录的 stream-wrappers.js 导入封装 Anthropic 提供者流的函数
import { wrapAnthropicProviderStream } from "./stream-wrappers.js";

/**
 * 提供者 ID 常量，用于标识 Anthropic 提供者
 */
const PROVIDER_ID = "anthropic";

/**
 * 默认的 Anthropic 模型引用，格式为 "提供者/模型名称"
 */
const DEFAULT_ANTHROPIC_MODEL = "anthropic/claude-opus-4-7";

/**
 * Anthropic Opus 4.7 模型 ID（使用短横线格式）
 */
const ANTHROPIC_OPUS_47_MODEL_ID = "claude-opus-4-7";

/**
 * Anthropic Opus 4.7 模型 ID（使用点号格式）
 */
const ANTHROPIC_OPUS_47_DOT_MODEL_ID = "claude-opus-4.7";

/**
 * Opus 4.7 模型的上下文令牌数量（1MB）
 */
const ANTHROPIC_OPUS_47_CONTEXT_TOKENS = 1_048_576;

/**
 * Anthropic Opus 4.6 模型 ID（使用短横线格式）
 */
const ANTHROPIC_OPUS_46_MODEL_ID = "claude-opus-4-6";

/**
 * Anthropic Opus 4.6 模型 ID（使用点号格式）
 */
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";

/**
 * Opus 4.7 模板模型 ID 列表，用于向前兼容
 * 包括 Opus 4.6 和 4.5 系列模型
 */
const ANTHROPIC_OPUS_47_TEMPLATE_MODEL_IDS = [
  // Opus 4.6 短横线格式
  ANTHROPIC_OPUS_46_MODEL_ID,
  // Opus 4.6 点号格式
  ANTHROPIC_OPUS_46_DOT_MODEL_ID,
  // Opus 4.5 短横线格式
  "claude-opus-4-5",
  // Opus 4.5 点号格式
  "claude-opus-4.5",
] as const;

/**
 * Opus 4.5 模板模型 ID 列表
 */
const ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"] as const;

/**
 * Anthropic Sonnet 4.6 模型 ID（使用短横线格式）
 */
const ANTHROPIC_SONNET_46_MODEL_ID = "claude-sonnet-4-6";

/**
 * Anthropic Sonnet 4.6 模型 ID（使用点号格式）
 */
const ANTHROPIC_SONNET_46_DOT_MODEL_ID = "claude-sonnet-4.6";

/**
 * Sonnet 4.5 模板模型 ID 列表
 */
const ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS = ["claude-sonnet-4-5", "claude-sonnet-4.5"] as const;

/**
 * Anthropic 现代模型前缀列表，用于识别新型号
 */
const ANTHROPIC_MODERN_MODEL_PREFIXES = [
  // Opus 4.7 系列
  "claude-opus-4-7",
  // Opus 4.6 系列
  "claude-opus-4-6",
  // Sonnet 4.6 系列
  "claude-sonnet-4-6",
  // Opus 4.5 系列
  "claude-opus-4-5",
  // Sonnet 4.5 系列
  "claude-sonnet-4-5",
  // Haiku 4.5 系列
  "claude-haiku-4-5",
] as const;

/**
 * Anthropic 设置令牌认证的说明信息数组
 */
const ANTHROPIC_SETUP_TOKEN_NOTE_LINES = [
  // 说明支持设置令牌认证
  "Anthropic setup-token auth is supported in OpenClaw.",
  // 说明优先使用 Claude CLI 重用（如果主机上可用）
  "OpenClaw prefers Claude CLI reuse when it is available on the host.",
  // 说明 Anthropic 工作人员确认此路径再次可用
  "Anthropic staff told us this OpenClaw path is allowed again.",
  // 提供直接 API 计费路径的替代命令
  `If you want a direct API billing path instead, use ${formatCliCommand("openclaw models auth login --provider anthropic --method api-key --set-default")} or ${formatCliCommand("openclaw models auth login --provider anthropic --method cli --set-default")}.`,
] as const;

/**
 * 将 Claude CLI 允许列表引用规范化为 anthropic 前缀格式
 * 例如：claude-backend/claude-opus-4-7 -> anthropic/claude-opus-4-7
 */
const CLAUDE_CLI_CANONICAL_ALLOWLIST_REFS = CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS.map((ref) =>
  // 检查引用是否以 claude-backend/ 开头
  ref.startsWith(`${CLAUDE_CLI_BACKEND_ID}/`)
    // 如果是，则替换为 anthropic/ 前缀
    ? `anthropic/${ref.slice(CLAUDE_CLI_BACKEND_ID.length + 1)}`
    // 否则保持原样
    : ref,
);

/**
 * 将 Claude CLI 默认模型引用规范化为 anthropic 前缀格式
 */
const CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF = CLAUDE_CLI_DEFAULT_MODEL_REF.startsWith(
  `${CLAUDE_CLI_BACKEND_ID}/`,
)
  // 如果以 claude-backend/ 开头，则替换为 anthropic/ 前缀
  ? `anthropic/${CLAUDE_CLI_DEFAULT_MODEL_REF.slice(CLAUDE_CLI_BACKEND_ID.length + 1)}`
  // 否则保持原样
  : CLAUDE_CLI_DEFAULT_MODEL_REF;

/**
 * 规范化 Anthropic 设置令牌输入
 * 移除所有空白字符
 * @param value - 原始令牌输入
 * @returns 规范化后的令牌
 */
function normalizeAnthropicSetupTokenInput(value: string): string {
  // 使用正则表达式替换所有空白字符为空字符串，然后去除首尾空白
  return value.replaceAll(/\s+/g, "").trim();
}

/**
 * 解析 Anthropic 设置令牌配置文件 ID
 * @param rawProfileId - 原始配置文件 ID
 * @returns 规范化的配置文件 ID
 */
function resolveAnthropicSetupTokenProfileId(rawProfileId?: unknown): string {
  // 检查是否是字符串类型
  if (typeof rawProfileId === "string") {
    // 去除首尾空白
    const trimmed = rawProfileId.trim();
    // 如果非空
    if (trimmed.length > 0) {
      // 如果已包含 anthropic: 前缀，直接返回
      if (trimmed.startsWith(`${PROVIDER_ID}:`)) {
        return trimmed;
      }
      // 否则构建带前缀的配置文件 ID
      return buildTokenProfileId({ provider: PROVIDER_ID, name: trimmed });
    }
  }
  // 默认返回 anthropic:default
  return `${PROVIDER_ID}:default`;
}

/**
 * 解析 Anthropic 设置令牌过期时间
 * @param rawExpiresIn - 原始过期时间字符串（如 "30d"）
 * @returns 过期时间戳（毫秒），如果无效则返回 undefined
 */
function resolveAnthropicSetupTokenExpiry(rawExpiresIn?: unknown): number | undefined {
  // 检查是否是有效字符串
  if (typeof rawExpiresIn !== "string" || rawExpiresIn.trim().length === 0) {
    return undefined;
  }
  // 解析持续时间并加上当前时间戳
  // 默认单位为天（d）
  return Date.now() + parseDurationMs(rawExpiresIn.trim(), { defaultUnit: "d" });
}

/**
 * 执行 Anthropic 设置令牌认证流程
 * 这是认证向导的主要执行函数
 * @param ctx - 提供者认证上下文
 * @returns 认证结果，包含配置文件、默认模型和说明
 */
async function runAnthropicSetupTokenAuth(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  // 从选项中获取提供的令牌（如果存在）
  const providedToken =
    typeof ctx.opts?.token === "string" && ctx.opts.token.trim().length > 0
      ? normalizeAnthropicSetupTokenInput(ctx.opts.token)
      : undefined;

  // 如果没有提供令牌，提示用户输入
  const token =
    providedToken ??
    normalizeAnthropicSetupTokenInput(
      await ctx.prompter.text({
        // 输入提示消息
        message: "Paste Anthropic setup-token",
        // 验证函数，确保令牌有效
        validate: (value) => validateAnthropicSetupToken(normalizeAnthropicSetupTokenInput(value)),
      }),
    );

  // 验证令牌
  const tokenError = validateAnthropicSetupToken(token);
  // 如果验证失败，抛出错误
  if (tokenError) {
    throw new Error(tokenError);
  }

  // 解析配置文件 ID
  const profileId = resolveAnthropicSetupTokenProfileId(ctx.opts?.tokenProfileId);
  // 解析过期时间
  const expires = resolveAnthropicSetupTokenExpiry(ctx.opts?.tokenExpiresIn);

  // 返回认证结果
  return {
    // 包含单个配置文件的数组
    profiles: [
      {
        // 配置文件 ID
        profileId,
        // 凭证信息
        credential: {
          // 凭证类型为令牌
          type: "token",
          // 提供者 ID
          provider: PROVIDER_ID,
          // 令牌值
          token,
          // 如果有过期时间则包含
          ...(expires ? { expires } : {}),
        },
      },
    ],
    // 默认模型
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    // 说明信息
    notes: [...ANTHROPIC_SETUP_TOKEN_NOTE_LINES],
  };
}

/**
 * 执行 Anthropic 设置令牌的无人值守（非交互式）认证
 * 用于自动化脚本和 CI/CD 环境
 * @param ctx - 提供者非交互式认证上下文
 * @returns 更新后的配置，如果失败则返回 null
 */
async function runAnthropicSetupTokenNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<ProviderAuthConfig | null> {
  // 从选项中获取令牌并进行规范化
  const rawToken =
    typeof ctx.opts.token === "string" ? normalizeAnthropicSetupTokenInput(ctx.opts.token) : "";

  // 验证令牌
  const tokenError = validateAnthropicSetupToken(rawToken);
  // 如果验证失败
  if (tokenError) {
    // 输出错误信息到运行时
    ctx.runtime.error(
      ["Anthropic setup-token auth requires --token with a valid setup-token.", tokenError].join(
        "\n",
      ),
    );
    // 退出进程，代码为 1（表示错误）
    ctx.runtime.exit(1);
    return null;
  }

  // 解析配置文件 ID
  const profileId = resolveAnthropicSetupTokenProfileId(ctx.opts.tokenProfileId);
  // 解析过期时间
  const expires = resolveAnthropicSetupTokenExpiry(ctx.opts.tokenExpiresIn);

  // 更新或插入认证配置文件
  upsertAuthProfile({
    // 配置文件 ID
    profileId,
    // 凭证信息
    credential: {
      // 凭证类型
      type: "token",
      // 提供者
      provider: PROVIDER_ID,
      // 令牌值
      token: rawToken,
      // 如果有过期时间则包含
      ...(expires ? { expires } : {}),
    },
    // 代理目录
    agentDir: ctx.agentDir,
  });

  // 记录说明信息到日志
  ctx.runtime.log(ANTHROPIC_SETUP_TOKEN_NOTE_LINES[0]);
  ctx.runtime.log(ANTHROPIC_SETUP_TOKEN_NOTE_LINES[1]);

  // 应用认证配置文件到当前配置
  const withProfile = applyAuthProfileConfig(ctx.config, {
    // 配置文件 ID
    profileId,
    // 提供者
    provider: PROVIDER_ID,
    // 认证模式为令牌
    mode: "token",
  });

  // 获取现有的模型配置
  const existingModelConfig =
    withProfile.agents?.defaults?.model && typeof withProfile.agents.defaults.model === "object"
      ? withProfile.agents.defaults.model
      : {};

  // 返回更新后的配置，设置默认模型为 Anthropic
  return {
    ...withProfile,
    agents: {
      ...withProfile.agents,
      defaults: {
        ...withProfile.agents?.defaults,
        model: {
          ...existingModelConfig,
          // 设置主要模型为默认 Anthropic 模型
          primary: DEFAULT_ANTHROPIC_MODEL,
        },
      },
    },
  };
}

/**
 * 解析 Anthropic 4.6 向前兼容模型
 * 用于将 4.6 模型映射到可用的模板模型
 * @param params - 包含模型 ID 和上下文信息的参数对象
 * @returns 运行时模型，如果不需要转换则返回 undefined
 */
function resolveAnthropic46ForwardCompatModel(params: {
  // 提供者解析动态模型上下文
  ctx: ProviderResolveDynamicModelContext;
  // 短横线格式的模型 ID（如 claude-opus-4-6）
  dashModelId: string;
  // 点号格式的模型 ID（如 claude-opus-4.6）
  dotModelId: string;
  // 短横线格式的模板模型 ID
  dashTemplateId: string;
  // 点号格式的模板模型 ID
  dotTemplateId: string;
  // 回退模板模型 ID 列表
  fallbackTemplateIds: readonly string[];
}): ProviderRuntimeModel | undefined {
  // 去除模型 ID 的首尾空白
  const trimmedModelId = params.ctx.modelId.trim();
  // 规范化为小写
  const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);

  // 检查是否为 4.6 系列模型
  const is46Model =
    // 完全匹配短横线格式
    lower === params.dashModelId ||
    // 完全匹配点号格式
    lower === params.dotModelId ||
    // 短横线格式开头（如 claude-opus-4-6-20251120）
    lower.startsWith(`${params.dashModelId}-`) ||
    // 点号格式开头（如 claude-opus-4.6-20251120）
    lower.startsWith(`${params.dotModelId}-`);

  // 如果不是 4.6 模型，返回 undefined
  if (!is46Model) {
    return undefined;
  }

  // 收集模板模型 ID
  const templateIds: string[] = [];

  // 如果以短横线格式开头，添加替换后的模板 ID
  if (lower.startsWith(params.dashModelId)) {
    templateIds.push(lower.replace(params.dashModelId, params.dashTemplateId));
  }

  // 如果以点号格式开头，添加替换后的模板 ID
  if (lower.startsWith(params.dotModelId)) {
    templateIds.push(lower.replace(params.dotModelId, params.dotTemplateId));
  }

  // 添加回退模板 ID
  templateIds.push(...params.fallbackTemplateIds);

  // 克隆第一个匹配的模板模型
  return cloneFirstTemplateModel({
    // 提供者 ID
    providerId: PROVIDER_ID,
    // 原始模型 ID
    modelId: trimmedModelId,
    // 模板模型 ID 列表
    templateIds,
    // 上下文
    ctx: params.ctx,
    // 如果提供者匹配 Claude CLI 后端，应用补丁
    patch:
      normalizeLowercaseStringOrEmpty(params.ctx.provider) === CLAUDE_CLI_BACKEND_ID
        ? { provider: CLAUDE_CLI_BACKEND_ID }
        : undefined,
  });
}

/**
 * 解析 Anthropic 向前兼容模型
 * 按优先级尝试 Opus 4.7、Opus 4.6、Sonnet 4.6 的兼容转换
 * @param ctx - 提供者解析动态模型上下文
 * @returns 运行时模型，如果都不匹配则返回 undefined
 */
function resolveAnthropicForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  // 尝试 Opus 4.7 到 Opus 4.6 的兼容转换
  return (
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_OPUS_47_MODEL_ID,
      dotModelId: ANTHROPIC_OPUS_47_DOT_MODEL_ID,
      dashTemplateId: ANTHROPIC_OPUS_46_MODEL_ID,
      dotTemplateId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
      fallbackTemplateIds: ANTHROPIC_OPUS_47_TEMPLATE_MODEL_IDS,
    }) ??
    // 尝试 Opus 4.6 到 Opus 4.5 的兼容转换
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_OPUS_46_MODEL_ID,
      dotModelId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
      dashTemplateId: "claude-opus-4-5",
      dotTemplateId: "claude-opus-4.5",
      fallbackTemplateIds: ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS,
    }) ??
    // 尝试 Sonnet 4.6 到 Sonnet 4.5 的兼容转换
    resolveAnthropic46ForwardCompatModel({
      ctx,
      dashModelId: ANTHROPIC_SONNET_46_MODEL_ID,
      dotModelId: ANTHROPIC_SONNET_46_DOT_MODEL_ID,
      dashTemplateId: "claude-sonnet-4-5",
      dotTemplateId: "claude-sonnet-4.5",
      fallbackTemplateIds: ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS,
    })
  );
}

/**
 * 检查是否为 Anthropic Opus 4.7 模型
 * @param modelId - 模型 ID
 * @returns 是否为 Opus 4.7 模型
 */
function isAnthropicOpus47Model(modelId: string): boolean {
  return isClaudeOpus47ModelId(modelId);
}

/**
 * 检查是否配置了模型上下文覆盖
 * @param config - 提供者规范化已解析模型上下文配置
 * @param provider - 提供者 ID
 * @param modelId - 模型 ID
 * @returns 是否配置了上下文覆盖
 */
function hasConfiguredModelContextOverride(
  config: ProviderNormalizeResolvedModelContext["config"],
  provider: string,
  modelId: string,
): boolean {
  // 获取提供者配置
  const providers = config?.models?.providers;
  // 如果不存在或不是对象，返回 false
  if (!providers || typeof providers !== "object") {
    return false;
  }

  // 规范化提供者 ID 和模型 ID 为小写
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);

  // 遍历所有提供者配置
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    // 跳过不匹配提供者
    if (normalizeLowercaseStringOrEmpty(providerId) !== normalizedProvider) {
      continue;
    }
    // 跳过无效的模型数组
    if (!Array.isArray(providerConfig?.models)) {
      continue;
    }
    // 遍历模型列表
    for (const model of providerConfig.models) {
      // 检查模型 ID 是否匹配
      if (
        normalizeLowercaseStringOrEmpty(typeof model?.id === "string" ? model.id : "") !==
        normalizedModelId
      ) {
        continue;
      }
      // 检查是否配置了 contextTokens 或 contextWindow
      if (
        // contextTokens 是正数
        (typeof model?.contextTokens === "number" && model.contextTokens > 0) ||
        // contextWindow 是正数
        (typeof model?.contextWindow === "number" && model.contextWindow > 0)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 应用 Anthropic Opus 4.7 上下文窗口扩展
 * 如果模型没有配置自定义上下文，则扩展到最大支持值
 * @param params - 包含配置、提供者、模型 ID 和模型的参数对象
 * @returns 更新后的运行时模型，如果没有变化则返回 undefined
 */
function applyAnthropicOpus47ContextWindow(params: {
  // 配置对象
  config?: ProviderNormalizeResolvedModelContext["config"];
  // 提供者 ID
  provider: string;
  // 模型 ID
  modelId: string;
  // 运行时模型
  model: ProviderRuntimeModel;
}): ProviderRuntimeModel | undefined {
  // 如果不是 Opus 4.7 模型，返回 undefined
  if (!isAnthropicOpus47Model(params.modelId)) {
    return undefined;
  }

  // 如果已配置了自定义上下文覆盖，返回 undefined
  if (hasConfiguredModelContextOverride(params.config, params.provider, params.modelId)) {
    return undefined;
  }

  // 计算新的上下文窗口大小（取当前值和最大值的较大值）
  const nextContextWindow = Math.max(
    params.model.contextWindow ?? 0,
    ANTHROPIC_OPUS_47_CONTEXT_TOKENS,
  );

  // 计算新的上下文令牌数量
  const nextContextTokens =
    typeof params.model.contextTokens === "number"
      ? Math.max(params.model.contextTokens, ANTHROPIC_OPUS_47_CONTEXT_TOKENS)
      : ANTHROPIC_OPUS_47_CONTEXT_TOKENS;

  // 如果没有变化，返回 undefined
  if (
    nextContextWindow === params.model.contextWindow &&
    nextContextTokens === params.model.contextTokens
  ) {
    return undefined;
  }

  // 返回更新后的模型
  return {
    ...params.model,
    // 更新上下文窗口
    contextWindow: nextContextWindow,
    // 更新上下文令牌
    contextTokens: nextContextTokens,
  };
}

/**
 * 检查模型 ID 是否匹配 Anthropic 现代模型前缀
 * @param modelId - 模型 ID
 * @returns 是否为现代模型
 */
function matchesAnthropicModernModel(modelId: string): boolean {
  // 规范化为小写
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  // 检查是否以任何现代模型前缀开头
  return ANTHROPIC_MODERN_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * 构建 Anthropic 认证 doctor 提示信息
 * 用于诊断认证配置问题
 * @param params - 包含配置、存储和配置文件 ID 的参数对象
 * @returns doctor 提示信息字符串
 */
function buildAnthropicAuthDoctorHint(params: {
  // 提供者认证上下文配置
  config?: ProviderAuthContext["config"];
  // 认证配置文件存储
  store: AuthProfileStore;
  // 配置文件 ID（可选）
  profileId?: string;
}): string {
  // 旧版默认配置文件 ID
  const legacyProfileId = params.profileId ?? "anthropic:default";

  // 建议的配置文件 ID
  const suggested = suggestOAuthProfileIdForLegacyDefault({
    cfg: params.config,
    store: params.store,
    provider: PROVIDER_ID,
    legacyProfileId,
  });

  // 如果没有建议或建议与旧版相同，返回空字符串
  if (!suggested || suggested === legacyProfileId) {
    return "";
  }

  // 列出该提供者的所有 OAuth 配置文件
  const storeOauthProfiles = listProfilesForProvider(params.store, PROVIDER_ID)
    // 过滤出 OAuth 类型的配置文件
    .filter((id) => params.store.profiles[id]?.type === "oauth")
    // 用逗号连接
    .join(", ");

  // 从配置中获取模式和服务提供者
  const cfgMode = params.config?.auth?.profiles?.[legacyProfileId]?.mode;
  const cfgProvider = params.config?.auth?.profiles?.[legacyProfileId]?.provider;

  // 构建并返回 doctor 提示信息
  return [
    "Doctor hint (for GitHub issue):",
    `- provider: ${PROVIDER_ID}`,
    `- config: ${legacyProfileId}${
      cfgProvider || cfgMode ? ` (provider=${cfgProvider ?? "?"}, mode=${cfgMode ?? "?"})` : ""
    }`,
    `- auth store oauth profiles: ${storeOauthProfiles || "(none)"}`,
    `- suggested profile: ${suggested}`,
    `Fix: run "${formatCliCommand("openclaw doctor --yes")}"`,
  ].join("\n");
}

/**
 * 解析 Claude CLI 合成认证信息
 * 从 Claude CLI 凭据中提取运行时可用的认证信息
 * @returns 合成认证对象，如果不适用则返回 undefined
 */
function resolveClaudeCliSyntheticAuth() {
  // 读取 Claude CLI 运行时凭据
  const credential = claudeCliAuth.readClaudeCliCredentialsForRuntime();
  // 如果没有凭据，返回 undefined
  if (!credential) {
    return undefined;
  }

  // 根据凭据类型返回相应的合成认证
  return credential.type === "oauth"
    ? {
        // API 密钥
        apiKey: credential.access,
        // 认证来源说明
        source: "Claude CLI native auth",
        // 认证模式
        mode: "oauth" as const,
        // 过期时间
        expiresAt: credential.expires,
      }
    : {
        // API 密钥（令牌）
        apiKey: credential.token,
        // 认证来源说明
        source: "Claude CLI native auth",
        // 认证模式
        mode: "token" as const,
        // 过期时间
        expiresAt: credential.expires,
      };
}

/**
 * 执行 Anthropic CLI 迁移
 * 将 Claude CLI 认证迁移到 OpenClaw 配置
 * @param ctx - 提供者认证上下文
 * @returns 认证结果
 * @throws 如果 Claude CLI 未认证则抛出错误
 */
async function runAnthropicCliMigration(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  // 读取 Claude CLI 设置凭据
  const credential = claudeCliAuth.readClaudeCliCredentialsForSetup();
  // 如果没有凭据，抛出错误
  if (!credential) {
    throw new Error(
      [
        "Claude CLI is not authenticated on this host.",
        `Run ${formatCliCommand("claude auth login")} first, then re-run this setup.`,
      ].join("\n"),
    );
  }
  // 构建迁移结果
  return buildAnthropicCliMigrationResult(ctx.config, credential);
}

/**
 * 执行 Anthropic CLI 迁移的无人值守模式
 * 用于自动化脚本和 CI/CD 环境
 * @param ctx - 包含配置、运行时和代理目录的对象
 * @returns 更新后的配置，如果失败则返回 null
 */
async function runAnthropicCliMigrationNonInteractive(ctx: {
  // 提供者认证上下文配置
  config: ProviderAuthContext["config"];
  // 提供者认证上下文运行时
  runtime: ProviderAuthContext["runtime"];
  // 代理目录（可选）
  agentDir?: string;
}): Promise<ProviderAuthContext["config"] | null> {
  // 读取 Claude CLI 非交互式设置凭据
  const credential = claudeCliAuth.readClaudeCliCredentialsForSetupNonInteractive();
  // 如果没有凭据
  if (!credential) {
    // 输出错误信息
    ctx.runtime.error(
      [
        'Auth choice "anthropic-cli" requires Claude CLI auth on this host.',
        `Run ${formatCliCommand("claude auth login")} first.`,
      ].join("\n"),
    );
    // 退出进程
    ctx.runtime.exit(1);
    return null;
  }

  // 构建迁移结果
  const result = buildAnthropicCliMigrationResult(ctx.config, credential);

  // 获取当前默认配置
  const currentDefaults = ctx.config.agents?.defaults;
  const currentModel = currentDefaults?.model;
  // 获取当前回退模型
  const currentFallbacks =
    currentModel && typeof currentModel === "object" && "fallbacks" in currentModel
      ? currentModel.fallbacks
      : undefined;

  // 获取迁移后的模型和回退
  const migratedModel = result.configPatch?.agents?.defaults?.model;
  const migratedFallbacks =
    migratedModel && typeof migratedModel === "object" && "fallbacks" in migratedModel
      ? migratedModel.fallbacks
      : undefined;

  // 合并回退列表
  const nextFallbacks = Array.isArray(migratedFallbacks) ? migratedFallbacks : currentFallbacks;

  // 返回合并后的配置
  return {
    ...ctx.config,
    ...result.configPatch,
    agents: {
      ...ctx.config.agents,
      ...result.configPatch?.agents,
      defaults: {
        ...currentDefaults,
        ...result.configPatch?.agents?.defaults,
        model: {
          // 如果有回退列表则保留
          ...(Array.isArray(nextFallbacks) ? { fallbacks: nextFallbacks } : {}),
          // 设置主要模型为迁移后的默认模型
          primary: result.defaultModel,
        },
      },
    },
  };
}

/**
 * 构建 Anthropic 提供者插件
 * 这是注册 Anthropic 提供者的主要入口函数
 * @returns 提供者插件对象
 */
export function buildAnthropicProvider(): ProviderPlugin {
  // 提供者 ID
  const providerId = "anthropic";
  // 默认 Anthropic 模型
  const defaultAnthropicModel = DEFAULT_ANTHROPIC_MODEL;

  // 返回提供者插件配置对象
  return {
    // 提供者唯一标识符
    id: providerId,
    // 显示标签
    label: "Anthropic",
    // 文档路径
    docsPath: "/providers/models",
    // 钩子别名，用于匹配 Claude CLI 后端
    hookAliases: [CLAUDE_CLI_BACKEND_ID],
    // 环境变量列表
    envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    // OAuth 配置文件 ID 修复列表
    oauthProfileIdRepairs: [
      {
        // 旧版配置文件 ID
        legacyProfileId: "anthropic:default",
        // 提示标签
        promptLabel: "Anthropic",
      },
    ],
    // 认证方法数组
    auth: [
      // 第一种认证方法：Claude CLI
      {
        // 认证方法 ID
        id: "cli",
        // 显示标签
        label: "Claude CLI",
        // 提示说明
        hint: "Reuse a local Claude CLI login and run Anthropic models through the Claude CLI runtime",
        // 认证类型为自定义
        kind: "custom",
        // 向导配置
        wizard: {
          // 选择 ID
          choiceId: "anthropic-cli",
          // 选择标签
          choiceLabel: "Anthropic Claude CLI",
          // 选择提示
          choiceHint: "Reuse a local Claude CLI login on this host",
          // 助手优先级（负数表示更高优先级）
          assistantPriority: -20,
          // 组 ID
          groupId: "anthropic",
          // 组标签
          groupLabel: "Anthropic",
          // 组提示
          groupHint: "Claude CLI + API key",
          // 模型允许列表配置
          modelAllowlist: {
            // 允许的密钥列表
            allowedKeys: [...CLAUDE_CLI_CANONICAL_ALLOWLIST_REFS],
            // 初始选择的模型
            initialSelections: [CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF],
            // 消息
            message: "Claude CLI models",
          },
        },
        // 执行函数
        run: async (ctx: ProviderAuthContext) => await runAnthropicCliMigration(ctx),
        // 非交互式执行函数
        runNonInteractive: async (ctx) =>
          await runAnthropicCliMigrationNonInteractive({
            config: ctx.config,
            runtime: ctx.runtime,
            agentDir: ctx.agentDir,
          }),
      },
      // 第二种认证方法：设置令牌
      {
        // 认证方法 ID
        id: "setup-token",
        // 显示标签
        label: "Anthropic setup-token",
        // 提示说明
        hint: "Manual bearer token path",
        // 认证类型为令牌
        kind: "token",
        // 向导配置
        wizard: {
          // 选择 ID
          choiceId: "setup-token",
          // 选择标签
          choiceLabel: "Anthropic setup-token",
          // 选择提示
          choiceHint: "Manual token path",
          // 助手优先级
          assistantPriority: 40,
          // 组 ID
          groupId: "anthropic",
          // 组标签
          groupLabel: "Anthropic",
          // 组提示
          groupHint: "Claude CLI + API key + token",
        },
        // 执行函数
        run: async (ctx: ProviderAuthContext) => await runAnthropicSetupTokenAuth(ctx),
        // 非交互式执行函数
        runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) =>
          await runAnthropicSetupTokenNonInteractive(ctx),
      },
      // 第三种认证方法：API 密钥
      createProviderApiKeyAuthMethod({
        // 提供者 ID
        providerId,
        // 方法 ID
        methodId: "api-key",
        // 标签
        label: "Anthropic API key",
        // 提示
        hint: "Direct Anthropic API key",
        // 选项键名
        optionKey: "anthropicApiKey",
        // 命令行标志名
        flagName: "--anthropic-api-key",
        // 环境变量名
        envVar: "ANTHROPIC_API_KEY",
        // 提示消息
        promptMessage: "Enter Anthropic API key",
        // 默认模型
        defaultModel: defaultAnthropicModel,
        // 期望的提供者列表
        expectedProviders: ["anthropic"],
        // 向导配置
        wizard: {
          // 选择 ID
          choiceId: "apiKey",
          // 选择标签
          choiceLabel: "Anthropic API key",
          // 组 ID
          groupId: "anthropic",
          // 组标签
          groupLabel: "Anthropic",
          // 组提示
          groupHint: "Claude CLI + API key",
        },
      }),
    ],
    // 规范化配置函数
    normalizeConfig: ({ provider, providerConfig }) =>
      normalizeAnthropicProviderConfigForProvider({ provider, providerConfig }),
    // 应用配置默认值函数
    applyConfigDefaults: ({ config, env }) => applyAnthropicConfigDefaults({ config, env }),
    // 解析动态模型函数
    resolveDynamicModel: (ctx) => {
      // 先尝试向前兼容转换
      const model = resolveAnthropicForwardCompatModel(ctx);
      // 如果不需要转换，返回 undefined
      if (!model) {
        return undefined;
      }
      // 应用 Opus 4.7 上下文窗口扩展
      return (
        applyAnthropicOpus47ContextWindow({
          config: ctx.config,
          provider: ctx.provider,
          modelId: ctx.modelId,
          model,
        }) ?? model
      );
    },
    // 规范化已解析模型函数
    normalizeResolvedModel: (ctx) => applyAnthropicOpus47ContextWindow(ctx),
    // 解析合成认证函数
    resolveSyntheticAuth: ({ provider }) =>
      normalizeLowercaseStringOrEmpty(provider) === CLAUDE_CLI_BACKEND_ID
        ? resolveClaudeCliSyntheticAuth()
        : undefined,
    // 构建回放策略函数
    buildReplayPolicy: buildAnthropicReplayPolicy,
    // 检查是否为现代模型引用的函数
    isModernModelRef: ({ modelId }) => matchesAnthropicModernModel(modelId),
    // 解析推理输出模式，返回原生支持
    resolveReasoningOutputMode: () => "native",
    // 解析思考配置文件
    resolveThinkingProfile: ({ modelId }) => resolveClaudeThinkingProfile(modelId),
    // 封装流函数
    wrapStreamFn: wrapAnthropicProviderStream,
    // 解析用量认证函数
    resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
    // 获取用量快照函数
    fetchUsageSnapshot: async (ctx) =>
      await fetchClaudeUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
    // 检查缓存 TTL 是否符合条件，始终返回 true
    isCacheTtlEligible: () => true,
    // 构建认证 doctor 提示函数
    buildAuthDoctorHint: (ctx) =>
      buildAnthropicAuthDoctorHint({
        config: ctx.config,
        store: ctx.store,
        profileId: ctx.profileId,
      }),
  };
}

/**
 * 注册 Anthropic 插件
 * 在插件加载时被调用，注册所有 Anthropic 相关的提供者
 * @param api - OpenClaw 插件 API 对象
 */
export function registerAnthropicPlugin(api: OpenClawPluginApi): void {
  // 注册 CLI 后端
  api.registerCliBackend(buildAnthropicCliBackend());
  // 注册模型提供者
  api.registerProvider(buildAnthropicProvider());
  // 注册媒体理解提供者
  api.registerMediaUnderstandingProvider(anthropicMediaUnderstandingProvider);
}
