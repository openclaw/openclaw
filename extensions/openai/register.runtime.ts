/**
 * OpenAI 提供者插件运行时导出模块
 * 重新导出各个提供者构建函数，供其他模块使用
 */

// 从 cli-backend.js 导出构建 OpenAI Codex CLI 后端的函数
export { buildOpenAICodexCliBackend } from "./cli-backend.js";

// 从 image-generation-provider.js 导出构建 OpenAI 图像生成提供者的函数
export { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";

// 从 media-understanding-provider.js 导出媒体理解提供者
export {
  // OpenAI Codex 媒体理解提供者
  openaiCodexMediaUnderstandingProvider,
  // OpenAI 媒体理解提供者
  openaiMediaUnderstandingProvider,
} from "./media-understanding-provider.js";

// 从 openai-codex-provider.js 导出构建 OpenAI Codex 提供者插件的函数
export { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";

// 从 openai-provider.js 导出构建 OpenAI 提供者的函数
export { buildOpenAIProvider } from "./openai-provider.js";

// 从 prompt-overlay.js 导出提示覆盖相关的函数和常量
export {
  // OpenAI 友好提示覆盖常量
  OPENAI_FRIENDLY_PROMPT_OVERLAY,
  // 解析 OpenAI 提示覆盖模式
  resolveOpenAIPromptOverlayMode,
  // 检查是否应应用 OpenAI 提示覆盖
  shouldApplyOpenAIPromptOverlay,
} from "./prompt-overlay.js";

// 从 realtime-transcription-provider.js 导出构建实时转录提供者的函数
export { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

// 从 realtime-voice-provider.js 导出构建实时语音提供者的函数
export { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

// 从 speech-provider.js 导出构建语音合成提供者的函数
export { buildOpenAISpeechProvider } from "./speech-provider.js";
