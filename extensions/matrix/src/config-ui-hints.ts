import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
// Matrix helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const matrixChannelConfigUiHints = {
  ...createChannelConfigUiHints({
    channelLabel: "Matrix",
    mentionPatterns: {
      targetDescription: "Matrix room IDs",
      policyNote:
        "Native Matrix mention evidence still triggers even when regex patterns are denied.",
      denyNote: "Native mention evidence still triggers.",
    },
  }),
  allowBots: {
    label: "Matrix Allow Bot Messages",
    help: 'Allow messages from other configured Matrix bot accounts to trigger replies (default: false). Set "mentions" to require a visible room mention.',
  },
  botLoopProtection: {
    label: "Matrix Bot Loop Protection",
    help: "Sliding-window guard for accepted Matrix configured-bot loops. Default is enabled whenever allowBots lets configured bot messages reach dispatch.",
  },
  "botLoopProtection.enabled": {
    label: "Matrix Bot Loop Protection Enabled",
    help: 'Enable the bot-pair loop guard. Defaults to true when allowBots is true or "mentions", and false when configured bot messages are ignored.',
  },
  "botLoopProtection.maxEventsPerWindow": {
    label: "Matrix Bot Loop Events per Window",
    help: "Maximum accepted bot-pair messages within the sliding window before suppression starts. Default: 20.",
  },
  "botLoopProtection.windowSeconds": {
    label: "Matrix Bot Loop Window Seconds",
    help: "Sliding window length for counting bot-pair messages. Default: 60.",
  },
  "botLoopProtection.cooldownSeconds": {
    label: "Matrix Bot Loop Cooldown Seconds",
    help: "How long to suppress the bot pair after it exceeds the budget. Default: 60.",
  },
  dangerouslyAllowNameMatching: {
    label: "Matrix Display Name Matching",
    help: "Compatibility opt-in for resolving Matrix display names and joined room names in allowlists. Prefer full @user:server IDs and room IDs or aliases because names are mutable.",
  },
  participation: {
    label: "Matrix Participation Control",
    help: "Opt-in multi-agent room turn classification. When enabled, only Matrix-routable candidate agents can suppress this account's reply.",
  },
  "participation.enabled": {
    label: "Matrix Participation Enabled",
    help: "Enable pre-dispatch classification for group turns. Default: false.",
  },
  "participation.strategy": {
    label: "Matrix Participation Strategy",
    help: 'Use "ai-first" for model classification or "deterministic" for local directive parsing.',
  },
  "participation.model": {
    label: "Matrix Participation Model",
    help: "Optional model override for AI participation classification.",
  },
  freshness: {
    label: "Matrix Draft Freshness",
    help: "Opt-in final-publish recheck for Matrix room drafts when newer messages or protected redactions arrive before posting.",
  },
  "freshness.enabled": {
    label: "Matrix Draft Freshness Enabled",
    help: "Enable final-publish freshness checks for room replies. Default: false.",
  },
  "freshness.mode": {
    label: "Matrix Draft Freshness Mode",
    help: 'Final handling when newer relevant activity appears: "auto", "revise", "suppress", or "send-as-is".',
  },
  "freshness.scope": {
    label: "Matrix Draft Freshness Scope",
    help: 'Use "thread-aware" to isolate active thread activity or "room" to treat root-room activity as relevant.',
  },
  "freshness.draftHoldbackMs": {
    label: "Matrix Draft Holdback (ms)",
    help: "Optional delay before final publish to catch near-simultaneous Matrix activity.",
  },
  "freshness.model": {
    label: "Matrix Freshness Model",
    help: "Optional model override for AI final-action selection and revision.",
  },
  "freshness.allowedFinalActions": {
    label: "Matrix AI Final Action Allowlist",
    help: "Limits only AI-selected final actions. Explicit mode and finalAction values are still honored.",
  },
  "freshness.aiDeterminesFinalAction": {
    label: "Matrix AI Determines Final Action",
    help: "When true in auto mode, AI chooses whether to revise, suppress, or send the stale draft. Default: false.",
  },
  "freshness.finalAction": {
    label: "Matrix Deterministic Final Action",
    help: "Optional deterministic final action used by auto mode before consulting AI.",
  },
  ...createChannelConfigUiHints({ channelLabel: "Matrix", progress: {} }),
} satisfies Record<string, ChannelConfigUiHint>;
