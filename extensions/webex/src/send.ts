import { getWebexRuntime } from "./runtime.js";
import type { ResolvedWebexAccount } from "./types.js";

export interface WebexSendOptions {
  accountId?: string;
  markdown?: string;
  files?: string[];
}

export interface WebexSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export async function sendWebexMessage(
  target: string,
  text: string,
  options: WebexSendOptions = {},
): Promise<WebexSendResult> {
  const account = await resolveWebexAccount(options.accountId);

  if (!account || !account.token) {
    return {
      ok: false,
      error: "Webex token not configured",
    };
  }

  try {
    const payload: Record<string, unknown> = {
      text: text || "",
    };

    // Add markdown if provided
    if (options.markdown) {
      payload.markdown = options.markdown;
    }

    // Determine target type and set appropriate field
    if (target.includes("@")) {
      // Email address - direct message
      payload.toPersonEmail = target;
    } else if (target.startsWith("Y2lzY29zcGFyazovL3VzL1BFT1BMRS8")) {
      // Person ID - direct message
      payload.toPersonId = target;
    } else if (target.startsWith("Y2lzY29zcGFyazovL3VzL1JPT00v")) {
      // Room ID
      payload.roomId = target;
    } else {
      // Assume it's a room ID
      payload.roomId = target;
    }

    // Add files if provided
    if (options.files && options.files.length > 0) {
      payload.files = options.files;
    }

    const response = await fetch("https://webexapis.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        ok: false,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const result = await response.json();
    return {
      ok: true,
      messageId: result.id,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Helper to resolve account from config
async function resolveWebexAccount(
  accountId?: string,
): Promise<ResolvedWebexAccount | null> {
  const runtime = getWebexRuntime();
  const cfg = runtime.config.loadConfig();

  const webexConfig = (cfg as any).channels?.webex;
  if (!webexConfig) {
    return null;
  }

  const resolvedAccountId = accountId || "default";
  let token = "";
  let tokenSource: "config" | "file" | "env" | "none" = "none";

  // Try account-specific config first
  const accountConfig = webexConfig.accounts?.[resolvedAccountId];
  if (accountConfig) {
    if (accountConfig.botToken) {
      token = accountConfig.botToken;
      tokenSource = "config";
    } else if (accountConfig.tokenFile) {
      try {
        const fs = await import("node:fs/promises");
        token = (await fs.readFile(accountConfig.tokenFile, "utf-8")).trim();
        tokenSource = "file";
      } catch {
        // File read failed
      }
    }
  }

  // Fall back to main config if no account-specific token
  if (!token && resolvedAccountId === "default") {
    if (webexConfig.botToken) {
      token = webexConfig.botToken;
      tokenSource = "config";
    } else if (webexConfig.tokenFile) {
      try {
        const fs = await import("node:fs/promises");
        token = (await fs.readFile(webexConfig.tokenFile, "utf-8")).trim();
        tokenSource = "file";
      } catch {
        // File read failed
      }
    }
  }

  // Try environment variable for default account
  if (!token && resolvedAccountId === "default") {
    const envToken = process.env.WEBEX_BOT_TOKEN?.trim();
    if (envToken) {
      token = envToken;
      tokenSource = "env";
    }
  }

  return {
    accountId: resolvedAccountId,
    enabled: accountConfig?.enabled ?? webexConfig.enabled ?? false,
    token,
    tokenSource,
    config: accountConfig || webexConfig,
    name: accountConfig?.name || webexConfig.name,
  };
}
