// Public "fat barrel" for the bundled DingTalk extension. The lightweight
// `index.ts` entry only loads what is needed for channel registration on
// startup; everything that is bigger or pulls extra dependencies lives
// behind this barrel and is brought in via `loadBundledEntryExportSync`
// when the host asks for `registerFull`.

export { dingtalkPlugin, CHANNEL_ID, getDwsSpawnEnv } from "./src/channel.js";
export { setDingtalkRuntime, getDingtalkRuntime } from "./src/runtime.js";
export { registerGatewayMethods as registerDingtalkGatewayMethods } from "./src/gateway-methods.js";

export {
  resolveDingtalkAccount,
  resolveDingtalkCredentials,
  listDingtalkAccountIds,
  resolveDefaultDingtalkAccountId,
  listEnabledDingtalkAccounts,
} from "./src/config/accounts.js";

export {
  normalizeDingtalkTarget,
  formatDingtalkTarget,
  looksLikeDingtalkId,
} from "./src/targets.js";

export { resolveDingtalkGroupToolPolicy } from "./src/policy.js";
export { probeDingtalk, clearProbeCache } from "./src/probe.js";
export { dingtalkOnboardingAdapter } from "./src/onboarding.js";

export {
  beginDingtalkRegistration,
  pollDingtalkRegistration,
  waitForDingtalkRegistrationSuccess,
  renderQrCodeText,
} from "./src/device-auth.js";

export type { DingtalkConfig, ResolvedDingtalkAccount } from "./src/types/index.js";
