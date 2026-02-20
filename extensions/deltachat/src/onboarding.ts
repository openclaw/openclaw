import type { ChannelOnboardingAdapter, WizardPrompter } from "openclaw/plugin-sdk";
import { formatDocsLink } from "openclaw/plugin-sdk";
import type { CoreConfig } from "./types.js";
import { resolveDeltaChatAccount } from "./accounts.js";

const channel = "deltachat" as const;

async function noteDeltaChatAuthHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Delta.Chat requires either a chatmail QR code or an email address with password.",
      "",
      "Recommended: Chatmail QR code (DCACCOUNT:https://nine.testrun.org/new)",
      "  - Faster setup, better privacy",
      "  - No email/password needed",
      "",
      "Alternative: Traditional email account",
      "  - Use --addr and --mail-pw for regular email accounts",
      "",
      "Env vars supported: DELTACHAT_ADDR, DELTACHAT_MAIL_PW, DELTACHAT_CHATMAIL_QR.",
      `Docs: ${formatDocsLink("/channels/deltachat", "channels/deltachat")}`,
    ].join("\n"),
    "Delta.Chat setup",
  );
}

export const deltachatOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }: { cfg: unknown }) => {
    const account = resolveDeltaChatAccount({ cfg: cfg as CoreConfig });
    const configured = account.configured;
    return {
      channel,
      configured,
      statusLines: [
        `Delta.Chat: ${configured ? "configured" : "needs email + password or chatmail QR"}`,
      ],
      selectionHint: configured ? "configured" : "needs auth",
    };
  },
  configure: async (ctx) => {
    const { cfg, prompter } = ctx;
    let next = cfg as CoreConfig;
    const existing = next.channels?.deltachat ?? {};

    await noteDeltaChatAuthHelp(prompter);

    const envAddr = process.env.DELTACHAT_ADDR?.trim();
    const envMailPw = process.env.DELTACHAT_MAIL_PW?.trim();
    const envChatmailQr = process.env.DELTACHAT_CHATMAIL_QR?.trim();
    const envReady = Boolean(envAddr && envMailPw) || Boolean(envChatmailQr);

    if (envReady && !existing.addr && !existing.chatmailQr) {
      const useEnv = await prompter.confirm({
        message: "Delta.Chat env vars detected. Use env values?",
        initialValue: true,
      });
      if (useEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            deltachat: {
              ...next.channels?.deltachat,
              enabled: true,
            },
          },
        };
        return { cfg: next };
      }
    }

    // Ask for chatmail QR code first (preferred option)
    const chatmailQr = String(
      await prompter.text({
        message: "Delta.Chat chatmail QR code (or email address)",
        initialValue:
          existing.chatmailQr ?? envChatmailQr ?? "DCACCOUNT:https://nine.testrun.org/new",
        validate: (value: unknown) => {
          const raw = String(value ?? "").trim();
          if (!raw) {
            return "Required - enter QR code or email address";
          }
          return undefined;
        },
      }),
    ).trim();

    // Check if the input is a QR code (starts with DCACCOUNT:) or an email address
    const isChatmailQr = chatmailQr.startsWith("DCACCOUNT:");
    const isEmail = chatmailQr.includes("@");

    if (isChatmailQr) {
      // Use chatmail QR code - no need for email/password
      next = {
        ...next,
        channels: {
          ...next.channels,
          deltachat: {
            ...next.channels?.deltachat,
            enabled: true,
            chatmailQr: chatmailQr,
            bot: "1",
            e2ee_enabled: "1",
          },
        },
      };
      return { cfg: next };
    }

    if (isEmail) {
      // Traditional email address - ask for password
      const mailPw = String(
        await prompter.text({
          message: "Delta.Chat email password",
          validate: (value: unknown) => (value?.toString().trim() ? undefined : "Required"),
        }),
      ).trim();

      next = {
        ...next,
        channels: {
          ...next.channels,
          deltachat: {
            ...next.channels?.deltachat,
            enabled: true,
            addr: chatmailQr,
            mail_pw: mailPw,
            bot: "1",
            e2ee_enabled: "1",
          },
        },
      };
      return { cfg: next };
    }

    // If we get here, the input is neither a QR code nor an email
    // Ask for clarification
    const useAsEmail = await prompter.confirm({
      message: `Is "${chatmailQr}" an email address?`,
      initialValue: true,
    });

    if (useAsEmail) {
      const mailPw = String(
        await prompter.text({
          message: "Delta.Chat email password",
          validate: (value: unknown) => (value?.toString().trim() ? undefined : "Required"),
        }),
      ).trim();

      next = {
        ...next,
        channels: {
          ...next.channels,
          deltachat: {
            ...next.channels?.deltachat,
            enabled: true,
            addr: chatmailQr,
            mail_pw: mailPw,
            bot: "1",
            e2ee_enabled: "1",
          },
        },
      };
      return { cfg: next };
    }

    // Treat as QR code
    next = {
      ...next,
      channels: {
        ...next.channels,
        deltachat: {
          ...next.channels?.deltachat,
          enabled: true,
          chatmailQr: chatmailQr,
          bot: "1",
          e2ee_enabled: "1",
        },
      },
    };
    return { cfg: next };
  },
};
