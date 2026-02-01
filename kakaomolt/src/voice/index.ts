/**
 * Voice Communication Module
 *
 * Provides voice AI capabilities for KakaoMolt:
 * - Voice message processing (async voice-to-voice)
 * - Real-time voice conversation (low-latency streaming)
 * - Multiple provider support (OpenAI Realtime, Gemini Live)
 * - Integrated billing system
 */

// Voice message handler (async processing)
export {
  createVoiceHandler,
  DEFAULT_VOICE_CONFIG,
  VoiceHandler,
  RealtimeVoiceManager,
  type RealtimeVoiceOptions,
  type RealtimeVoiceSession,
  type VoiceConfig,
  type VoiceMessage,
  type VoiceResponse,
} from "./voice-handler.js";

// Provider interface (common types)
export {
  DEFAULT_PROVIDER_CONFIG,
  formatProviderComparison,
  getAudioConfig,
  getAvailableProviders,
  GEMINI_AUDIO_CONFIG,
  isProviderAvailable,
  KOREAN_VOICE_SETTINGS,
  OPENAI_AUDIO_CONFIG,
  VoiceProvider,
  type AudioConfig,
  type SessionStats,
  type SessionStatus,
  type VoiceProviderConfig,
  type VoiceProviderEvents,
  type VoiceProviderType,
  type VoiceSession,
  type VoiceTool,
} from "./provider-interface.js";

// OpenAI Realtime provider
export {
  createOpenAIProvider,
  isOpenAIAvailable,
  OpenAIRealtimeProvider,
} from "./provider-openai.js";

// Gemini Live provider
export {
  createGeminiProvider,
  isGeminiAvailable,
  GeminiLiveProvider,
} from "./provider-gemini.js";

// Voice billing
export {
  ASYNC_VOICE_CREDIT_MULTIPLIER,
  BILLING_INTERVAL_MS,
  calculateAsyncVoiceCredits,
  calculateRealtimeCredits,
  checkVoiceCredits,
  estimateRealtimeCredits,
  formatAsyncBillingInfo,
  formatBillingInfo,
  formatInsufficientCreditsMessage,
  formatPricingComparison,
  MIN_BILLABLE_DURATION_MS,
  PROVIDER_PRICING,
  REALTIME_CREDIT_MULTIPLIER,
  REALTIME_CREDITS_PER_30S,
  type AsyncVoiceBillingResult,
  type VoiceBillingResult,
} from "./voice-billing.js";

// Legacy exports (for backwards compatibility)
export {
  createRealtimeClient,
  isRealtimeAvailable,
  RealtimeVoiceClient,
  type RealtimeConfig,
  type RealtimeEvents,
  type RealtimeSession,
  type RealtimeStatus,
} from "./realtime-voice.js";

// ============================================
// Factory Functions
// ============================================

import type { VoiceProviderType, VoiceProviderConfig } from "./provider-interface.js";
import { createOpenAIProvider } from "./provider-openai.js";
import { createGeminiProvider } from "./provider-gemini.js";
import { VoiceProvider } from "./provider-interface.js";

/**
 * Create a voice provider by type
 */
export function createVoiceProvider(
  provider: VoiceProviderType,
  config?: Partial<VoiceProviderConfig>,
): VoiceProvider {
  switch (provider) {
    case "openai":
      return createOpenAIProvider(config);
    case "gemini":
      return createGeminiProvider(config);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Get the best available provider
 * Prefers Gemini for cost, falls back to OpenAI
 */
export function getBestAvailableProvider(): VoiceProviderType | null {
  // Prefer Gemini (cheaper)
  if (isProviderAvailable("gemini")) return "gemini";
  if (isProviderAvailable("openai")) return "openai";
  return null;
}

import { isProviderAvailable } from "./provider-interface.js";

/**
 * Voice feature summary
 *
 * ## Supported Modes
 *
 * ### 1. Async Voice (Voice Messages)
 * For platforms that support voice messages (KakaoTalk, Telegram):
 * ```
 * User Voice → [STT] → Text → [AI] → Response → [TTS] → Voice Reply
 * ```
 * Latency: 2-4 seconds
 * Cost: 1.5x normal text credits
 *
 * ### 2. Real-time Voice (Streaming)
 * For live voice conversations:
 * ```
 * User Voice → [WebSocket] → [Provider API] → Voice Reply
 * ```
 * Latency: 200-500ms
 * Cost: 2x normal credits (per 30-second increment)
 *
 * ### 3. Phone Call (Telephony)
 * For traditional phone conversations:
 * Requires Moltbot Voice Call plugin with Twilio/Telnyx/Plivo
 *
 * ## Providers
 *
 * | Provider | Latency | Cost | Korean |
 * |----------|---------|------|--------|
 * | OpenAI Realtime | ~300ms | Higher | Good (nova) |
 * | Gemini Live | ~200ms | Lower | Good (Kore) |
 *
 * ## Recommendations
 *
 * - Cost-sensitive: Gemini Live
 * - Stability: OpenAI Realtime
 * - No internet: Phone call (Twilio)
 */
