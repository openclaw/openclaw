/**
 * X channel CLI onboarding wizard.
 *
 * Note: This uses a simplified prompt-based schema, not the full ChannelOnboardingAdapter interface.
 */

/**
 * X onboarding adapter for CLI setup.
 */
export const xOnboardingAdapter = {
  /**
   * Get onboarding prompts for X channel.
   */
  getPrompts: () => [
    {
      key: "consumerKey",
      type: "text" as const,
      label: "Consumer Key (API Key)",
      help: "From X Developer Portal",
      required: true,
    },
    {
      key: "consumerSecret",
      type: "password" as const,
      label: "Consumer Secret (API Secret)",
      help: "From X Developer Portal",
      required: true,
    },
    {
      key: "accessToken",
      type: "text" as const,
      label: "Access Token",
      help: "From X Developer Portal",
      required: true,
    },
    {
      key: "accessTokenSecret",
      type: "password" as const,
      label: "Access Token Secret",
      help: "From X Developer Portal",
      required: true,
    },
    {
      key: "pollIntervalSeconds",
      type: "number" as const,
      label: "Poll Interval (seconds)",
      help: "How often to check for new mentions (min: 15, default: 60)",
      required: false,
      default: 60,
    },
  ],

  /**
   * Validate onboarding input.
   */
  validate: (input: Record<string, unknown>) => {
    const errors: string[] = [];

    if (!input.consumerKey) {
      errors.push("Consumer Key is required");
    }
    if (!input.consumerSecret) {
      errors.push("Consumer Secret is required");
    }
    if (!input.accessToken) {
      errors.push("Access Token is required");
    }
    if (!input.accessTokenSecret) {
      errors.push("Access Token Secret is required");
    }

    const pollInterval = input.pollIntervalSeconds as number | undefined;
    if (pollInterval !== undefined && pollInterval < 15) {
      errors.push("Poll interval must be at least 15 seconds");
    }

    return errors.length > 0 ? errors.join("; ") : null;
  },

  /**
   * Apply onboarding input to config.
   */
  applyToConfig: (cfg: Record<string, unknown>, input: Record<string, unknown>) => {
    const channels = (cfg.channels ?? {}) as Record<string, unknown>;
    const xConfig = {
      enabled: true,
      consumerKey: input.consumerKey,
      consumerSecret: input.consumerSecret,
      accessToken: input.accessToken,
      accessTokenSecret: input.accessTokenSecret,
      ...(input.pollIntervalSeconds ? { pollIntervalSeconds: input.pollIntervalSeconds } : {}),
    };

    return {
      ...cfg,
      channels: {
        ...channels,
        x: xConfig,
      },
    };
  },
};
