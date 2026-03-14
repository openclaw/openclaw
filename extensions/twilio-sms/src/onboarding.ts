import {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
} from "openclaw/plugin-sdk/compat";
import type { ChannelOnboardingAdapter, OpenClawConfig } from "openclaw/plugin-sdk/twilio-sms";
import {
  resolveAccountIdForConfigure,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "openclaw/plugin-sdk/twilio-sms";
import {
  listTwilioSmsAccountIds,
  resolveDefaultTwilioSmsAccountId,
  resolveTwilioSmsAccount,
} from "./accounts.js";

const channel = "twilio-sms" as const;

export const twilioSmsOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg }) => {
    const configured = listTwilioSmsAccountIds(cfg).some(
      (accountId) => resolveTwilioSmsAccount({ cfg, accountId }).configured,
    );
    return {
      channel,
      configured,
      statusLines: [`Twilio SMS: ${configured ? "configured" : "needs credentials"}`],
      selectionHint: configured ? "configured" : "needs auth",
    };
  },

  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const defaultAccountId = resolveDefaultTwilioSmsAccountId(cfg);
    const accountId = await resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "Twilio SMS",
      accountOverride: accountOverrides["twilio-sms"],
      shouldPromptAccountIds,
      listAccountIds: listTwilioSmsAccountIds,
      defaultAccountId,
    });

    // Prompt for Twilio credentials
    const accountSid = await prompter.text({
      message: "Twilio Account SID:",
      placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      validate: (val) => {
        if (!val?.trim()) {
          return "Account SID is required";
        }
        if (!val.trim().startsWith("AC")) {
          return "Account SID should start with 'AC'";
        }
        return undefined;
      },
    });
    if (typeof accountSid !== "string") {
      return { cfg, accountId };
    }

    const authToken = await prompter.text({
      message: "Twilio Auth Token:",
      validate: (val) => {
        if (!val?.trim()) {
          return "Auth Token is required";
        }
        return undefined;
      },
    });
    if (typeof authToken !== "string") {
      return { cfg, accountId };
    }

    const phoneNumber = await prompter.text({
      message: "Twilio Phone Number (E.164, e.g. +15550001234):",
      placeholder: "+15550001234",
      validate: (val) => {
        if (!val?.trim()) {
          return "Phone number is required";
        }
        if (!/^\+[1-9]\d{1,14}$/.test(val.trim())) {
          return "Must be in E.164 format (e.g. +15550001234)";
        }
        return undefined;
      },
    });
    if (typeof phoneNumber !== "string") {
      return { cfg, accountId };
    }

    // Apply config
    let next: OpenClawConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: "twilio-sms",
      accountId,
      name: undefined,
    });

    next = applySetupAccountConfigPatch({
      cfg: next,
      channelKey: "twilio-sms",
      accountId,
      patch: {
        accountSid: accountSid.trim(),
        authToken: authToken.trim(),
        phoneNumber: phoneNumber.trim(),
      },
    });

    // DM policy
    const dmPolicyChoice = await prompter.select<string>({
      message: "DM policy:",
      options: [
        { value: "allowlist", label: "Allowlist (recommended)" },
        { value: "pairing", label: "Pairing (approve via code)" },
        { value: "open", label: "Open (anyone can message)" },
      ],
    });
    if (typeof dmPolicyChoice === "string") {
      next = setTopLevelChannelDmPolicyWithAllowFrom({
        cfg: next,
        channel: "twilio-sms",
        dmPolicy: dmPolicyChoice as "allowlist" | "pairing" | "open",
      });
    }

    // PIN auth
    const usePinAuth = await prompter.confirm({
      message: "Enable daily PIN auth? (recommended for SMS spoofing protection)",
    });
    if (usePinAuth) {
      const pin = await prompter.text({
        message: "PIN (4+ digits recommended):",
        placeholder: "1234",
        validate: (val) => {
          if (!val?.trim()) {
            return "PIN is required when PIN auth is enabled";
          }
          return undefined;
        },
      });
      if (typeof pin === "string") {
        next = applySetupAccountConfigPatch({
          cfg: next,
          channelKey: "twilio-sms",
          accountId,
          patch: {
            pinAuth: true,
            pin: pin.trim(),
          },
        });
      }
    }

    return { cfg: next, accountId };
  },
};
