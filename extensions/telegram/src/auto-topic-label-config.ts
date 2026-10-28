import type {
  TelegramAccountConfig,
  TelegramDirectConfig,
} from "openclaw/plugin-sdk/config-contracts";

const AUTO_TOPIC_LABEL_DEFAULT_PROMPT =
  "Generate a very short topic label (1-3 words, max 25 chars) for a chat conversation based on the supplied source message. No emoji. Use the same language as the message, in sentence case: capitalize only the first word and words that language always capitalizes. Be concise and descriptive. Return ONLY the topic name, nothing else.";

export const AUTO_TOPIC_LABEL_REFINE_PROMPT =
  "Generate a very short topic label (1-3 words, max 25 chars) for a chat conversation based on the supplied conversation excerpt. Use the language the excerpt is written in, not the language of quoted literals, in sentence case: capitalize only the first word and words that language always capitalizes. No emoji. Return ONLY the topic name, nothing else.";

/** Default task messages after the first turn before the one-time refinement runs. */
const AUTO_TOPIC_LABEL_REFINE_AFTER_MESSAGES_DEFAULT = 6;

/** Per-key enablement: false disables, true enables, undefined inherits the next scope. */
function resolveAutoTopicLabelKeyEnabled(
  config: TelegramDirectConfig["autoTopicLabel"] | undefined,
): boolean | undefined {
  const obj = config && typeof config === "object" ? config : undefined;
  if (config === false || obj?.enabled === false) {
    return false;
  }
  if (config === true || obj?.enabled === true) {
    return true;
  }
  return undefined;
}

/**
 * Per-key enablement: a present direct key decides for that DM. An explicit
 * boolean/`enabled:false` disables; any other direct object is an explicit
 * per-DM configuration and stays enabled over an account default of false —
 * Codex 4304147110 supersedes 4299713761, whose required `enabled:true`
 * silently disabled pre-existing per-DM prompt objects. The account default
 * applies only when the DM key is absent.
 */
function resolveEffectiveKeyEnabled(
  directConfig?: TelegramDirectConfig["autoTopicLabel"],
  accountConfig?: TelegramAccountConfig["autoTopicLabel"],
): boolean {
  if (directConfig !== undefined) {
    return resolveAutoTopicLabelKeyEnabled(directConfig) ?? true;
  }
  return resolveAutoTopicLabelKeyEnabled(accountConfig) ?? true;
}

export function resolveAutoTopicLabelRefineConfig(params: {
  directConfig?: TelegramDirectConfig["autoTopicLabel"];
  accountConfig?: TelegramAccountConfig["autoTopicLabel"];
}): { enabled: boolean; afterMessages: number } {
  const read = (
    config: TelegramDirectConfig["autoTopicLabel"] | undefined,
  ): { enabled?: boolean; refine?: boolean; refineAfterMessages?: number } | undefined =>
    config && typeof config === "object" ? config : undefined;
  const direct = read(params.directConfig);
  const account = read(params.accountConfig);
  // Effective base auto-label enablement, resolved per-key first (Codex
  // 4304147110): the DM key wins whenever it is present, so an account-level
  // false cannot disable a DM that carries its own autoTopicLabel object.
  const baseEnabled = resolveEffectiveKeyEnabled(params.directConfig, params.accountConfig);
  const refine = direct?.refine ?? account?.refine;
  const rawAfter = direct?.refineAfterMessages ?? account?.refineAfterMessages;
  return {
    enabled: baseEnabled && refine === true,
    afterMessages:
      typeof rawAfter === "number" && Number.isInteger(rawAfter) && rawAfter >= 1 && rawAfter <= 100
        ? rawAfter
        : AUTO_TOPIC_LABEL_REFINE_AFTER_MESSAGES_DEFAULT,
  };
}

export function resolveAutoTopicLabelConfig(
  directConfig?: TelegramDirectConfig["autoTopicLabel"],
  accountConfig?: TelegramAccountConfig["autoTopicLabel"],
): { enabled: true; prompt: string } | null {
  // Effective enablement resolves per-key first, mirroring
  // resolveAutoTopicLabelRefineConfig: the DM key wins whenever it is present
  // (Codex 4304147110), and an explicit boolean false or enabled:false
  // disables.
  const keyEnabled = resolveEffectiveKeyEnabled(directConfig, accountConfig);
  if (!keyEnabled) {
    return null;
  }
  if (directConfig === undefined || directConfig === true) {
    // With no per-DM object, inherit the account prompt when present. The
    // per-key check above already resolved enablement, including a literal
    // per-DM true overriding an account-level false.
    const account = accountConfig && typeof accountConfig === "object" ? accountConfig : undefined;
    return {
      enabled: true,
      prompt: account?.prompt?.trim() || AUTO_TOPIC_LABEL_DEFAULT_PROMPT,
    };
  }
  if (directConfig === false || directConfig.enabled === false) {
    return null;
  }
  // A per-DM object without its own prompt inherits the account-level prompt
  // instead of dropping it (Codex 4302677497).
  const accountPrompt =
    accountConfig && typeof accountConfig === "object" ? accountConfig.prompt?.trim() : undefined;
  return {
    enabled: true,
    prompt: directConfig.prompt?.trim() || accountPrompt || AUTO_TOPIC_LABEL_DEFAULT_PROMPT,
  };
}

/** Normalize empty model output without overriding configured naming prompts. */
export function normalizeGeneratedTopicLabel(label: string | null): string | null {
  return label?.trim() || null;
}
