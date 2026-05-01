export type VoiceCallWebhookExposureConfig = {
  provider?: string;
  publicUrl?: string;
  tunnel?: {
    provider?: string;
  };
  tailscale?: {
    mode?: string;
  };
};

export type VoiceCallWebhookExposureStatus = {
  ok: boolean;
  configured: boolean;
  message: string;
};

export function providerRequiresPublicWebhook(providerName: string | undefined): boolean {
  return providerName === "twilio" || providerName === "telnyx" || providerName === "plivo";
}

export function isLocalOnlyWebhookHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) {
    return false;
  }
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    host.startsWith("127.")
  ) {
    return true;
  }
  if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) {
    return true;
  }
  const private172 = /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  return private172 || host.startsWith("fc") || host.startsWith("fd");
}

export function isProviderUnreachableWebhookUrl(webhookUrl: string): boolean {
  try {
    const parsed = new URL(webhookUrl);
    return isLocalOnlyWebhookHost(parsed.hostname);
  } catch {
    return false;
  }
}

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
