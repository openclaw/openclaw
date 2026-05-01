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

function normalizeWebhookHostname(hostname: string): string {
  const host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

function isLocalOnlyIpv4Host(host: string): boolean {
  if (host === "0.0.0.0" || host.startsWith("127.")) {
    return true;
  }
  if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) {
    return true;
  }
  return /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function extractMappedIpv4Host(host: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  if (dotted) {
    return dotted[1];
  }

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!hex) {
    return undefined;
  }

  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

export function isLocalOnlyWebhookHost(hostname: string): boolean {
  const host = normalizeWebhookHostname(hostname);
  if (!host) {
    return false;
  }
  const mappedIpv4 = extractMappedIpv4Host(host);
  if (mappedIpv4) {
    return isLocalOnlyIpv4Host(mappedIpv4);
  }
  if (
    host === "localhost" ||
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  ) {
    return true;
  }
  return isLocalOnlyIpv4Host(host);
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
