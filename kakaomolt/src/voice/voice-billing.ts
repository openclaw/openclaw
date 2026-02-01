/**
 * Voice Billing System
 *
 * Handles credit deduction for voice features:
 * - Async voice (STT → AI → TTS): 1.5x normal text credit
 * - Real-time voice: 2x credit per 30-second increment
 */

import type { VoiceProviderType, VoiceSession } from "./provider-interface.js";

// ============================================
// Billing Constants
// ============================================

/** Credits per 30 seconds of real-time voice */
export const REALTIME_CREDITS_PER_30S = 10;

/** Multiplier for real-time voice (2x base rate) */
export const REALTIME_CREDIT_MULTIPLIER = 2.0;

/** Multiplier for async voice (1.5x base rate for STT+TTS overhead) */
export const ASYNC_VOICE_CREDIT_MULTIPLIER = 1.5;

/** Minimum duration to charge (15 seconds) */
export const MIN_BILLABLE_DURATION_MS = 15000;

/** Billing interval (30 seconds) */
export const BILLING_INTERVAL_MS = 30000;

// ============================================
// Pricing by Provider
// ============================================

interface ProviderPricing {
  /** Base cost per minute (in credits) */
  baseCreditsPerMinute: number;
  /** Description */
  description: string;
}

export const PROVIDER_PRICING: Record<VoiceProviderType, ProviderPricing> = {
  openai: {
    baseCreditsPerMinute: 20,
    description: "OpenAI Realtime API (gpt-4o-realtime)",
  },
  gemini: {
    baseCreditsPerMinute: 15,
    description: "Gemini Live API (gemini-2.5-flash)",
  },
};

// ============================================
// Billing Types
// ============================================

export interface VoiceBillingResult {
  /** Total credits used */
  creditsUsed: number;
  /** Breakdown by category */
  breakdown: {
    /** Duration-based credits */
    durationCredits: number;
    /** Token-based credits (if applicable) */
    tokenCredits: number;
    /** Multiplier applied */
    multiplier: number;
  };
  /** Session duration in ms */
  durationMs: number;
  /** Billable intervals (30s increments) */
  billableIntervals: number;
  /** Provider used */
  provider: VoiceProviderType;
  /** Whether billing was successful */
  success: boolean;
  /** Error message if billing failed */
  error?: string;
}

export interface AsyncVoiceBillingResult {
  /** Total credits used */
  creditsUsed: number;
  /** Breakdown */
  breakdown: {
    sttCredits: number;
    llmCredits: number;
    ttsCredits: number;
    multiplier: number;
  };
  /** Success status */
  success: boolean;
  error?: string;
}

// ============================================
// Billing Functions
// ============================================

/**
 * Calculate credits for a real-time voice session
 */
export function calculateRealtimeCredits(session: VoiceSession): VoiceBillingResult {
  const durationMs = session.durationMs || (Date.now() - session.createdAt.getTime());
  const provider = session.provider;
  const pricing = PROVIDER_PRICING[provider];

  // Don't charge for very short sessions (< 15s)
  if (durationMs < MIN_BILLABLE_DURATION_MS) {
    return {
      creditsUsed: 0,
      breakdown: {
        durationCredits: 0,
        tokenCredits: 0,
        multiplier: REALTIME_CREDIT_MULTIPLIER,
      },
      durationMs,
      billableIntervals: 0,
      provider,
      success: true,
    };
  }

  // Calculate billable intervals (round up to nearest 30s)
  const billableIntervals = Math.ceil(durationMs / BILLING_INTERVAL_MS);

  // Calculate duration-based credits
  const minutesUsed = durationMs / 60000;
  const durationCredits = Math.ceil(minutesUsed * pricing.baseCreditsPerMinute);

  // Apply multiplier
  const totalCredits = Math.ceil(durationCredits * REALTIME_CREDIT_MULTIPLIER);

  return {
    creditsUsed: totalCredits,
    breakdown: {
      durationCredits,
      tokenCredits: 0, // Token-based billing could be added later
      multiplier: REALTIME_CREDIT_MULTIPLIER,
    },
    durationMs,
    billableIntervals,
    provider,
    success: true,
  };
}

/**
 * Calculate credits for async voice processing
 */
