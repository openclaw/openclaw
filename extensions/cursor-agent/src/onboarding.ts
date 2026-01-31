/**
 * Onboarding adapter for Cursor Agent channel.
 *
 * Provides a setup wizard for configuring Cursor Agent integration.
 */

import type { ChannelOnboardingAdapter, WizardPrompter } from "openclaw/plugin-sdk";
import type { CursorAgentAccountConfig } from "./types.js";

export const cursorAgentOnboardingAdapter: ChannelOnboardingAdapter = {
  async runSetup(prompter: WizardPrompter): Promise<Partial<CursorAgentAccountConfig> | null> {
    console.log("\n📦 Cursor Agent Setup\n");
    console.log("This will configure Cursor Background Agents integration.");
    console.log(
      "You'll need an API key from: https://cursor.com/dashboard?tab=background-agents\n",
    );

    // Prompt for API key
    const apiKey = await prompter.text({
      message: "Enter your Cursor API key:",
      validate: (value) => {
        if (!value || value.trim().length === 0) {
          return "API key is required";
        }
        return true;
      },
    });

    if (!apiKey) {
      console.log("Setup cancelled.");
      return null;
    }

    // Prompt for default repository
    const repository = await prompter.text({
      message: "Default GitHub repository URL (optional):",
      validate: (value) => {
        if (value && !value.includes("github.com")) {
          return "Must be a GitHub repository URL";
        }
        return true;
      },
    });

    // Prompt for default branch
    const branch = await prompter.text({
      message: "Default branch (default: main):",
      default: "main",
    });

    // Prompt for webhook configuration
    const configureWebhook = await prompter.confirm({
      message: "Configure webhook for receiving agent results?",
      default: true,
    });

    let webhookUrl: string | undefined;
    let webhookSecret: string | undefined;

    if (configureWebhook) {
      webhookUrl = await prompter.text({
        message: "Webhook URL (your OpenClaw Gateway endpoint):",
        validate: (value) => {
          if (value && !value.startsWith("https://")) {
            return "Webhook URL should use HTTPS";
          }
          return true;
        },
      });

      webhookSecret = await prompter.text({
        message: "Webhook secret (8-256 chars, for signature verification):",
        validate: (value) => {
          if (value && (value.length < 8 || value.length > 256)) {
            return "Secret must be 8-256 characters";
          }
          return true;
        },
      });
    }

    // Prompt for default model
    const defaultModel = await prompter.select({
      message: "Default AI model (optional):",
      choices: [
        { value: "", label: "Use Cursor default" },
        { value: "claude-4-sonnet-thinking", label: "Claude 4 Sonnet (Thinking)" },
        { value: "claude-4-opus", label: "Claude 4 Opus" },
        { value: "gpt-4", label: "GPT-4" },
      ],
    });

    // Build configuration
    const config: Partial<CursorAgentAccountConfig> = {
      enabled: true,
      apiKey: apiKey.trim(),
    };

    if (repository) {
      config.repository = repository.trim();
    }
    if (branch) {
      config.branch = branch.trim();
    }
    if (webhookUrl) {
      config.webhookUrl = webhookUrl.trim();
    }
    if (webhookSecret) {
      config.webhookSecret = webhookSecret.trim();
    }
    if (defaultModel) {
      config.defaultModel = defaultModel;
    }

    console.log("\n✅ Cursor Agent configuration complete!\n");
    console.log("Add the following to your openclaw.json:");
    console.log(
      JSON.stringify({ channels: { cursorAgent: { accounts: { default: config } } } }, null, 2),
    );

    return config;
  },

  validateConfig(config: unknown): string[] {
    const errors: string[] = [];
    const cfg = config as Partial<CursorAgentAccountConfig>;

    if (!cfg.apiKey) {
      errors.push("API key is required");
    }

    if (cfg.webhookUrl && !cfg.webhookUrl.startsWith("https://")) {
      errors.push("Webhook URL should use HTTPS in production");
    }

    if (cfg.webhookSecret && (cfg.webhookSecret.length < 8 || cfg.webhookSecret.length > 256)) {
      errors.push("Webhook secret must be 8-256 characters");
    }

    return errors;
  },
};
