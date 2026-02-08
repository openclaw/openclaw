/**
 * Onboarding Adapter for zalouser-free
 */

import type { ChannelOnboardingAdapter, OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { listAccountIds } from "./accounts.js";
import { ZaloSessionManager } from "./session-manager.js";

const channel = "zalouser-free" as const;

async function noteZalouserFreeHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Zalo Personal Account (Free) - Direct integration via zca-js",
      "",
      "This channel uses zca-js library directly.",
      "You'll scan a QR code with your Zalo app to login.",
      "",
      "Docs: https://docs.openclaw.ai/channels/zalouser-free",
    ].join("\n"),
    "Zalo Personal (Free) Setup",
  );
}

export const zalouserFreeOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg }) => {
    const ids = listAccountIds(cfg);
    let configured = false;

    const pluginConfig = cfg.plugins?.entries?.["zalouser-free"]?.config;
    const sessionPath = pluginConfig?.sessionPath;
    const manager = new ZaloSessionManager(sessionPath);

    for (const accountId of ids) {
      const hasCredentials = manager.hasSavedCredentials(accountId);
      if (hasCredentials) {
        configured = true;
        break;
      }
    }

    return {
      channel,
      configured,
      statusLines: [`Zalo Personal (Free): ${configured ? "logged in" : "needs QR login"}`],
      selectionHint: configured ? "recommended · logged in" : "recommended · QR login",
      quickstartScore: configured ? 1 : 15,
    };
  },

  configure: async ({ cfg, prompter }) => {
    await noteZalouserFreeHelp(prompter);

    const accountId = DEFAULT_ACCOUNT_ID;

    const pluginConfig = cfg.plugins?.entries?.["zalouser-free"]?.config;
    const sessionPath = pluginConfig?.sessionPath;
    const manager = new ZaloSessionManager(sessionPath, console);

    const hasCredentials = manager.hasSavedCredentials(accountId);

    if (!hasCredentials) {
      const wantsLogin = await prompter.confirm({
        message: "Login via QR code now?",
        initialValue: true,
      });

      if (wantsLogin) {
        await prompter.note(
          "A QR code will appear below.\nScan it with your Zalo app to login.",
          "QR Login",
        );

        // Perform QR login
        const result = await manager.loginWithQR(accountId, {
          qrCallback: (qrData) => {
            console.log("\n" + qrData + "\n");
          },
        });

        if (!result.ok) {
          await prompter.note(`Login failed: ${result.error || "Unknown error"}`, "Error");
          return { cfg, accountId };
        } else {
          await prompter.note("Login successful!", "Success");
        }
      } else {
        await prompter.note(
          "Skipping login. You can login later with: openclaw zalouser-free login",
          "Setup",
        );
        return { cfg, accountId };
      }
    } else {
      const keepSession = await prompter.confirm({
        message: "Zalo Personal (Free) already logged in. Keep session?",
        initialValue: true,
      });

      if (!keepSession) {
        await prompter.note(
          "Please logout manually and re-run onboarding: openclaw zalouser-free logout",
          "Setup",
        );
        return { cfg, accountId };
      }
    }

    // Enable the channel
    let next = {
      ...cfg,
      channels: {
        ...cfg.channels,
        "zalouser-free": {
          ...cfg.channels?.["zalouser-free"],
          enabled: true,
          accounts: {
            ...cfg.channels?.["zalouser-free"]?.accounts,
            [accountId]: {
              ...cfg.channels?.["zalouser-free"]?.accounts?.[accountId],
              enabled: true,
              dmAccess: "whitelist",
              groupAccess: "mention",
              allowedUsers: [],
              allowedGroups: [],
            },
          },
        },
      },
    } as OpenClawConfig;

    // Prompt for DM access policy
    const dmPolicy = await prompter.select({
      message: "DM (Direct Message) Access Policy",
      options: [
        { value: "whitelist", label: "Whitelist (only allowed users)" },
        { value: "open", label: "Open (anyone can message)" },
      ],
      initialValue: "whitelist",
    });

    // Prompt for group access policy
    const groupPolicy = await prompter.select({
      message: "Group Access Policy",
      options: [
        { value: "mention", label: "Mention (only when bot is mentioned)" },
        { value: "whitelist", label: "Whitelist (only allowed groups)" },
        { value: "open", label: "Open (all groups)" },
      ],
      initialValue: "mention",
    });

    next = {
      ...next,
      channels: {
        ...next.channels,
        "zalouser-free": {
          ...next.channels?.["zalouser-free"],
          accounts: {
            ...next.channels?.["zalouser-free"]?.accounts,
            [accountId]: {
              ...next.channels?.["zalouser-free"]?.accounts?.[accountId],
              dmAccess: dmPolicy,
              groupAccess: groupPolicy,
            },
          },
        },
      },
    } as OpenClawConfig;

    return { cfg: next, accountId };
  },
};
