/**
 * Config schema for the inbox-triage plugin.
 *
 * The plugin needs read access to Gmail (refresh-token OAuth) and a target
 * channel/target pair to deliver the morning brief to (typically a
 * WhatsApp self-DM).
 */

export type InboxTriageConfig = {
  gmail: {
    user: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
  deliver: {
    channel: string;
    target: string;
  };
  lookbackHours: number;
  draftReplies: boolean;
};

const DEFAULT_LOOKBACK_HOURS = 24;

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
    const envValue = process.env[envVar];
    if (envValue === undefined || envValue === "") {
      throw new Error(`inbox-triage: required env var ${envVar} is not set`);
    }
    return envValue;
  });
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`inbox-triage: ${label} is required`);
  }
  return value;
}

export const inboxTriageConfigSchema = {
  parse(value: unknown): InboxTriageConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("inbox-triage: config required");
    }
    const cfg = value as Record<string, unknown>;

    const gmail = cfg.gmail as Record<string, unknown> | undefined;
    if (!gmail) {
      throw new Error("inbox-triage: gmail config is required");
    }

    const deliver = cfg.deliver as Record<string, unknown> | undefined;
    if (!deliver) {
      throw new Error("inbox-triage: deliver config is required");
    }

    const lookbackHours =
      typeof cfg.lookbackHours === "number"
        ? Math.max(1, Math.min(168, Math.floor(cfg.lookbackHours)))
        : DEFAULT_LOOKBACK_HOURS;

    return {
      gmail: {
        user: resolveEnvVars(asString(gmail.user, "gmail.user")),
        clientId: resolveEnvVars(asString(gmail.clientId, "gmail.clientId")),
        clientSecret: resolveEnvVars(asString(gmail.clientSecret, "gmail.clientSecret")),
        refreshToken: resolveEnvVars(asString(gmail.refreshToken, "gmail.refreshToken")),
      },
      deliver: {
        channel: asString(deliver.channel, "deliver.channel"),
        target: asString(deliver.target, "deliver.target"),
      },
      lookbackHours,
      draftReplies: cfg.draftReplies !== false,
    };
  },
};
