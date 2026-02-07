export function validateNasIncomingWebhookUrl(url: string | undefined): string | null {
  if (!url?.trim()) {
    return "NAS Incoming Webhook URL is required";
  }

  try {
    const parsed = new URL(url);

    // Basic validation
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "NAS Incoming Webhook URL must use HTTP or HTTPS";
    }

    if (!parsed.hostname) {
      return "NAS Incoming Webhook URL must have a hostname";
    }

    return null; // Validation passed
  } catch {
    return "Invalid URL format";
  }
}

// Keep original function for backward compatibility
export function validateWebhookUrl(url: string | undefined): string | null {
  return validateNasIncomingWebhookUrl(url);
}

// Validation when loading from configuration
export function loadAndValidateNasIncomingWebhookUrl(
  config: unknown,
  accountId: string,
): string | null {
  // Extract nasIncomingWebhookUrl (priority) or webhookUrl (backward compatibility) from config
  const synologyChatConfig =
    config && typeof config === "object" && config !== null && "channels" in config
      ? ((config as { channels?: Record<string, unknown> }).channels?.["synology-chat"] as
          | Record<string, unknown>
          | undefined)
      : undefined;

  let accountConfig: Record<string, unknown> | undefined;

  if (accountId === "default" || accountId === "main") {
    accountConfig = synologyChatConfig;
  } else {
    accountConfig =
      synologyChatConfig &&
      typeof synologyChatConfig === "object" &&
      "accounts" in synologyChatConfig
        ? (synologyChatConfig.accounts as Record<string, Record<string, unknown>>)?.[accountId]
        : undefined;
  }

  // Prefer nasIncomingWebhookUrl, fallback to webhookUrl
  const url = accountConfig?.nasIncomingWebhookUrl || accountConfig?.webhookUrl;

  const error = validateNasIncomingWebhookUrl(typeof url === "string" ? url : undefined);
  if (error) {
    console.error(`[Synology Chat] Invalid NAS incoming webhook URL: ${error}`);
    return null;
  }

  return typeof url === "string" ? url : null;
}

// Backward compatibility function
export function loadAndValidateWebhookUrl(config: unknown, accountId: string): string | null {
  return loadAndValidateNasIncomingWebhookUrl(config, accountId);
}
