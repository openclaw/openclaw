import type { ChannelDoctorLegacyConfigRule } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  ELEVENLABS_TALK_PROVIDER_ID,
  hasLegacyElevenLabsModel,
  hasLegacyTalkFields,
  migrateElevenLabsModelConfig,
  migrateElevenLabsLegacyTalkConfig,
} from "./config-compat.js";

export { hasLegacyElevenLabsModel, hasLegacyTalkFields } from "./config-compat.js";

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: [],
    message: "ElevenLabs TTS model is legacy; use modelId and run openclaw doctor --fix.",
    match: hasLegacyElevenLabsModel,
  },
  {
    path: ["talk"],
    message:
      "talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey are legacy; use talk.providers.<provider> and run openclaw doctor --fix.",
    match: hasLegacyTalkFields,
  },
];

export const ELEVENLABS_TALK_LEGACY_CONFIG_RULES = legacyConfigRules;

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const talkResult = migrateElevenLabsLegacyTalkConfig(cfg);
  const modelResult = migrateElevenLabsModelConfig(talkResult.config);
  return { config: modelResult.config, changes: [...talkResult.changes, ...modelResult.changes] };
}

export { ELEVENLABS_TALK_PROVIDER_ID };
