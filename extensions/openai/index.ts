/**
 * OpenAI 提供者插件入口文件
 * 定义并注册 OpenAI 相关的所有提供者插件
 */

// 从插件配置运行时模块导入解析插件配置对象的函数
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";

// 从插件入口模块导入定义插件入口的函数
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// 从提供者工具模块导入构建提供者工具兼容家族钩子的函数
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";

// 从当前目录的 cli-backend.js 导入构建 OpenAI Codex CLI 后端的函数
import { buildOpenAICodexCliBackend } from "./cli-backend.js";

// 从当前目录的 image-generation-provider.js 导入构建 OpenAI 图像生成提供者的函数
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";

// 从当前目录的 media-understanding-provider.js 导入媒体理解提供者
import {
  // OpenAI Codex 媒体理解提供者
  openaiCodexMediaUnderstandingProvider,
  // OpenAI 媒体理解提供者
  openaiMediaUnderstandingProvider,
} from "./media-understanding-provider.js";

// 从当前目录的 memory-embedding-adapter.js 导入 OpenAI 内存嵌入提供者适配器
import { openAiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

// 从当前目录的 openai-codex-provider.js 导入构建 OpenAI Codex 提供者插件的函数
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";

// 从当前目录的 openai-provider.js 导入构建 OpenAI 提供者的函数
import { buildOpenAIProvider } from "./openai-provider.js";

// 从当前目录的 prompt-overlay.js 导入提示覆盖相关的函数
import {
  // 解析 OpenAI 提示覆盖模式
  resolveOpenAIPromptOverlayMode,
  // 解析 OpenAI 系统提示贡献
  resolveOpenAISystemPromptContribution,
} from "./prompt-overlay.js";

// 从当前目录的 realtime-transcription-provider.js 导入构建实时转录提供者的函数
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

// 从当前目录的 realtime-voice-provider.js 导入构建实时语音提供者的函数
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

// 从当前目录的 speech-provider.js 导入构建语音合成提供者的函数
import { buildOpenAISpeechProvider } from "./speech-provider.js";

// 从当前目录的 video-generation-provider.js 导入构建视频生成提供者的函数
import { buildOpenAIVideoGenerationProvider } from "./video-generation-provider.js";

/**
 * 使用 definePluginEntry 定义插件的入口配置
 * 这是插件的默认导出对象
 */
export default definePluginEntry({
  // 插件的唯一标识符
  id: "openai",
  // 插件的显示名称
  name: "OpenAI Provider",
  // 插件的描述信息
  description: "Bundled OpenAI provider plugins",
  /**
   * 注册函数，在插件被加载时调用
   * @param api - OpenClaw 插件 API 对象
   */
  register(api) {
    // 构建 OpenAI 工具兼容家族钩子
    const openAIToolCompatHooks = buildProviderToolCompatFamilyHooks("openai");

    /**
     * 构建包含提示贡献的提供者工厂函数
     * 为提供者添加系统提示贡献解析功能
     * @param provider - 要包装的提供者
     * @returns 包装后的提供者，包含工具兼容钩子和提示贡献解析
     */
    const buildProviderWithPromptContribution = <
      T extends ReturnType<typeof buildOpenAIProvider>,
    >(
      provider: T,
    ): T => ({
      // 展开原提供者的所有属性
      ...provider,
      // 添加 OpenAI 工具兼容钩子
      ...openAIToolCompatHooks,
      // 覆盖解析系统提示贡献的函数
      resolveSystemPromptContribution: (ctx) => {
        // 解析运行时插件配置对象
        const runtimePluginConfig = resolvePluginConfigObject(ctx.config, "openai");
        // 获取插件配置，如果运行时配置不存在则使用 API 中的插件配置
        const pluginConfig =
          runtimePluginConfig ??
          (ctx.config ? undefined : (api.pluginConfig as Record<string, unknown>));

        // 解析并返回系统提示贡献
        return resolveOpenAISystemPromptContribution({
          // 上下文配置
          config: ctx.config,
          // 旧版插件配置
          legacyPluginConfig: pluginConfig,
          // 提示覆盖模式
          mode: resolveOpenAIPromptOverlayMode(pluginConfig),
          // 模型提供者 ID
          modelProviderId: provider.id,
          // 模型 ID
          modelId: ctx.modelId,
        });
      },
    });

    // 注册 OpenAI Codex CLI 后端
    api.registerCliBackend(buildOpenAICodexCliBackend());
    // 注册带有提示贡献的 OpenAI 提供者
    api.registerProvider(buildProviderWithPromptContribution(buildOpenAIProvider()));
    // 注册带有提示贡献的 OpenAI Codex 提供者
    api.registerProvider(buildProviderWithPromptContribution(buildOpenAICodexProviderPlugin()));
    // 注册内存嵌入提供者适配器
    api.registerMemoryEmbeddingProvider(openAiMemoryEmbeddingProviderAdapter);
    // 注册图像生成提供者
    api.registerImageGenerationProvider(buildOpenAIImageGenerationProvider());
    // 注册实时转录提供者
    api.registerRealtimeTranscriptionProvider(buildOpenAIRealtimeTranscriptionProvider());
    // 注册实时语音提供者
    api.registerRealtimeVoiceProvider(buildOpenAIRealtimeVoiceProvider());
    // 注册语音合成提供者
    api.registerSpeechProvider(buildOpenAISpeechProvider());
    // 注册 OpenAI 媒体理解提供者
    api.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);
    // 注册 OpenAI Codex 媒体理解提供者
    api.registerMediaUnderstandingProvider(openaiCodexMediaUnderstandingProvider);
    // 注册视频生成提供者
    api.registerVideoGenerationProvider(buildOpenAIVideoGenerationProvider());
  },
});
