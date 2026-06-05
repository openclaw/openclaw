// Voice Call plugin module implements webhook exposure behavior.
import { isBlockedHostnameOrIp } from "../api.js";

// Webhook exposure checks for providers that must reach local voice-call webhooks.

/** Minimal config needed to evaluate webhook exposure. */
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

/** Result of checking whether webhooks are reachable for the selected provider. */
type VoiceCallWebhookExposureStatus = {
  ok: boolean;
  configured: boolean;
  message: string;
};

/** Return true when a provider requires a public webhook URL or tunnel. */
export function providerRequiresPublicWebhook(providerName: string | undefined): boolean {
  return providerName === "twilio" || providerName === "telnyx" || providerName === "plivo";
}

/** Return true for localhost, private, or otherwise provider-unreachable hosts. */
export function isLocalOnlyWebhookHost(hostname: string): boolean {
  return isBlockedHostnameOrIp(hostname);
}

/** Return true when a webhook URL parses to a local/private host. */
export function isProviderUnreachableWebhookUrl(webhookUrl: string): boolean {
  try {
    const parsed = new URL(webhookUrl);
    return isLocalOnlyWebhookHost(parsed.hostname);
  } catch {
    return false;
  }
}

/** Resolve a human-readable webhook exposure status for doctor/setup surfaces. */
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

  // Microsoft Teams receives calls over its own authenticated bridge WebSocket
  // listener (msteams.port/path), not the public provider-webhook plane, so it
  // never needs publicUrl / tunnel / tailscale exposure.
  if (config.provider === "msteams") {
    return {
      ok: true,
      configured: true,
      message:
        "Microsoft Teams uses the bridge WebSocket listener; no public webhook exposure needed",
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
