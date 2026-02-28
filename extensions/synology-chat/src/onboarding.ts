import type { ChannelOnboardingAdapter } from "openclaw/plugin-sdk";

export const synologyChatOnboarding: ChannelOnboardingAdapter = {
  async getQuestions({ currentConfig }) {
    const current = currentConfig as Record<string, unknown> | undefined;

    return [
      {
        id: "baseUrl",
        question: "What is the URL of your Synology NAS?",
        help: "Enter the full URL including port if needed (e.g., https://nas.example.com:5001)",
        default: (current?.baseUrl as string) ?? "",
        required: true,
        validate: (value: string) => {
          if (!value.trim()) {
            return "URL is required";
          }
          try {
            new URL(value);
            return true;
          } catch {
            return "Please enter a valid URL";
          }
        },
      },
      {
        id: "token",
        question: "What is your Synology Chat webhook token?",
        help: "Create an incoming webhook in Synology Chat: Settings > Integrations > Incoming Webhooks",
        default: (current?.token as string) ?? "",
        required: true,
        sensitive: true,
        validate: (value: string) => {
          if (!value.trim()) {
            return "Token is required";
          }
          return true;
        },
      },
      {
        id: "webhookPort",
        question: "What port should the webhook server listen on?",
        help: "The webhook server will receive messages from Synology Chat",
        default: (current?.webhookPort as number) ?? 8789,
        required: false,
        validate: (value: string | number) => {
          const num = typeof value === "string" ? parseInt(value, 10) : value;
          if (isNaN(num) || num < 1 || num > 65535) {
            return "Please enter a valid port number (1-65535)";
          }
          return true;
        },
      },
      {
        id: "webhookPublicUrl",
        question: "What is the public URL for the webhook? (optional)",
        help: "If behind a reverse proxy, enter the public URL that Synology can reach",
        default: (current?.webhookPublicUrl as string) ?? "",
        required: false,
      },
      {
        id: "dmPolicy",
        question: "Who can send direct messages to the bot?",
        help: "pairing: Users must confirm pairing first\nallowlist: Only specified users\nopen: Anyone can message\ndisabled: No DMs allowed",
        default: (current?.dmPolicy as string) ?? "pairing",
        required: false,
        choices: ["pairing", "allowlist", "open", "disabled"],
      },
    ];
  },

  async processAnswers({ answers }) {
    const config: Record<string, unknown> = {
      enabled: true,
      baseUrl: answers.baseUrl,
      token: answers.token,
    };

    if (answers.webhookPort) {
      config.webhookPort =
        typeof answers.webhookPort === "string"
          ? parseInt(answers.webhookPort, 10)
          : answers.webhookPort;
    }

    if (answers.webhookPublicUrl?.trim()) {
      config.webhookPublicUrl = answers.webhookPublicUrl.trim();
    }

    if (answers.dmPolicy) {
      config.dmPolicy = answers.dmPolicy;
    }

    return { config };
  },

  getSummary({ config }) {
    const cfg = config as Record<string, unknown>;
    return [
      `Base URL: ${cfg.baseUrl ?? "not set"}`,
      `Webhook port: ${cfg.webhookPort ?? 8789}`,
      `DM policy: ${cfg.dmPolicy ?? "pairing"}`,
      `Webhook URL: ${cfg.webhookPublicUrl ?? `http://localhost:${cfg.webhookPort ?? 8789}/synology-chat-webhook`}`,
    ];
  },

  getNextSteps({ config }) {
    const cfg = config as Record<string, unknown>;
    const webhookUrl =
      (cfg.webhookPublicUrl as string) ??
      `http://your-server:${cfg.webhookPort ?? 8789}/synology-chat-webhook`;

    return [
      "Configure Synology Chat to send outgoing webhooks:",
      `1. Open Synology Chat on your DSM`,
      "2. Go to Settings > Integrations > Outgoing Webhooks",
      "3. Create a new outgoing webhook with:",
      `   - URL: ${webhookUrl}`,
      "   - Format: JSON or Form Data",
      "4. Save and test the integration",
      "",
      "After configuration, restart the OpenClaw gateway to apply changes.",
    ];
  },
};