export function calculateAsyncVoiceCredits(params: {
  /** Audio duration in seconds */
  audioDurationSec: number;
  /** Input tokens for LLM */
  inputTokens: number;
  /** Output tokens for LLM */
  outputTokens: number;
  /** Model used for LLM */
  model: string;
}): AsyncVoiceBillingResult {
  const { audioDurationSec, inputTokens, outputTokens } = params;

  // STT credits: ~1 credit per 10 seconds of audio
  const sttCredits = Math.ceil(audioDurationSec / 10);

  // LLM credits: based on token usage (simplified)
  const llmCredits = Math.ceil((inputTokens + outputTokens) / 1000);

  // TTS credits: ~1 credit per 100 characters (~50 tokens)
  const ttsCredits = Math.ceil(outputTokens / 50);

  // Total with multiplier
  const baseCredits = sttCredits + llmCredits + ttsCredits;
  const totalCredits = Math.ceil(baseCredits * ASYNC_VOICE_CREDIT_MULTIPLIER);

  return {
    creditsUsed: totalCredits,
    breakdown: {
      sttCredits,
      llmCredits,
      ttsCredits,
      multiplier: ASYNC_VOICE_CREDIT_MULTIPLIER,
    },
    success: true,
  };
}

/**
 * Format billing information for display
 */
export function formatBillingInfo(result: VoiceBillingResult): string {
  const minutes = Math.floor(result.durationMs / 60000);
  const seconds = Math.floor((result.durationMs % 60000) / 1000);
  const durationStr = minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;

  return `💳 **음성 대화 요금**

⏱️ 통화 시간: ${durationStr}
📊 청구 단위: ${result.billableIntervals}개 (30초 단위)
🎙️ 제공자: ${PROVIDER_PRICING[result.provider].description}

💰 **크레딧 차감**
• 기본 요금: ${result.breakdown.durationCredits} 크레딧
• 적용 배율: ${result.breakdown.multiplier}x (실시간 음성)
• **총 차감: ${result.creditsUsed} 크레딧**`;
}

/**
 * Format async voice billing for display
 */
export function formatAsyncBillingInfo(result: AsyncVoiceBillingResult): string {
  return `💳 **음성 메시지 요금**

📝 **크레딧 내역**
• 음성 인식 (STT): ${result.breakdown.sttCredits} 크레딧
• AI 처리 (LLM): ${result.breakdown.llmCredits} 크레딧
• 음성 합성 (TTS): ${result.breakdown.ttsCredits} 크레딧
• 적용 배율: ${result.breakdown.multiplier}x

💰 **총 차감: ${result.creditsUsed} 크레딧**`;
}

/**
 * Estimate credits for a planned session
 */
export function estimateRealtimeCredits(
  provider: VoiceProviderType,
  estimatedMinutes: number,
): number {
  const pricing = PROVIDER_PRICING[provider];
  const baseCredits = estimatedMinutes * pricing.baseCreditsPerMinute;
  return Math.ceil(baseCredits * REALTIME_CREDIT_MULTIPLIER);
}

/**
 * Format pricing comparison
 */
export function formatPricingComparison(): string {
  return `💰 **음성 기능 요금 안내**

**실시간 음성 대화** (2x 배율)
| 제공자 | 분당 요금 |
|--------|----------|
| OpenAI Realtime | ${PROVIDER_PRICING.openai.baseCreditsPerMinute * REALTIME_CREDIT_MULTIPLIER} 크레딧 |
| Gemini Live | ${PROVIDER_PRICING.gemini.baseCreditsPerMinute * REALTIME_CREDIT_MULTIPLIER} 크레딧 |

**비동기 음성 메시지** (1.5x 배율)
• STT: 10초당 1 크레딧
• LLM: 1000토큰당 1 크레딧
• TTS: 50토큰당 1 크레딧

**예상 비용** (5분 실시간 대화)
• OpenAI: ~${estimateRealtimeCredits("openai", 5)} 크레딧
• Gemini: ~${estimateRealtimeCredits("gemini", 5)} 크레딧

💡 Gemini가 약 25% 저렴합니다!`;
}

// ============================================
// Billing Validation
// ============================================

/**
 * Check if user has enough credits for voice
 */
export function checkVoiceCredits(
  userCredits: number,
  provider: VoiceProviderType,
  estimatedMinutes: number = 1,
): {
  hasEnough: boolean;
  required: number;
  available: number;
  shortfall: number;
} {
  const required = estimateRealtimeCredits(provider, estimatedMinutes);
  const hasEnough = userCredits >= required;

  return {
    hasEnough,
    required,
    available: userCredits,
    shortfall: hasEnough ? 0 : required - userCredits,
  };
}

/**
 * Format insufficient credits message
 */
export function formatInsufficientCreditsMessage(
  check: ReturnType<typeof checkVoiceCredits>,
  provider: VoiceProviderType,
): string {
  return `⚠️ **크레딧 부족**

실시간 음성 대화를 시작하려면 최소 ${check.required} 크레딧이 필요합니다.

현재 잔액: ${check.available} 크레딧
부족 금액: ${check.shortfall} 크레딧

"충전"을 입력하여 크레딧을 충전해주세요.

💡 더 저렴한 옵션:
• Gemini Live 사용 (약 25% 저렴)
• 음성 메시지로 비동기 대화`;
}
