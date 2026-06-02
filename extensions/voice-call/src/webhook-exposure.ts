import { isBlockedHostnameOrIp } from "../api.js";

type VoiceCallWebhookExposureConfig = {
  provider?: string;
  publicUrl?: string;
  tunnel?: {
    provider?: string;
  };
  tailscale?: {
    mode?: string;
  };
};

type VoiceCallWebhookExposureStatus = {
  /** Whether the selected provider can receive webhook callbacks with current config. */
  ok: boolean;
  /** Whether some exposure mechanism was configured, even if it is invalid. */
  configured: boolean;
  /** Human-readable setup status for doctor/config diagnostics. */
  message: string;
};

/** Returns true for providers that must receive externally reachable webhook callbacks. */
export function providerRequiresPublicWebhook(providerName: string | undefined): boolean {
  return providerName === "twilio" || providerName === "telnyx" || providerName === "plivo";
}

/** Checks whether a webhook hostname resolves to loopback, private, or otherwise blocked space. */
export function isLocalOnlyWebhookHost(hostname: string): boolean {
  return isBlockedHostnameOrIp(hostname);
}

/** Detects public webhook URLs that carrier providers cannot reach. */
export function isProviderUnreachableWebhookUrl(webhookUrl: string): boolean {
  try {
    const parsed = new URL(webhookUrl);
    return isLocalOnlyWebhookHost(parsed.hostname);
  } catch {
    // Let config validation report malformed URLs; this helper only classifies reachable hosts.
    return false;
  }
}

/**
 * Summarizes whether voice-call webhook exposure is configured for the selected provider.
 * This is a diagnostic helper: runtime startup performs the final fail-closed
 * check after public URL, tunnel, and Tailscale resolution.
 */
export function resolveWebhookExposureStatus(
  config: VoiceCallWebhookExposureConfig,
): VoiceCallWebhookExposureStatus {
  if (config.provider === "mock") {
    return {
      ok: true,
      configured: true,
      message: "Mock provider does not need a public webhook",
    };
  }

  if (config.publicUrl) {
    if (isProviderUnreachableWebhookUrl(config.publicUrl)) {
      return {
        ok: false,
        configured: true,
        message: `Public webhook URL is local/private and cannot be reached by ${config.provider ?? "the provider"}: ${config.publicUrl}`,
      };
    }
    return {
      ok: true,
      configured: true,
      message: `Public webhook URL configured: ${config.publicUrl}`,
    };
  }

  if (config.tunnel?.provider && config.tunnel.provider !== "none") {
    return {
      ok: true,
      configured: true,
      message: "Webhook exposure configured through tunnel",
    };
  }

  if (config.tailscale?.mode && config.tailscale.mode !== "off") {
    return {
      ok: true,
      configured: true,
      message: "Webhook exposure configured through Tailscale",
    };
  }

  return {
    ok: false,
    configured: false,
    message: "Set publicUrl or configure tunnel/tailscale so the provider can reach webhooks",
  };
}
