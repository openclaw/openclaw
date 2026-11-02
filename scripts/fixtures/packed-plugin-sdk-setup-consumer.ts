import {
  moveSingleAccountChannelSectionToDefaultAccount,
  patchChannelConfigForAccount,
} from "openclaw/plugin-sdk/setup";
import {
  patchChannelConfigForAccount as patchRuntimeChannelConfigForAccount,
  setAccountAllowFromForChannel,
} from "openclaw/plugin-sdk/setup-runtime";

// Keep this consumer unchanged across the released and candidate declaration checks.
moveSingleAccountChannelSectionToDefaultAccount({
  cfg: {},
  channelKey: "signal",
  setupSurface: {
    configPromotion: "preserve-root",
    resolveSingleAccountPromotionTarget: ({ channel }) =>
      typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
    applyAccountConfig: ({ cfg }) => cfg,
  },
});

patchChannelConfigForAccount({
  cfg: {},
  channel: "signal",
  accountId: "work",
  patch: { enabled: true },
  setupSurface: {
    configPromotion: "preserve-root",
    resolveSingleAccountPromotionTarget: ({ channel }) =>
      typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
    applyAccountConfig: ({ cfg }) => cfg,
  },
});

patchRuntimeChannelConfigForAccount({
  cfg: {},
  channel: "signal",
  accountId: "work",
  patch: { enabled: true },
  setupSurface: {
    configPromotion: "preserve-root",
    resolveSingleAccountPromotionTarget: ({ channel }) =>
      typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
    applyAccountConfig: ({ cfg }) => cfg,
  },
});

setAccountAllowFromForChannel({
  cfg: {},
  channel: "signal",
  accountId: "work",
  allowFrom: ["+12025550123"],
  setupSurface: {
    configPromotion: "preserve-root",
    resolveSingleAccountPromotionTarget: ({ channel }) =>
      typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
    applyAccountConfig: ({ cfg }) => cfg,
  },
});
